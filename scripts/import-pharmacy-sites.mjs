#!/usr/bin/env node

/**
 * Import pharmacy rows from the source CSV as PharmaTrace SITE records.
 *
 * Authentication is intentionally environment-only. This script never writes
 * usernames, passwords, tokens, or API keys to disk or to the output file.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Existing shell variables always win. Only this project's local .env files
// are loaded; agent-orchestrator credentials must not be selected here.
function loadDotenvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
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
const CSV_PATH = resolve(process.env.PHARMACY_CSV || "data/universities_202610221153.csv");
const RESULT_PATH = resolve(process.env.PHARMACY_IMPORT_RESULT || "data/pharmacy-site-import-results.json");
const TENANT_ID = process.env.PHARMATRACE_TENANT_ID || "f6b27eb5-5d5a-4f84-8016-45e2e1193aa1";
const DRY_RUN = process.env.DRY_RUN !== "false";
const LIMIT = Number(process.env.IMPORT_LIMIT || 0);

const ADD_SITE_MUTATION = `
  mutation AddCompanyDetails($input: CompanyBucketInput!) {
    addCompanyDetails(input: $input)
  }
`;

function listSitesQuery(pageNumber, pageSize) {
  return `
  {
    getByCompanyType(
      page: {
        size: ${pageSize},
        page: ${pageNumber}
        search: ""
      },
      companyType: SITE
    ) {
      data {
        id
        name
        description
        companyType
        tenantType
        addressLine1
        addressLine2
        country
        state
        city
        postalCode
        gln
        sgln
        isActive
        jsonData
        metaData
        createdOn
        updatedOn
      }
      page {
        currentPage
        size
        totalElements
        totalPages
      }
    }
  }
`;
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (character === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
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

function clean(value) {
  return String(value ?? "").trim();
}

function companyIdentifier(value) {
  // PharmaTrace validates GLN/SGLN as strings with a maximum length of 13.
  // Keep the original pharmacy code in jsonData/metaData, but remove visual
  // separators before sending it to the company subgraph.
  return clean(value).replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

function parseAddress(value, fallbackCity, fallbackCountry) {
  const raw = clean(value).replace(/^\{/, "").replace(/\}$/, "");
  const parts = raw.split(",").map(clean).filter(Boolean);
  const postalIndex = parts.findIndex((part) => /^\d{4,10}[- ]?[A-Z0-9]*$/i.test(part));
  const country = clean(fallbackCountry) || parts.at(-1) || "";
  const postalCode = postalIndex >= 0 ? parts[postalIndex] : "";
  const withoutCountry = parts.filter((part, index) => index !== parts.length - 1 && index !== postalIndex);
  const city = clean(fallbackCity) || (postalIndex > 0 ? withoutCountry.at(-1) : "");
  const cityIndex = city ? withoutCountry.lastIndexOf(city) : -1;
  const addressParts = cityIndex > 0 ? withoutCountry.slice(0, cityIndex) : withoutCountry;
  return {
    addressLine1: addressParts.join(", ") || raw,
    addressLine2: "",
    city,
    state: "",
    postalCode,
    country,
  };
}

function rowToSite(row) {
  const address = parseAddress(row.address, row.city, row.country);
  const latitude = clean(row.latitude);
  const longitude = clean(row.longitude);
  const pharmacyRecord = {
    source: "universities_202610221153.csv",
    recordType: clean(row.record_type) || "pharmacy",
    pharmacyRecordId: clean(row.university_id),
    pharmacyCode: clean(row.pharmacy_code),
    sourceCompanyId: clean(row.company_id),
    sourceUserId: clean(row.user_id),
    sourceAddress: clean(row.address),
    latitude,
    longitude,
    citySource: clean(row.city_source),
    cityConfidence: clean(row.city_confidence),
    website: clean(row.website),
    phoneNumber: clean(row.phone_number),
  };
  const companyCode = companyIdentifier(pharmacyRecord.pharmacyCode);
  const description = [pharmacyRecord.pharmacyCode, pharmacyRecord.phoneNumber]
    .filter(Boolean)
    .join(" | ");
  return {
    sourceRowId: pharmacyRecord.pharmacyRecordId,
    pharmacyCode: pharmacyRecord.pharmacyCode,
    input: {
      name: clean(row.name) || pharmacyRecord.pharmacyCode || pharmacyRecord.pharmacyRecordId,
      companyType: "SITE",
      tenantType: "MEMBER",
      description,
      ...address,
      addressLine2: latitude && longitude ? `${latitude},${longitude}` : "",
      gln: companyCode,
      sgln: companyCode,
      jsonData: JSON.stringify({ ...row, pharmacyRecord }),
      metaData: JSON.stringify([
        { key: "sourceRecordId", value: pharmacyRecord.pharmacyRecordId },
        { key: "pharmacyCode", value: pharmacyRecord.pharmacyCode },
        { key: "recordType", value: pharmacyRecord.recordType },
        { key: "latitude", value: pharmacyRecord.latitude },
        { key: "longitude", value: pharmacyRecord.longitude },
      ]),
    },
  };
}

async function getToken() {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL ||
    "https://kc.k8s.pharmatrace.io/auth/realms/first-bucket/protocol/openid-connect/token";
  const username = process.env.KEYCLOAK_USERNAME || process.env.PHARMATRACE_USERNAME;
  const password = process.env.KEYCLOAK_PASSWORD || process.env.PHARMATRACE_PASSWORD;

  // Match the agent behavior: configured Keycloak credentials always win over
  // a stale GRAPHQL_TOKEN left in the shell.
  if (!username || !password) {
    if (process.env.GRAPHQL_TOKEN) {
      console.log("Using GRAPHQL_TOKEN as the authentication fallback.");
      return process.env.GRAPHQL_TOKEN;
    }
    throw new Error("Set KEYCLOAK_USERNAME and KEYCLOAK_PASSWORD, or GRAPHQL_TOKEN as a fallback");
  }

  const clientId = process.env.KEYCLOAK_CLIENT_ID || "app";
  console.log(`Requesting a fresh Keycloak access token for ${username} using client ${clientId}...`);

  const form = new URLSearchParams({
    grant_type: process.env.KEYCLOAK_GRANT_TYPE || "password",
    // The admin UI uses the public `app` client. The agent uses `api`, which
    // must not be silently reused for this user-driven import.
    client_id: clientId,
    username,
    password,
  });
  if (process.env.KEYCLOAK_SCOPE) form.set("scope", process.env.KEYCLOAK_SCOPE);
  // The UI `app` client is public. Do not leak/use the agent `api` client
  // secret when the importer is authenticating the UI user.
  if (clientId !== "app" && process.env.KEYCLOAK_CLIENT_SECRET) {
    form.set("client_secret", process.env.KEYCLOAK_CLIENT_SECRET);
  }
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    const reason = body.error_description || body.error || "unknown authentication error";
    throw new Error(`Keycloak token request failed (${response.status}): ${reason}`);
  }
  console.log(`Keycloak authentication succeeded (expires in ${body.expires_in ?? "unknown"} seconds).`);
  return body.access_token;
}

async function graphql(query, variables, token) {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      tenantid: TENANT_ID,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const rawBody = await response.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { raw: rawBody };
  }
  if (!response.ok || body.errors?.length) {
    const details = body.errors?.map((error) => ({
      message: error.message,
      path: error.path,
      extensions: error.extensions,
    }));
    throw new Error(JSON.stringify({
      status: response.status,
      errors: details,
      body: body.raw || undefined,
    }));
  }
  return body.data;
}

async function loadExistingSites(token) {
  try {
    const sites = [];
    const pageSize = 10;
    let pageNumber = 1;
    let totalPages = 1;
    console.log("Checking existing SITE records for duplicate pharmacy mappings...");
    do {
      console.log(`  Loading existing sites page ${pageNumber}...`);
      const data = await graphql(listSitesQuery(pageNumber, pageSize), {
        pageInput: {
          page: pageNumber,
          search: "",
          size: pageSize,
          sortBy: "",
          filter: {},
        },
      }, token);
      const result = data?.getByCompanyType;
      sites.push(...(result?.data || []));
      totalPages = Number(result?.page?.totalPages || pageNumber);
      pageNumber += 1;
    } while (pageNumber <= totalPages);
    console.log(`Existing site lookup complete: ${sites.length} site record(s) found.`);
    return new Set(sites.flatMap((site) => {
      const keys = [site.name];
      try {
        const parsed = typeof site.jsonData === "string" ? JSON.parse(site.jsonData) : site.jsonData;
        if (parsed?.pharmacy_code) keys.push(parsed.pharmacy_code);
        if (parsed?.pharmacyRecord?.pharmacyCode) keys.push(parsed.pharmacyRecord.pharmacyCode);
      } catch {
        // Existing records with non-JSON jsonData are still matched by name.
      }
      return keys.filter(Boolean).map((key) => String(key).trim().toLowerCase());
    }));
  } catch (error) {
    if (/Invalid parameter: redirect_uri|authentication|unauthorized|401/i.test(error.message)) {
      throw new Error(`GraphQL authentication failed before the site import: ${error.message}`);
    }
    console.warn(`Could not load existing sites; continuing without duplicate lookup: ${error.message}`);
    return new Set();
  }
}

async function main() {
  const token = await getToken();
  const rows = parseCsv(await readFile(CSV_PATH, "utf8"))
    .filter((row) => clean(row.record_type).toLowerCase() === "pharmacy")
    .slice(0, LIMIT > 0 ? LIMIT : undefined);
  const existing = await loadExistingSites(token);
  const results = [];

  console.log(`${DRY_RUN ? "Previewing" : "Creating"} ${rows.length} pharmacy site record(s)...`);

  for (const [index, row] of rows.entries()) {
    const site = rowToSite(row);
    const duplicateKey = (site.pharmacyCode || site.input.name).toLowerCase();
    const progress = `[${index + 1}/${rows.length}] ${site.input.name} (${site.pharmacyCode || site.sourceRowId})`;
    if (existing.has(duplicateKey) || existing.has(site.input.name.toLowerCase())) {
      console.log(`${progress} -> SKIPPED_EXISTING`);
      results.push({ ...site, status: "SKIPPED_EXISTING" });
      continue;
    }
    if (DRY_RUN) {
      console.log(`${progress} -> DRY_RUN`);
      results.push({ ...site, status: "DRY_RUN" });
      continue;
    }
    try {
      console.log(`${progress} -> submitting addCompanyDetails...`);
      const data = await graphql(ADD_SITE_MUTATION, { input: site.input }, token);
      const siteId = data?.addCompanyDetails;
      if (!siteId) throw new Error("addCompanyDetails returned no site ID");
      existing.add(duplicateKey);
      existing.add(site.input.name.toLowerCase());
      console.log(`${progress} -> CREATED ${siteId}`);
      results.push({ sourceRowId: site.sourceRowId, pharmacyCode: site.pharmacyCode, siteId, name: site.input.name, status: "CREATED" });
    } catch (error) {
      console.error(`${progress} -> FAILED: ${error.message}`);
      results.push({ sourceRowId: site.sourceRowId, pharmacyCode: site.pharmacyCode, name: site.input.name, status: "FAILED", error: error.message });
    }
  }

  await writeFile(RESULT_PATH, `${JSON.stringify({ csvPath: CSV_PATH, dryRun: DRY_RUN, createdAt: new Date().toISOString(), results }, null, 2)}\n`);
  const counts = results.reduce((accumulator, item) => {
    accumulator[item.status] = (accumulator[item.status] || 0) + 1;
    return accumulator;
  }, {});
  console.log(JSON.stringify({ csvPath: CSV_PATH, resultPath: RESULT_PATH, totalPharmacies: rows.length, counts }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

