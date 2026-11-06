#!/usr/bin/env node

/**
 * Generate, commission, and approve serials for already-created order lots/profiles.
 * This script never creates batch lots, serial profiles, or compliance reports.
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
const TENANT_ID = process.env.PHARMATRACE_TENANT_ID || "f6b27eb5-5d5a-4f84-8016-45e2e1193aa1";
const SERIAL_NUMBER_URL = process.env.SERIAL_NUMBER_GENERATION_API_URL || "https://ser-snm.k8s.pharmatrace.io/downloadSerialNumbers";
const TRANSACTION_GRAPHQL_URL = process.env.SERIAL_TRANSACTION_GRAPHQL_URL || "https://ser-transaction.k8s.pharmatrace.io/graphql";
const SENDING_SYSTEM = process.env.SERIAL_PROFILE_SENDING_SYSTEM || "388e3401-8cbd-42b4-8d9e-a196fc8e5cc6";
const RECEIVING_SYSTEM = process.env.SERIAL_PROFILE_RECEIVING_SYSTEM || SENDING_SYSTEM;
const COMPANY_NAME = process.env.SERIAL_COMPANY_NAME || "pharmatrace";
const TRANSACTION_USER_ID = process.env.SERIAL_TRANSACTION_USER_ID || process.env.KEYCLOAK_USER_ID || "4b63cc2a-1add-4354-bf01-91c89bcfe636";
const LIMIT = Number(process.env.ORDER_SERIAL_LIMIT || 0);

const clean = (value) => String(value ?? "").trim();

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
  const response = await fetch(TRANSACTION_GRAPHQL_URL, {
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

function profileId(profile) {
  return profile?.id || profile?.profileId || profile?.response?.id || profile?.data?.id || profile?.data?.response?.id || null;
}

function serialsFrom(body) {
  return body?.randomizedNumberList?.serialNo || body?.data?.randomizedNumberList?.serialNo || body?.response?.randomizedNumberList?.serialNo || [];
}

async function generate(group, token, profile) {
  const orderCount = group.orderLinks.length;
  const request = {
    id: "",
    sendingSystem: SENDING_SYSTEM,
    receivingSystem: RECEIVING_SYSTEM,
    actionCode: "C",
    idType: "GTIN",
    encodingType: null,
    objectKey: { name: "GTIN", value: profile.identifier || profile.name || group.batch },
    size: String(orderCount),
  };
  console.log(`${group.batch} -> generating ${orderCount} serial number(s) for profile ${profile.id}`);
  const response = await fetch(SERIAL_NUMBER_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, tenantid: TENANT_ID, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = { raw }; }
  if (!response.ok) throw new Error(`Serial generation failed (${response.status}): ${JSON.stringify(body)}`);
  const serialNumbers = serialsFrom(body);
  if (serialNumbers.length !== orderCount) throw new Error(`Serial generation returned ${serialNumbers.length} number(s); expected ${orderCount}`);
  return { profileId: profile.id, request, response: body, serialNumbers };
}

async function commission(serialNumbers, profileIdValue, token) {
  const numbers = serialNumbers.map((number) => JSON.stringify(number)).join(",");
  const query = `mutation { commissionNumbers(input:{encodeType:"GTIN",companyName:${JSON.stringify(COMPANY_NAME)},profileId:${JSON.stringify(profileIdValue)},userId:${JSON.stringify(TRANSACTION_USER_ID)},serialNumbers:[${numbers}]}) { status message response { transactionId commissionStatus numbers { number status } } } }`;
  const result = await graphql(query, token);
  const value = result?.commissionNumbers;
  if (!value?.response?.transactionId) throw new Error(`Commission did not return a transaction ID: ${JSON.stringify(value)}`);
  return value;
}

async function approve(transactionId, token) {
  const result = await graphql(`mutation { approveTransaction(id:${JSON.stringify(transactionId)}) { status message response { userId transactionId commissionStatus } } }`, token);
  const value = result?.approveTransaction;
  if (!value?.response?.transactionId) throw new Error(`Approval did not return a transaction ID: ${JSON.stringify(value)}`);
  return value;
}

async function main() {
  if (!existsSync(RESULT_PATH)) throw new Error(`Import result file not found: ${RESULT_PATH}`);
  const document = JSON.parse(await readFile(RESULT_PATH, "utf8"));
  const allGroups = Object.values(document.byBatch || {}).filter((group) => group?.lotId && group?.profile && Array.isArray(group.orderLinks));
  const groups = allGroups.slice(0, LIMIT > 0 ? LIMIT : undefined);
  const token = await getToken();
  console.log(`Processing ${groups.length} existing batch/profile group(s); no lots or profiles will be created.`);
  for (const [index, group] of groups.entries()) {
    const progress = `[${index + 1}/${groups.length}] batch=${group.batch}`;
    const existingSerials = group.serialNumbers || group.orderLinks.map((link) => link.serialNumber).filter(Boolean);
    if (existingSerials.length === group.orderLinks.length && group.approval?.response?.transactionId) {
      console.log(`${progress} -> SKIPPED_ALREADY_COMPLETE`);
      continue;
    }
    try {
      const profile = { ...group.profile, id: profileId(group.profile) };
      if (!profile.id) throw new Error("Existing profile has no ID");
      const generation = existingSerials.length === group.orderLinks.length
        ? group.generation
        : await generate(group, token, profile);
      const serialNumbers = generation?.serialNumbers || existingSerials;
      const commissionResult = group.commission?.response?.transactionId ? group.commission : await commission(serialNumbers, profile.id, token);
      const approvalResult = group.approval?.response?.transactionId ? group.approval : await approve(commissionResult.response.transactionId, token);
      const updated = {
        ...group,
        profile,
        generation,
        serialNumbers,
        commission: commissionResult,
        approval: approvalResult,
        orderLinks: group.orderLinks.map((link, orderIndex) => ({ ...link, serialNumber: serialNumbers[orderIndex] || null })),
        status: "CREATED",
        serialProcessingStatus: "APPROVED",
        serialProcessedAt: new Date().toISOString(),
      };
      document.byBatch[group.batch] = updated;
      console.log(`${progress} -> APPROVED commission=${commissionResult.response.transactionId} approval=${approvalResult.response.transactionId}`);
    } catch (error) {
      document.byBatch[group.batch] = { ...group, serialProcessingStatus: "FAILED", serialProcessingError: error.message, orderLinks: group.orderLinks };
      console.error(`${progress} -> FAILED: ${error.message}`);
    }
    // Persist after every group so an interrupted run does not lose completed mappings.
    await writeFile(RESULT_PATH, `${JSON.stringify({
      ...document,
      updatedAt: new Date().toISOString(),
      serialProcessing: true,
      results: Object.values(document.byBatch),
    }, null, 2)}\n`);
  }
  document.updatedAt = new Date().toISOString();
  document.serialProcessing = true;
  document.results = Object.values(document.byBatch);
  await writeFile(RESULT_PATH, `${JSON.stringify(document, null, 2)}\n`);
  const counts = document.results.reduce((all, item) => {
    const status = item.serialProcessingStatus || "NOT_PROCESSED";
    all[status] = (all[status] || 0) + 1;
    return all;
  }, {});
  console.log(JSON.stringify({ resultPath: RESULT_PATH, groups: groups.length, counts }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
