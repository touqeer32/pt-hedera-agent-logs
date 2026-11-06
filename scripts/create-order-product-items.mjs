#!/usr/bin/env node

/**
 * Create PharmaTrace product items for already-generated order serials.
 * This script does not create lots, serial profiles, serials, or compliance reports.
 */

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
const MANUFACTURING_SITE_ID = process.env.MANUFACTURING_SITE_ID || "68917a40-5bb6-4ce8-a536-b8ce39fbf696";
const PACK_LEVEL = Number(process.env.PRODUCT_ITEM_PACK_LEVEL || 2);
const LIMIT = Number(process.env.PRODUCT_ITEM_BATCH_LIMIT || 0);
// Keep the downstream blockchain/indexer workload low. These are deliberately
// fixed defaults so rerunning the script does not require extra deployment env.
const ITEM_DELAY_MS = 10000;
const ITEM_MAX_ATTEMPTS = 4;

function clean(value) { return String(value ?? "").trim(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
  console.log(`Requesting a fresh Keycloak token for ${username} using client ${clientId}...`);
  const response = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Keycloak authentication failed (${response.status}): ${body.error_description || body.error || "no access token"}`);
  return body.access_token;
}

async function graphql(query, token) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, tenantid: TENANT_ID, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!response.ok || body.errors?.length) throw new Error(JSON.stringify({ status: response.status, errors: body.errors, body: body.raw }));
  return body.data;
}

function itemInput(group, link) {
  const serial = clean(link.serialNumber);
  const documentNumber = clean(link.documentNumber);
  const itemCode = clean(link.itemCode);
  const epcUrn = documentNumber || itemCode || serial;
  const epcUrnSource = documentNumber ? "documentNumber" : itemCode ? "itemCode" : "generatedSerial";
  const itemFields = JSON.stringify([
    { key: "orderId", value: clean(link.orderId) },
    { key: "documentNumber", value: clean(link.documentNumber) },
    { key: "itemCode", value: clean(link.itemCode) },
    { key: "epcUrnSource", value: epcUrnSource },
    { key: "itemName", value: clean(link.itemName) },
    { key: "pharmacyId", value: clean(link.pharmacyId) },
    { key: "siteId", value: clean(link.siteId) },
    { key: "batch", value: clean(group.batch) },
  ]);
  return {
    barcode: serial,
    batchLotId: group.lotId,
    lotNumber: group.batch,
    manufacturingSite: MANUFACTURING_SITE_ID,
    commissionedOn: String(Date.now()),
    disposition: null,
    dispositionOn: "0",
    // The EPC URN identifies the source order document. The generated value
    // is kept separately as the serialNumber and primary identifier.
    epcUrn,
    isExpired: false,
    itemFields,
    packLevel: PACK_LEVEL,
    parent: null,
    primaryIdentifier: serial,
    serialNumber: serial,
    location: clean(link.siteId || link.pharmacyId),
    top: null,
  };
}

function literalInput(input) {
  return `{${Object.entries(input).map(([key, value]) => `${key}:${value === null ? "null" : JSON.stringify(value)}`).join(",")}}`;
}

async function validateSerials(serials, token) {
  const values = serials.map((serial) => JSON.stringify(serial)).join(",");
  const result = await graphql(`mutation { validateProductItems(input:[${values}]) { numbers { number status } } }`, token);
  const numbers = result?.validateProductItems?.numbers || [];
  if (numbers.length !== serials.length) throw new Error(`Product-item validation returned ${numbers.length} result(s); expected ${serials.length}`);
  const invalid = numbers.filter((item) => clean(item.status).toUpperCase() !== "VALID");
  if (invalid.length) throw new Error(`Product-item serial validation failed: ${JSON.stringify(invalid)}`);
  return numbers;
}

async function createItem(input, token) {
  const result = await graphql(`mutation createProductItem { createProductItem(input:${literalInput(input)}) { barcode batchLotId lotNumber disposition epcUrn id isExpired itemFields packLevel parent primaryIdentifier serialNumber top commissionedOn dispositionOn location blockchainStatus createdOn } }`, token);
  const item = result?.createProductItem;
  if (!item?.id && !item?.barcode) throw new Error(`Product item response did not contain an item: ${JSON.stringify(item)}`);
  return item;
}

async function findItemBySerial(serial, token) {
  const result = await graphql(`query { getAllProductItem(page:{page:1,search:${JSON.stringify(serial)},size:20,sortBy:""}) { data { barcode batchLotId lotNumber disposition epcUrn id isExpired itemFields packLevel parent primaryIdentifier serialNumber top commissionedOn dispositionOn location blockchainStatus createdOn } } }`, token);
  const items = result?.getAllProductItem?.data || [];
  return items.find((item) => [item.barcode, item.primaryIdentifier, item.serialNumber].map(clean).includes(clean(serial))) || null;
}

async function createItemWithRetry(input, link, token, progress) {
  let lastError;
  for (let attempt = 1; attempt <= ITEM_MAX_ATTEMPTS; attempt += 1) {
    try {
      console.log(`${progress} -> create attempt ${attempt}/${ITEM_MAX_ATTEMPTS}`);
      const item = await createItem(input, token);
      // The API response is the authoritative result for this import script.
      // Do not claim that the UUID proves blockchain/indexer visibility.
      return { item, source: "API_RESPONSE_RECEIVED" };
    } catch (error) {
      lastError = error;
      // If the request timed out after the downstream API accepted it, recover
      // the API record by serial before attempting another create.
      try {
        const existing = await findItemBySerial(link.serialNumber, token);
        if (existing && clean(existing.blockchainStatus).toUpperCase() === "CONFIRMED") {
          console.log(`${progress} -> recovered existing API record ${existing.id} by serial`);
          return { item: existing, source: "RECOVERED_CONFIRMED_RECORD", skipped: true };
        }
        if (existing) {
          console.warn(`${progress} -> existing record is ${existing.blockchainStatus || "NOT_CHECKED"}; it is not confirmed, retrying push`);
        }
      } catch {
        // Continue with the bounded retry below.
      }
      if (attempt < ITEM_MAX_ATTEMPTS) {
        const waitMs = ITEM_DELAY_MS * attempt;
        console.warn(`${progress} -> attempt ${attempt} failed; retrying in ${waitMs}ms: ${error.message}`);
        await sleep(waitMs);
      }
    }
  }
  throw lastError || new Error("Product item creation failed");
}

async function persist(document) {
  document.results = Object.values(document.byBatch);
  document.updatedAt = new Date().toISOString();
  await writeFile(RESULT_PATH, `${JSON.stringify(document, null, 2)}\n`);
}

async function main() {
  if (!existsSync(RESULT_PATH)) throw new Error(`Import result file not found: ${RESULT_PATH}`);
  const document = JSON.parse(await readFile(RESULT_PATH, "utf8"));
  const allGroups = Object.values(document.byBatch || {}).filter((group) => group?.lotId && Array.isArray(group.orderLinks));
  const groups = allGroups.slice(0, LIMIT > 0 ? LIMIT : undefined);
  const token = await getToken();
  console.log(`Processing ${groups.length} existing lot group(s); no lots or profiles will be created.`);
  for (const [index, group] of groups.entries()) {
    const progress = `[${index + 1}/${groups.length}] batch=${group.batch}`;
    // Re-submit every eligible item. The JSON file is only an import
    // checkpoint; a saved UUID is not proof that this API call was completed
    // successfully on the current run or that blockchain indexing finished.
    const pending = group.orderLinks.filter((link) => link.serialNumber && clean(link.documentNumber || link.itemCode || link.serialNumber));
    const missingUrn = group.orderLinks.filter((link) => link.serialNumber && !link.productItem && !clean(link.documentNumber || link.itemCode || link.serialNumber));
    if (!pending.length) {
      const serialCount = group.orderLinks.filter((link) => link.serialNumber).length;
      const hasItems = group.orderLinks.some((link) => link.productItem);
      const noSerials = serialCount === 0;
      const status = missingUrn.length ? "PARTIAL" : noSerials ? "WAITING_FOR_SERIALS" : hasItems ? "SKIPPED_ALREADY_CREATED" : "NOT_READY";
      console.log(`${progress} -> ${missingUrn.length ? `SKIPPED_${missingUrn.length}_MISSING_IDENTIFIER` : noSerials ? "WAITING_FOR_SERIALS" : hasItems ? "SKIPPED_ALREADY_CREATED" : "NOT_READY"}`);
      if (missingUrn.length) {
        document.byBatch[group.batch] = {
          ...group,
          orderLinks: group.orderLinks.map((link) => missingUrn.includes(link) ? { ...link, productItemError: "Missing documentNumber, itemCode, and serialNumber; cannot build required epcUrn" } : link),
          productItemStatus: "PARTIAL",
          productItemError: `${missingUrn.length} order(s) are missing documentNumber, itemCode, and serialNumber`,
        };
      } else if (noSerials) {
        document.byBatch[group.batch] = {
          ...group,
          productItemStatus: status,
          productItemError: "No generated serial numbers are available; run generate:order-serials first",
        };
      }
      await persist(document);
      continue;
    }
    try {
      const created = [];
      const recovered = [];
      const failed = [];
      const skippedConfirmed = [];
      for (const link of pending) {
        const input = itemInput(group, link);
        const itemProgress = `${progress} order=${link.orderId} serial=${link.serialNumber}`;
        try {
          const existing = await findItemBySerial(link.serialNumber, token);
          const blockchainStatus = clean(existing?.blockchainStatus).toUpperCase() || "NOT_FOUND";
          if (existing && blockchainStatus === "CONFIRMED") {
            link.productItem = { input, response: existing };
            link.productItemApi = {
              status: "BLOCKCHAIN_CONFIRMED",
              source: "PERSISTED_BLOCKCHAIN_STATUS",
              checkedAt: new Date().toISOString(),
              recordId: existing.id || null,
              blockchainStatus: existing.blockchainStatus,
            };
            delete link.productItemError;
            skippedConfirmed.push(existing);
            console.log(`${itemProgress} -> SKIPPED_BLOCKCHAIN_CONFIRMED recordId=${existing.id || "none"}`);
            document.byBatch[group.batch] = {
              ...group,
              productItemStatus: "IN_PROGRESS",
            };
            await persist(document);
            await sleep(ITEM_DELAY_MS);
            continue;
          }
          console.log(`${itemProgress} -> blockchainStatus=${blockchainStatus}; submitting item`);
          const result = await createItemWithRetry(input, link, token, itemProgress);
          link.productItem = { input, response: result.item };
          link.productItemApi = {
            status: "RESPONSE_RECEIVED",
            source: result.source,
            receivedAt: new Date().toISOString(),
            recordId: result.item.id || null,
            blockchainStatus: result.item.blockchainStatus || "NOT_CHECKED",
          };
          delete link.productItemError;
          if (result.source.startsWith("RECOVERED_")) recovered.push(result.item);
          else created.push(result.item);
          console.log(`${itemProgress} -> API response received; recordId=${result.item.id || "none"}`);
        } catch (error) {
          failed.push(link);
          link.productItemApi = {
            status: "FAILED",
            failedAt: new Date().toISOString(),
            error: error.message,
          };
          console.error(`${itemProgress} -> API failed: ${error.message}`);
        }
        // Persist every response/failure before waiting for the next request.
        document.byBatch[group.batch] = {
          ...group,
          productItemStatus: "IN_PROGRESS",
        };
        await persist(document);
        await sleep(ITEM_DELAY_MS);
      }
      document.byBatch[group.batch] = {
        ...group,
        orderLinks: group.orderLinks.map((link) => missingUrn.includes(link) ? { ...link, productItemError: "Missing documentNumber, itemCode, and serialNumber; cannot build required epcUrn" } : link),
        productItemStatus: missingUrn.length || failed.length ? "PARTIAL" : "CREATED",
        productItemError: missingUrn.length ? `${missingUrn.length} order(s) are missing documentNumber, itemCode, and serialNumber` : undefined,
        productItemsCreated: created.length,
        productItemsRecovered: recovered.length,
        productItemsSkippedConfirmed: skippedConfirmed.length,
        productItemsFailed: failed.length,
        productItemsCreatedAt: new Date().toISOString(),
      };
      console.log(`${progress} -> API responses: created ${created.length}, recovered ${recovered.length}, failed ${failed.length}`);
    } catch (error) {
      document.byBatch[group.batch] = { ...group, productItemStatus: "FAILED", productItemError: error.message };
      console.error(`${progress} -> FAILED: ${error.message}`);
    }
    await persist(document);
  }
  await persist(document);
  const counts = document.results.reduce((all, item) => {
    const status = item.productItemStatus || "NOT_PROCESSED";
    all[status] = (all[status] || 0) + 1;
    return all;
  }, {});
  console.log(JSON.stringify({ resultPath: RESULT_PATH, groups: groups.length, counts }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
