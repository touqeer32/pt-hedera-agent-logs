#!/usr/bin/env node

/**
 * Import pharmacy orders as PharmaTrace batch lots and serial profiles.
 *
 * Default mode is DRY_RUN=true. No compliance reports are created here.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function loadDotenvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const scriptDirectory = dirname(new URL(import.meta.url).pathname);
loadDotenvFile(resolve(process.cwd(), ".env"));
loadDotenvFile(resolve(scriptDirectory, "../.env"));

const GRAPHQL_URL = process.env.PHARMATRACE_GRAPHQL_URL || "https://apigateway.k8s.pharmatrace.io/graphql";
const SERIAL_PROFILE_URL = process.env.SERIAL_PROFILE_CREATE_URL || "https://ser-snm.k8s.pharmatrace.io/createProfile";
const SERIAL_NUMBER_URL = process.env.SERIAL_NUMBER_GENERATION_API_URL || "https://ser-snm.k8s.pharmatrace.io/downloadSerialNumbers";
const SERIAL_TRANSACTION_GRAPHQL_URL = process.env.SERIAL_TRANSACTION_GRAPHQL_URL || "https://ser-transaction.k8s.pharmatrace.io/graphql";
const SERIAL_SENDING_SYSTEM = process.env.SERIAL_PROFILE_SENDING_SYSTEM || "388e3401-8cbd-42b4-8d9e-a196fc8e5cc6";
const SERIAL_RECEIVING_SYSTEM = process.env.SERIAL_PROFILE_RECEIVING_SYSTEM || SERIAL_SENDING_SYSTEM;
const SERIAL_COMPANY_NAME = process.env.SERIAL_COMPANY_NAME || "pharmatrace";
const SERIAL_TRANSACTION_USER_ID = process.env.SERIAL_TRANSACTION_USER_ID || process.env.KEYCLOAK_USER_ID || "4b63cc2a-1add-4354-bf01-91c89bcfe636";
const CSV_PATH = resolve(process.env.PHARMACY_ORDERS_CSV || "data/itf_pharmacy_orders_202610221330.csv");
const RESULT_PATH = resolve(process.env.PHARMACY_ORDERS_RESULT || "data/pharmacy-order-import-results.json");
const TENANT_ID = process.env.PHARMATRACE_TENANT_ID || "f6b27eb5-5d5a-4f84-8016-45e2e1193aa1";
const PRODUCT_ID = process.env.PRODUCT_ID || "95ba0a20-dec3-48cb-8b48-2955b15be97a";
const MANUFACTURING_SITE_ID = process.env.MANUFACTURING_SITE_ID || "68917a40-5bb6-4ce8-a536-b8ce39fbf696";
const DRY_RUN = process.env.DRY_RUN !== "false";
const LIMIT = Number(process.env.ORDER_IMPORT_LIMIT || 0);
const RESET_IMPORT = process.env.RESET_ORDER_IMPORT === "true";

function clean(value) {
  return String(value ?? "").trim();
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function dateOnly(value) {
  const match = clean(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || "";
}

function epochMillis(date) {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid order date: ${date}`);
  return String(parsed);
}

function oneYearLater(date) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Invalid order date: ${date}`);
  parsed.setUTCFullYear(parsed.getUTCFullYear() + 1);
  return String(parsed.valueOf());
}

function isoWeekKey(value) {
  const date = new Date(`${dateOnly(value)}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return "";
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function groupOrders(rows) {
  const groups = new Map();
  for (const row of rows) {
    const sourceBatch = clean(row.batch);
    if (!sourceBatch) continue;
    const weekKey = isoWeekKey(row.order_date);
    if (!weekKey) continue;
    const batch = `${sourceBatch}-W${weekKey}`;
    const itemCode = clean(row.item_code);
    const productId = process.env.PRODUCT_ID_BY_ITEM_CODE
      ? JSON.parse(process.env.PRODUCT_ID_BY_ITEM_CODE)[itemCode]
      : PRODUCT_ID;
    if (!productId) throw new Error(`No product ID configured for item_code ${itemCode}`);
    const key = `${sourceBatch}\0${productId}\0${weekKey}`;
    if (!groups.has(key)) groups.set(key, {
      batch,
      sourceBatch,
      weekKey,
      productId,
      itemCode,
      itemName: clean(row.item_name),
      rows: [],
    });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

async function getToken() {
  const username = process.env.KEYCLOAK_USERNAME || process.env.PHARMATRACE_USERNAME;
  const password = process.env.KEYCLOAK_PASSWORD || process.env.PHARMATRACE_PASSWORD;
  if (!username || !password) {
    if (process.env.GRAPHQL_TOKEN) return process.env.GRAPHQL_TOKEN;
    throw new Error("Set KEYCLOAK_USERNAME and KEYCLOAK_PASSWORD, or GRAPHQL_TOKEN");
  }
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL ||
    "https://kc.k8s.pharmatrace.io/auth/realms/first-bucket/protocol/openid-connect/token";
  const clientId = process.env.KEYCLOAK_CLIENT_ID || "app";
  const form = new URLSearchParams({
    grant_type: process.env.KEYCLOAK_GRANT_TYPE || "password",
    client_id: clientId,
    username,
    password,
  });
  if (clientId !== "app" && process.env.KEYCLOAK_CLIENT_SECRET) form.set("client_secret", process.env.KEYCLOAK_CLIENT_SECRET);
  console.log(`Requesting a fresh Keycloak token for ${username} using client ${clientId}...`);
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Keycloak authentication failed (${response.status}): ${body.error_description || body.error || "no access token"}`);
  return body.access_token;
}

async function graphql(query, variables, token, url = GRAPHQL_URL) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      tenantid: TENANT_ID,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!response.ok || body.errors?.length) throw new Error(JSON.stringify({ status: response.status, errors: body.errors, body: body.raw }));
  return body.data;
}

async function loadPharmacySiteIds(token) {
  const siteIds = new Map();
  let page = 1;
  let totalPages = 1;
  do {
    const query = `{ getByCompanyType(page: { size: 10, page: ${page}, search: "" }, companyType: SITE) { data { id name jsonData metaData } page { totalPages } } }`;
    const result = (await graphql(query, {}, token))?.getByCompanyType;
    for (const site of result?.data || []) {
      const keys = [site.name];
      try {
        const json = typeof site.jsonData === "string" ? JSON.parse(site.jsonData) : site.jsonData;
        if (json?.university_id) keys.push(json.university_id);
        if (json?.pharmacyRecord?.pharmacyRecordId) keys.push(json.pharmacyRecord.pharmacyRecordId);
        if (json?.pharmacy_code) keys.push(json.pharmacy_code);
      } catch { /* retain name-only mapping */ }
      for (const key of keys.filter(Boolean)) siteIds.set(String(key).trim().toLowerCase(), site.id);
    }
    totalPages = Number(result?.page?.totalPages || page);
    page += 1;
  } while (page <= totalPages);
  console.log(`Loaded ${siteIds.size} pharmacy-site lookup key(s).`);
  return siteIds;
}

