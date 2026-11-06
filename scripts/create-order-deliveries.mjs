#!/usr/bin/env node

/** Create one PharmaTrace delivery per pharmacy for existing order serials. */

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function loadDotenvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

const scriptDirectory = dirname(new URL(import.meta.url).pathname);
loadDotenvFile(resolve(process.cwd(), ".env"));
loadDotenvFile(resolve(scriptDirectory, "../.env"));

const RESULT_PATH = resolve(process.env.PHARMACY_ORDERS_RESULT || "data/pharmacy-order-import-results.json");
const GRAPHQL_URL = process.env.PHARMATRACE_GRAPHQL_URL || "https://apigateway.k8s.pharmatrace.io/graphql";
const TENANT_ID = process.env.PHARMATRACE_TENANT_ID || "f6b27eb5-5d5a-4f84-8016-45e2e1193aa1";
const FROM_BUSINESS = process.env.DELIVERY_FROM_BUSINESS || "2895b23e-c4c7-4e32-8ee9-3a280818a939";
const FROM_LOCATION = process.env.DELIVERY_SHIP_FROM_LOCATION || "7f0ff33f-8a7d-496f-83b9-08adf373d50d";
const SHIP_FROM_COUNTRY = process.env.DELIVERY_SHIP_FROM_COUNTRY || "Germany";
const SHIP_TO_COUNTRY = process.env.DELIVERY_SHIP_TO_COUNTRY || "Austria";
const SALE_TYPE = process.env.DELIVERY_SALE_TYPE || "Sale - In Country";
const LIMIT = Number(process.env.DELIVERY_BATCH_LIMIT || 0);
const ORDERS_CSV_PATH = resolve(process.env.PHARMACY_ORDERS_CSV || "data/itf_pharmacy_orders_202610221330.csv");
// Create one delivery request at a time and leave approval/synchronization to
// the backend. The one-second delay prevents a burst against the downstream
// service without adding an approval call from this importer.
const DELIVERY_DELAY_MS = Math.max(Number(process.env.DELIVERY_DELAY_MS || 1000), 0);
const RECREATE_FAILED = process.env.DELIVERY_RECREATE_FAILED === "true";
const RETRY_TAG = `R${Date.now()}`;

const clean = (value) => String(value ?? "").trim();
const json = (value) => JSON.stringify(value);
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function persist(document) {
  await writeFile(RESULT_PATH, `${JSON.stringify({
    ...document,
    updatedAt: new Date().toISOString(),
    results: Object.values(document.byBatch),
  }, null, 2)}\n`);
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { values.push(value); value = ""; }
    else value += character;
  }
  values.push(value);
  return values;
}

function loadOrderCountries() {
  if (!existsSync(ORDERS_CSV_PATH)) return new Map();
  const lines = readFileSync(ORDERS_CSV_PATH, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return new Map();
  const headers = parseCsvLine(lines[0]);
  const countries = new Map();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
    if (clean(row.order_id)) countries.set(clean(row.order_id), clean(row.country));
  }
  return countries;
}

async function getToken() {
  const username = process.env.KEYCLOAK_USERNAME || process.env.PHARMATRACE_USERNAME;
  const password = process.env.KEYCLOAK_PASSWORD || process.env.PHARMATRACE_PASSWORD;
  if (!username || !password) {
    if (process.env.GRAPHQL_TOKEN) return process.env.GRAPHQL_TOKEN;
    throw new Error("Set KEYCLOAK_USERNAME and KEYCLOAK_PASSWORD, or GRAPHQL_TOKEN");
  }
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL || "https://kc.k8s.pharmatrace.io/auth/realms/first-bucket/protocol/openid-connect/token";
  const clientId = process.env.KEYCLOAK_CLIENT_ID || "app";
  const form = new URLSearchParams({ grant_type: process.env.KEYCLOAK_GRANT_TYPE || "password", client_id: clientId, username, password });
  if (clientId !== "app" && process.env.KEYCLOAK_CLIENT_SECRET) form.set("client_secret", process.env.KEYCLOAK_CLIENT_SECRET);
  console.log(`Requesting a fresh Keycloak token for ${username} using client ${clientId} at ${tokenUrl}...`);
  let response;
  try {
    response = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.message || "unknown network error";
    throw new Error(`Keycloak token request could not connect to ${tokenUrl}: ${cause}`);
  }
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Keycloak authentication failed (${response.status}): ${body.error_description || body.error || "no access token"}`);
  console.log("Keycloak token acquired successfully.");
  return body.access_token;
}

async function graphql(query, token) {
  let response;
  try {
    response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, tenantid: TENANT_ID, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.message || "unknown network error";
    throw new Error(`PharmaTrace GraphQL request could not connect to ${GRAPHQL_URL}: ${cause}`);
  }
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!response.ok || body.errors?.length) throw new Error(JSON.stringify({ status: response.status, errors: body.errors, body: body.raw }));
  return body.data;
}

async function findProductItemBySerial(serial, token) {
  const query = `query getAllProductItem { getAllProductItem(page:{page:1,search:${json(serial)},size:20,sortBy:""}) { data { barcode batchLotId lotNumber disposition epcUrn id isExpired itemFields packLevel parent primaryIdentifier serialNumber blockchainStatus top commissionedOn dispositionOn location isActive createdOn } page { currentPage currentSearch currentSortBy currentSortWith size totalElements totalPages } } }`;
  const result = await graphql(query, token);
  const items = result?.getAllProductItem?.data || [];
  return items.find((item) => [item.serialNumber, item.barcode, item.primaryIdentifier].map(clean).includes(clean(serial))) || null;
}

async function groupByPharmacy(group, orderCountries, token, itemCache) {
  const map = new Map();
  for (const link of group.orderLinks || []) {
    const pharmacyId = clean(link.pharmacyId);
    // A serial/profile record is not enough. The delivery chaincode expects the
    // product item to exist first, otherwise it returns Record Not Found.
    if (!pharmacyId || !clean(link.serialNumber) || !clean(link.documentNumber)) continue;
    const serial = clean(link.serialNumber);
    let productItem = itemCache.get(serial);
    if (!itemCache.has(serial)) {
      productItem = await findProductItemBySerial(serial, token);
      itemCache.set(serial, productItem || null);
    }
    if (!productItem) {
      console.warn(`[${group.batch}] order=${link.orderId} serial=${serial} -> SKIPPED_ITEM_NOT_FOUND`);
      continue;
    }
    // The API lookup is authoritative for delivery eligibility; a UUID saved
    // in the local JSON file is not enough. Preserve the current persisted
    // blockchain status for diagnostics in the delivery result.
    link.productItem = { ...(link.productItem || {}), response: productItem };
    link.productItemBlockchainStatus = productItem.blockchainStatus || "NOT_CHECKED";
    const country = clean(link.country || orderCountries.get(clean(link.orderId)) || process.env.DELIVERY_SHIP_TO_COUNTRY || "Austria");
    const key = `${pharmacyId}\0${country}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ ...link, country });
  }
  return map;
}

