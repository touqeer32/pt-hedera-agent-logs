#!/usr/bin/env node

import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction } from '@hashgraph/sdk';

const API_BASE = (process.env.AUDIT_ANCHOR_API_BASE
  ?? process.env.API
  ?? 'https://firstbucket.k8s.pharmatrace.io/api/v1').replace(/\/$/, '');
const TENANT_ID = process.env.TENANT_ID;
const PLATFORM_ADMIN_API_KEY = process.env.PLATFORM_ADMIN_API_KEY;
const NETWORK = (process.env.HEDERA_NETWORK ?? 'mainnet').toLowerCase();
const PAYER_ACCOUNT_ID = process.env.HEDERA_OPERATOR_ID ?? process.env.PAYER_ACCOUNT_ID;
const PAYER_PRIVATE_KEY = process.env.HEDERA_OPERATOR_KEY ?? process.env.PAYER_PRIVATE_KEY;
const LIMIT = Math.min(Math.max(Number(process.env.LIMIT ?? 100), 1), 100);
const DELAY_MS = Math.max(Number(process.env.DELAY_MS ?? 1000), 0);

if (!TENANT_ID) throw new Error('Set TENANT_ID');
if (!PLATFORM_ADMIN_API_KEY) throw new Error('Set PLATFORM_ADMIN_API_KEY');
if (!PAYER_ACCOUNT_ID) throw new Error('Set HEDERA_OPERATOR_ID or PAYER_ACCOUNT_ID');
if (!PAYER_PRIVATE_KEY) throw new Error('Set HEDERA_OPERATOR_KEY or PAYER_PRIVATE_KEY');
if (!['mainnet', 'testnet'].includes(NETWORK)) throw new Error('HEDERA_NETWORK must be mainnet or testnet');

const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  'x-platform-admin-key': PLATFORM_ADMIN_API_KEY,
};

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRows(body) {
  if (Array.isArray(body)) return body;
  return body?.data ?? body?.batches ?? body?.items ?? [];
}

function getValue(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function createClient() {
  const client = NETWORK === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  const accountId = AccountId.fromString(PAYER_ACCOUNT_ID);
  const normalizedKey = PAYER_PRIVATE_KEY.trim().replace(/^0x/, '');
  const keyType = (process.env.HEDERA_OPERATOR_KEY_TYPE ?? 'ECDSA').toUpperCase();
  const privateKey = keyType === 'ED25519'
    ? PrivateKey.fromStringED25519(normalizedKey)
    : keyType === 'DER'
      ? PrivateKey.fromStringDer(normalizedKey)
      : PrivateKey.fromStringECDSA(normalizedKey);
  client.setOperator(accountId, privateKey);
  return client;
}

async function submitBatch(client, row) {
  const batchId = getValue(row, 'id', 'batchId');
  if (!batchId) throw new Error('Batch response has no id');

  const detail = await request(`/audit-anchor/batches/${encodeURIComponent(batchId)}`);
  const message = getValue(detail, 'message');
  const topicId = getValue(detail, 'hedera_topic_id', 'hederaTopicId', 'topicId');
  if (!message) throw new Error(`Batch ${batchId} has no prepared HCS message`);
  if (!topicId) throw new Error(`Batch ${batchId} has no topic ID`);

  const transaction = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .execute(client);
  const receipt = await transaction.getReceipt(client);
  const transactionId = transaction.transactionId.toString();
  const sequenceNumber = receipt.topicSequenceNumber?.toString();

  const callback = await request(`/audit-anchor/wallet/${encodeURIComponent(batchId)}/submitted`, {
    method: 'POST',
    body: JSON.stringify({
      transactionId,
      topicId,
      sequenceNumber,
    }),
  });

  return { batchId, transactionId, topicId, sequenceNumber, callback };
}

async function main() {
  const query = `/audit-anchor/batches?status=READY_FOR_WALLET&limit=${LIMIT}&tenantId=${encodeURIComponent(TENANT_ID)}`;
  const rows = getRows(await request(query));
  const client = createClient();
  const results = [];

  console.log(`Found ${rows.length} READY_FOR_WALLET batch(es) for tenant ${TENANT_ID}`);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const batchId = getValue(rows[index], 'id', 'batchId') ?? 'unknown';
      try {
        console.log(`[${index + 1}/${rows.length}] batch=${batchId} -> submitting HCS message...`);
        const result = await submitBatch(client, rows[index]);
        results.push({ ...result, status: 'SUBMITTED' });
        console.log(`[${index + 1}/${rows.length}] batch=${batchId} -> SUBMITTED transaction=${result.transactionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ batchId, status: 'FAILED', error: message });
        console.error(`[${index + 1}/${rows.length}] batch=${batchId} -> FAILED: ${message}`);
      }
      if (index < rows.length - 1) await sleep(DELAY_MS);
    }
  } finally {
    client.close();
  }

  const summary = {
    apiBase: API_BASE,
    network: NETWORK,
    tenantId: TENANT_ID,
    discovered: rows.length,
    submitted: results.filter((item) => item.status === 'SUBMITTED').length,
    failed: results.filter((item) => item.status === 'FAILED').length,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