function batchData(group, siteIds) {
  const pharmacySiteLinks = [...new Map(group.rows
    .map((row) => {
      const pharmacyId = clean(row.pharmacy_id);
      return [pharmacyId, {
        pharmacyId,
        siteId: siteIds.get(pharmacyId.toLowerCase()) || null,
        orderCount: 0,
      }];
    })
    .filter(([pharmacyId]) => Boolean(pharmacyId)))
    .values()];
  for (const link of pharmacySiteLinks) {
    link.orderCount = group.rows.filter((row) => clean(row.pharmacy_id) === link.pharmacyId).length;
  }
  const pharmacySiteIds = pharmacySiteLinks.map((link) => link.siteId).filter(Boolean);
  const unresolvedPharmacyIds = [...new Set(group.rows.map((row) => clean(row.pharmacy_id)).filter((id) => id && !siteIds.has(id.toLowerCase())))];
  const oldestOrderDate = group.rows.map((row) => dateOnly(row.order_date)).filter(Boolean).sort()[0];
  return {
    oldestOrderDate,
    orderCount: group.rows.length,
    batch: group.batch,
    sourceBatch: group.sourceBatch,
    weekKey: group.weekKey,
    productId: group.productId,
    itemCode: group.itemCode,
    itemName: group.itemName,
    pharmacySiteLinks,
    pharmacySiteIds,
    unresolvedPharmacyIds,
    orderIds: group.rows.map((row) => clean(row.order_id)).filter(Boolean),
  };
}