function deliveryInput(group, pharmacyId, country, links, deliveryIndex, retry = false) {
  const firstDocument = clean(links[0].documentNumber);
  const siteId = clean(links[0].siteId || pharmacyId);
  const deliveryNumber = `${group.batch}-P${String(deliveryIndex + 1).padStart(3, "0")}${retry ? `-${RETRY_TAG}` : ""}`;
  const transactionDetails = links.map((link) => ({
    identifierType: "Invoice Number",
    identifierValue: clean(link.documentNumber),
    documentDate: group.data?.oldestOrderDate || new Date().toISOString().slice(0, 10),
  }));
  const orderItemInformation = links.map((link) => ({
    packageLevel: "",
    packageCode: clean(link.documentNumber),
    quantity: clean(link.unit),
  }));
  return {
    lotIds: group.lotId,
    deliveryNumber,
    saleType: SALE_TYPE,
    shipmentDate: group.data?.oldestOrderDate || "",
    correctingVoidDelivery: false,
    voidDeliveryNumber: "",
    shipFromCountry: SHIP_FROM_COUNTRY,
    shipToCountry: country,
    fromBusiness: FROM_BUSINESS,
    toBusiness: pharmacyId,
    shipFromLocation: FROM_LOCATION,
    shipToLocation: siteId,
    exitPort: process.env.DELIVERY_EXIT_PORT || "germany",
    carrierName: JSON.stringify([{ name: null }]),
    transactionDetails: JSON.stringify(transactionDetails),
    orderItemInformation: JSON.stringify(orderItemInformation),
    contractType: process.env.DELIVERY_CONTRACT_TYPE || "Agency Sales Agreement",
    contractNumber: firstDocument,
    supplyType: process.env.DELIVERY_SUPPLY_TYPE || "Patient Distribution",
    fundingSource: process.env.DELIVERY_FUNDING_SOURCE || "Own Funds",
    removalCirculationReason: "",
    productSerialNumbers: JSON.stringify(links.map((link) => clean(link.serialNumber))),
    status: "PENDING",
  };
}

function literalInput(input) {
  return `{${Object.entries(input).map(([key, value]) => `${key}:${value === null ? "null" : json(value)}`).join(",")}}`;
}

async function createDelivery(input, token) {
  const query = `mutation { createDelivery(input:${literalInput(input)}) { status message response { id deliveryNumber saleType shipmentDate correctingVoidDelivery voidDeliveryNumber shipFromCountry shipToCountry fromBusiness toBusiness shipFromLocation shipToLocation exitPort carrierName contractType contractNumber supplyType fundingSource removalCirculationReason productSerialNumbers } } }`;
  const result = await graphql(query, token);
  const delivery = result?.createDelivery;
  if (!delivery?.response) throw new Error(`Delivery response did not contain a response: ${JSON.stringify(delivery)}`);
  return delivery;
}