function orderLinks(group, data, lotId) {
  const siteByPharmacy = new Map(data.pharmacySiteLinks.map((link) => [link.pharmacyId, link.siteId]));
  return group.rows.map((row, index) => ({
    orderId: clean(row.order_id),
    pharmacyId: clean(row.pharmacy_id),
    siteId: siteByPharmacy.get(clean(row.pharmacy_id)) || null,
    batch: group.batch,
    lotId: lotId || null,
    productId: group.productId,
    itemCode: clean(row.item_code),
    itemName: clean(row.item_name),
    unit: clean(row.unit),
    documentNumber: clean(row.document_number),
    serialNumber: null,
  }));
}

async function createBatchLot(group, data, token) {
  const input = {
    lotNumber: group.batch,
    // Keep this field compact. The product subgraph validates the batch-lot
    // metadata shape/size; the complete pharmacy-site relationship remains
    // in the import result file and is not sent as a nested JSON value here.
    batchLotData: JSON.stringify([
      { key: "source", value: "itf_pharmacy_orders_202610221330.csv" },
      { key: "sourceBatch", value: data.sourceBatch },
      { key: "week", value: data.weekKey },
      { key: "orderCount", value: String(data.orderCount) },
      { key: "oldestOrderDate", value: data.oldestOrderDate },
    ]),
    productId: group.productId,
    expirationDate: oneYearLater(data.oldestOrderDate),
    processedTime: epochMillis(data.oldestOrderDate),
    processedZoneId: null,
    manufacturingSite: MANUFACTURING_SITE_ID,
  };
  const literal = `{${Object.entries(input).map(([key, value]) => `${key}:${value === null ? "null" : JSON.stringify(value)}`).join(",")}}`;
  const query = `mutation BatchLot { createBatchLot(input:${literal}) { status message data { lotId lotNumber productId manufacturingSite status createdAt } } }`;
  const response = await graphql(query, {}, token);
  return response?.createBatchLot?.data || response?.createBatchLot;
}

async function createSerialProfile(group, data, token) {
  const response = await fetch(SERIAL_PROFILE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      tenantid: TENANT_ID,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      name: group.batch,
      identifier: group.batch,
      product: group.productId,
      frontPrepandData: "",
      prepandData: "",
      appendData: "",
      maxRequestSize: 1000,
      padLength: 1,
      padCharacter: "",
      format: "Numeric",
      lowerCaseAlphabet: false,
      excludeLowerAlph: "",
      upperCaseAlphabet: false,
      excludeUpperAlph: "",
      numericValues: false,
      excludeNumericValues: "",
      specialCase: false,
      includeSpecialCase: "!%&()*+,-./\\\"':;<>=?",
      active: true,
      remainingNumbers: 0,
      excludeNumberCount: 0,
      serialNumberLength: 12,
      remarks: JSON.stringify({ source: "itf_pharmacy_orders_202610221330.csv", orderCount: data.orderCount, oldestOrderDate: data.oldestOrderDate }),
      profileMetadata: JSON.stringify([{ key: "batch", value: group.batch }, { key: "itemCode", value: group.itemCode }]),
      minimumValue: null,
    }),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, body }));
  return body;
}

function profileIdFromResponse(profile) {
  return profile?.id || profile?.profileId || profile?.response?.id || profile?.data?.id || profile?.data?.response?.id || null;
}

function serialNumbersFromResponse(body) {
  return body?.randomizedNumberList?.serialNo || body?.data?.randomizedNumberList?.serialNo || body?.response?.randomizedNumberList?.serialNo || [];
}

async function generateSerialNumbers(group, data, token, profileId) {
  const request = {
    id: "",
    sendingSystem: SERIAL_SENDING_SYSTEM,
    receivingSystem: SERIAL_RECEIVING_SYSTEM,
    actionCode: "C",
    idType: "GTIN",
    encodingType: null,
    objectKey: { name: "GTIN", value: group.batch },
    size: String(data.orderCount),
  };
  console.log(`${group.batch} -> generating ${data.orderCount} serial number(s) for profile ${profileId}`);
  const response = await fetch(SERIAL_NUMBER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      tenantid: TENANT_ID,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!response.ok) throw new Error(`Serial generation failed (${response.status}): ${JSON.stringify(body)}`);
  const serialNumbers = serialNumbersFromResponse(body);
  if (serialNumbers.length !== data.orderCount) {
    throw new Error(`Serial generation returned ${serialNumbers.length} number(s); expected ${data.orderCount}`);
  }
  return { profileId, request, response: body, serialNumbers };
}

async function commissionSerialNumbers(serialNumbers, profileId, token) {
  const escapedNumbers = serialNumbers.map((number) => JSON.stringify(number)).join(",");
  const query = `mutation { commissionNumbers(input:{encodeType:"GTIN",companyName:${JSON.stringify(SERIAL_COMPANY_NAME)},profileId:${JSON.stringify(profileId)},userId:${JSON.stringify(SERIAL_TRANSACTION_USER_ID)},serialNumbers:[${escapedNumbers}]}) { status message response { transactionId commissionStatus numbers { number status } } } }`;
  const result = await graphql(query, {}, token, SERIAL_TRANSACTION_GRAPHQL_URL);
  const commission = result?.commissionNumbers;
  const transactionId = commission?.response?.transactionId;
  if (!transactionId) throw new Error(`Serial commission did not return a transaction ID: ${JSON.stringify(commission)}`);
  return commission;
}

async function approveCommission(transactionId, token) {
  const query = `mutation { approveTransaction(id:${JSON.stringify(transactionId)}) { status message response { userId transactionId commissionStatus } } }`;
  const result = await graphql(query, {}, token, SERIAL_TRANSACTION_GRAPHQL_URL);
  const approval = result?.approveTransaction;
  if (!approval?.response?.transactionId) throw new Error(`Serial commission approval did not return a transaction ID: ${JSON.stringify(approval)}`);
  return approval;
}