async function main() {
  if (!existsSync(RESULT_PATH)) throw new Error(`Import result file not found: ${RESULT_PATH}`);
  const document = JSON.parse(await readFile(RESULT_PATH, "utf8"));
  const orderCountries = loadOrderCountries();
  const allGroups = Object.values(document.byBatch || {}).filter((group) => group?.lotId && Array.isArray(group.orderLinks));
  const groups = allGroups.slice(0, LIMIT > 0 ? LIMIT : undefined);
  const token = await getToken();
  const itemCache = new Map();
  console.log(`Processing ${groups.length} existing lot group(s); no lots, profiles, serials, or items will be created.`);
  for (const [index, group] of groups.entries()) {
    const progress = `[${index + 1}/${groups.length}] batch=${group.batch}`;
    const existing = group.deliveryRecords || [];
    const failedAttempts = existing.filter((record) => ["FAILED", "APPROVAL_FAILED"].includes(record.status));
    const activeExisting = RECREATE_FAILED
      ? existing.filter((record) => !["FAILED", "APPROVAL_FAILED"].includes(record.status))
      : existing;
    const deliveries = [...(await groupByPharmacy(group, orderCountries, token, itemCache)).entries()];
    if (!deliveries.length) {
      console.log(`${progress} -> SKIPPED_NO_CREATED_PRODUCT_ITEMS`);
      continue;
    }
    const created = [...activeExisting];
    for (const [deliveryIndex, [deliveryKey, links]] of deliveries.entries()) {
      const pharmacyId = clean(links[0].pharmacyId);
      const country = clean(links[0].country || process.env.DELIVERY_SHIP_TO_COUNTRY || "Austria");
      const key = `${group.batch}:${pharmacyId}:${country}`;
      const localRecord = created.find((record) => record.key === key);
      const localRequestCompleted = localRecord && ["CREATED_PENDING", "EXISTS_IN_API", "BLOCKCHAIN_CONFIRMED"].includes(localRecord.status);
      const shouldRetryExisting = Boolean(RECREATE_FAILED && failedAttempts.some((record) => record.key === key));
      if (localRequestCompleted && !shouldRetryExisting) {
        console.log(`${progress} -> pharmacy=${pharmacyId} SKIPPED_ALREADY_REQUESTED delivery=${localRecord.response?.map((record) => record.id).join(",") || "unknown"}`);
        continue;
      }
      try {
        const shouldRetryWithNewNumber = shouldRetryExisting;
        const input = deliveryInput(group, pharmacyId, country, links, deliveryIndex, shouldRetryWithNewNumber);
        console.log(`${progress} -> pharmacy=${pharmacyId} country=${country} creating delivery for ${links.length} order(s)...`);
        const response = await createDelivery(input, token);
        const deliveryResponse = Array.isArray(response.response) ? response.response : [response.response];
        const oldRecordIndex = created.findIndex((record) => record.key === key);
        if (oldRecordIndex >= 0) created.splice(oldRecordIndex, 1);
        const record = { key, pharmacyId, siteId: clean(links[0].siteId || pharmacyId), country, orderIds: links.map((link) => link.orderId), documentNumbers: links.map((link) => link.documentNumber), serialNumbers: links.map((link) => link.serialNumber), input, response: deliveryResponse, approvals: [], status: "CREATED_PENDING" };
        // Persist immediately after creation. If approval or the process fails,
        // the next run resumes this delivery instead of creating a duplicate.
        created.push(record);
        document.byBatch[group.batch] = { ...group, deliveryRecords: created, deliveryHistory: [...(group.deliveryHistory || []), ...failedAttempts], deliveryStatus: "PROCESSED", deliveryProcessedAt: new Date().toISOString() };
        await persist(document);
        record.approvals = [];
        record.status = "CREATED_PENDING";
        console.log(`${progress} -> pharmacy=${pharmacyId} country=${country} created ${deliveryResponse.map((item) => item.id).join(",")} (approval deferred)`);
      } catch (error) {
        const existingRecord = created.find((record) => record.key === key);
        if (existingRecord) {
          existingRecord.status = "FAILED";
          existingRecord.error = error.message;
        } else {
          created.push({ key, pharmacyId, orderIds: links.map((link) => link.orderId), serialNumbers: links.map((link) => link.serialNumber), status: "FAILED", error: error.message });
        }
        console.error(`${progress} -> pharmacy=${pharmacyId} country=${country} FAILED: ${error.message}`);
      }
      if (DELIVERY_DELAY_MS) {
        console.log(`${progress} -> waiting ${DELIVERY_DELAY_MS}ms before next delivery...`);
        await sleep(DELIVERY_DELAY_MS);
      }
      document.byBatch[group.batch] = { ...group, deliveryRecords: created, deliveryHistory: [...(group.deliveryHistory || []), ...failedAttempts], deliveryStatus: "PROCESSED", deliveryProcessedAt: new Date().toISOString() };
      await persist(document);
    }
  }
  document.results = Object.values(document.byBatch);
  document.updatedAt = new Date().toISOString();
  await writeFile(RESULT_PATH, `${JSON.stringify(document, null, 2)}\n`);
  const records = document.results.flatMap((group) => group.deliveryRecords || []);
  console.log(JSON.stringify({ resultPath: RESULT_PATH, groups: groups.length, deliveries: records.length, created: records.filter((item) => item.response).length, failed: records.filter((item) => item.status === "FAILED").length }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