async function main() {
  const rows = parseCsv(await readFile(CSV_PATH, "utf8"));
  const groups = groupOrders(rows).slice(0, LIMIT > 0 ? LIMIT : undefined);
  const token = await getToken();
  const siteIds = await loadPharmacySiteIds(token);
  let previous = {};
  if (!RESET_IMPORT && existsSync(RESULT_PATH)) {
    try { previous = JSON.parse(await readFile(RESULT_PATH, "utf8")).byBatch || {}; } catch { /* start fresh */ }
  }
  const results = [];
  console.log(`${DRY_RUN ? "Previewing" : "Creating"} ${groups.length} weekly batch group(s) from ${rows.length} order row(s)...`);
  for (const [index, group] of groups.entries()) {
    const data = batchData(group, siteIds);
    const progress = `[${index + 1}/${groups.length}] batch=${group.batch}`;
    if (!data.oldestOrderDate) {
      console.log(`${progress} -> SKIPPED_NO_ORDER_DATE`);
      results.push({ batch: group.batch, status: "SKIPPED_NO_ORDER_DATE" });
      continue;
    }
    if (previous[group.batch]?.status === "CREATED") {
      console.log(`${progress} -> SKIPPED_ALREADY_IMPORTED`);
      results.push({ ...previous[group.batch], status: "SKIPPED_ALREADY_IMPORTED" });
      continue;
    }
    if (DRY_RUN) {
      console.log(`${progress} -> DRY_RUN orders=${data.orderCount} pharmacies=${data.pharmacySiteIds.length} unresolved=${data.unresolvedPharmacyIds.length}`);
      results.push({ batch: group.batch, productId: group.productId, data, orderLinks: orderLinks(group, data), status: "DRY_RUN" });
      continue;
    }
    let lot = previous[group.batch]?.lot;
    let profile = previous[group.batch]?.profile;
    let generation = previous[group.batch]?.generation;
    let commission = previous[group.batch]?.commission;
    let approval = previous[group.batch]?.approval;
    let serialNumbers = previous[group.batch]?.serialNumbers || [];
    try {
      if (previous[group.batch]?.lotId) {
        console.log(`${progress} -> reusing previously created batch lot ${previous[group.batch].lotId}`);
      } else {
        console.log(`${progress} -> creating batch lot...`);
        lot = await createBatchLot(group, data, token);
        console.log(`${progress} -> batch lot created ${lot?.lotId || lot?.id || "unknown"}`);
      }
      if (profile) {
        console.log(`${progress} -> reusing previously created serial profile ${profileIdFromResponse(profile) || "unknown"}`);
      } else {
        console.log(`${progress} -> creating serial profile...`);
        profile = await createSerialProfile(group, data, token);
        console.log(`${progress} -> serial profile created ${profileIdFromResponse(profile) || "unknown"}`);
      }
      const profileId = profileIdFromResponse(profile);
      if (!profileId) throw new Error(`Serial profile response did not contain a profile ID: ${JSON.stringify(profile)}`);
      if (serialNumbers.length !== data.orderCount) {
        generation = await generateSerialNumbers(group, data, token, profileId);
        serialNumbers = generation.serialNumbers;
        console.log(`${progress} -> generated ${serialNumbers.length} serial number(s)`);
      } else {
        console.log(`${progress} -> reusing ${serialNumbers.length} previously generated serial number(s)`);
      }
      if (!commission?.response?.transactionId) {
        console.log(`${progress} -> commissioning ${serialNumbers.length} serial number(s)...`);
        commission = await commissionSerialNumbers(serialNumbers, profileId, token);
        console.log(`${progress} -> commission transaction ${commission.response.transactionId} (${commission.response.commissionStatus})`);
      } else {
        console.log(`${progress} -> reusing commission transaction ${commission.response.transactionId}`);
      }
      if (!approval?.response?.transactionId) {
        console.log(`${progress} -> approving commission transaction...`);
        approval = await approveCommission(commission.response.transactionId, token);
        console.log(`${progress} -> commission approved (${approval.response.commissionStatus})`);
      } else {
        console.log(`${progress} -> reusing approval transaction ${approval.response.transactionId}`);
      }
      results.push({
        batch: group.batch,
        productId: group.productId,
        lotId: lot?.lotId,
        lot,
        profile,
        generation,
        serialNumbers,
        commission,
        approval,
        data,
        orderLinks: orderLinks(group, data, lot?.lotId).map((link, orderIndex) => ({ ...link, serialNumber: serialNumbers[orderIndex] || null })),
        status: "CREATED",
      });
    } catch (error) {
      console.error(`${progress} -> FAILED: ${error.message}`);
      results.push({
        batch: group.batch,
        productId: group.productId,
        lotId: lot?.lotId,
        lot,
        profile,
        generation,
        serialNumbers,
        commission,
        approval,
        data,
        orderLinks: orderLinks(group, data, lot?.lotId).map((link, orderIndex) => ({ ...link, serialNumber: serialNumbers[orderIndex] || null })),
        status: "FAILED",
        error: error.message,
      });
    }
  }
  const byBatch = Object.fromEntries(results.map((item) => [item.batch, item]));
  await writeFile(RESULT_PATH, `${JSON.stringify({ csvPath: CSV_PATH, dryRun: DRY_RUN, createdAt: new Date().toISOString(), byBatch, results }, null, 2)}\n`);
  const counts = results.reduce((all, item) => ({ ...all, [item.status]: (all[item.status] || 0) + 1 }), {});
  console.log(JSON.stringify({ csvPath: CSV_PATH, resultPath: RESULT_PATH, sourceRows: rows.length, batchGroups: groups.length, counts }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
