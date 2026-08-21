# Audit Anchor API

API reference for batching audit logs, creating Merkle proofs, anchoring roots on Hedera HCS, and verifying them through Mirror Node.

## Base URL and authentication

All endpoints are relative to `/api/v1`.

```http
x-platform-admin-key: <platform-admin-api-key>
Content-Type: application/json
```

In production, use JWT/Keycloak authorization. Derive tenant scope from authenticated claims for tenant users. Only platform administrators may query or process every tenant.

## Published HCS payload

```json
{
  "version": 1,
  "batchId": "batch-uuid",
  "merkleRoot": "64-character-sha256-root",
  "hashAlgorithm": "SHA-256"
}
```

Original logs, leaf hashes, and Merkle proofs remain private. No API returns the topic submit key or operator key.

## Submission modes

| Mode | Fee payer | Execution |
| --- | --- | --- |
| `SERVICE` | Backend operator | Backend authorizes and submits |
| `WALLET` | Connected wallet | Backend authorizes and prepares; wallet signs as payer and executes |

## Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/audit-anchor/sync` | Queue service-mode synchronization |
| `GET` | `/audit-anchor/sync/{jobId}` | Get synchronization status |
| `POST` | `/audit-anchor/wallet/prepare` | Create wallet batches and prepared transactions |
| `POST` | `/audit-anchor/wallet/{batchId}/prepare-transaction` | Regenerate an expired wallet transaction |
| `POST` | `/audit-anchor/wallet/{batchId}/submitted` | Report the transaction executed by the wallet |
| `GET` | `/audit-anchor/status` | Get service counters |
| `GET` | `/audit-anchor/batches` | List batches |
| `GET` | `/audit-anchor/batches/{batchId}` | Get one batch |
| `POST` | `/audit-anchor/batches/{batchId}/retry` | Retry the same failed service batch |
| `POST` | `/audit-anchor/batches/{batchId}/verify` | Queue Mirror Node verification |
| `GET` | `/audit-anchor/logs` | List audit logs with pagination |
| `GET` | `/audit-anchor/logs/{auditLogId}/verify` | Verify one log and its public anchor |

## 1. Queue service synchronization

```http
POST /api/v1/audit-anchor/sync
```

Request:

```json
{
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "maxEvents": 1000
}
```

Both fields are optional. Without `tenantId`, the run may select unbatched logs across tenants, but each generated batch still belongs to one tenant. `maxEvents` applies to the entire request.

Response â€” `202 Accepted`:

```json
{
  "jobId": "job-uuid",
  "status": "QUEUED"
}
```

Only logs without a batch item are selected. Logs already assigned to failed or pending batches are never rebuilt.

## 2. Get synchronization status

```http
GET /api/v1/audit-anchor/sync/{jobId}
```

```json
{
  "jobId": "job-uuid",
  "status": "COMPLETED",
  "processedBatches": 2,
  "processedEvents": 150,
  "failedBatches": 0,
  "error": null
}
```

Job statuses: `QUEUED`, `RUNNING`, `COMPLETED`, `PARTIALLY_COMPLETED`, `FAILED`, and `SKIPPED`.

## 3. Prepare wallet batches

```http
POST /api/v1/audit-anchor/wallet/prepare
```

Request:

```json
{
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "maxEvents": 1000,
  "payerAccountId": "0.0.123456"
}
```

| Field | Required | Description |
| --- | --- | --- |
| `payerAccountId` | Yes | Connected Hedera account that pays and executes |
| `tenantId` | No | Restricts selection to one tenant |
| `maxEvents` | No | Maximum logs across this request |

Response â€” `200 OK`:

```json
{
  "batchId": "batch-uuid",
  "tenantId": "tenant-uuid",
  "status": "READY_FOR_WALLET",
  "eventCount": 10,
  "merkleRoot": "64-character-sha256-root",
  "topicId": "0.0.789012",
  "payerAccountId": "0.0.123456",
  "transactionId": "0.0.123456@1787040000.123456789",
  "transactionBytes": "BASE64_UNSIGNED_TRANSACTION_BYTES",
  "logs": [
    {
      "auditLogId": "log-uuid",
      "leafIndex": 0,
      "leafHash": "64-character-leaf-hash",
      "merkleProof": ["R:64-character-sibling-hash"]
    }
  ]
}
```

Before responding, the backend commits the batch, items, leaves, proofs, and root, then freezes unsigned transaction bytes with `payerAccountId`. The wallet signs and executes. Use an HCS topic without a submit key for this wallet-only flow.

## 4. Regenerate an expired wallet transaction

```http
POST /api/v1/audit-anchor/wallet/{batchId}/prepare-transaction
```

Request:

```json
{
  "payerAccountId": "0.0.123456"
}
```

Response â€” `200 OK`:

```json
{
  "batchId": "batch-uuid",
  "status": "READY_FOR_WALLET",
  "topicId": "0.0.789012",
  "merkleRoot": "64-character-sha256-root",
  "transactionId": "0.0.123456@1787040300.987654321",
  "transactionBytes": "BASE64_NEW_UNSIGNED_TRANSACTION_BYTES"
}
```

The transaction ID and validity window change. The batch ID, logs, leaves, proofs, and root remain unchanged.

## 5. Report wallet submission

Call after the wallet executes the prepared transaction.

```http
POST /api/v1/audit-anchor/wallet/{batchId}/submitted
```

Request:

```json
{
  "transactionId": "0.0.123456@1787040300.987654321",
  "topicId": "0.0.789012",
  "sequenceNumber": "10",
  "consensusTimestamp": "1787040305.123456789"
}
```

Response â€” `202 Accepted`:

```json
{
  "accepted": true,
  "batchId": "batch-uuid",
  "status": "SUBMITTED"
}
```

`accepted: true` means verification was queued, not confirmed. Mirror Node must confirm the result, topic, payer, batch ID, Merkle root, sequence number, and consensus timestamp. The callback accepts only the transaction ID prepared for that batch.

## 6. Get service status

```http
GET /api/v1/audit-anchor/status
```

```json
{
  "totalAudit": 4,
  "unprocessed": 0,
  "readySubmitted": 0,
  "confirmed": 0,
  "status": "UP",
  "unprocessedLogs": 25,
  "readyBatches": 0,
  "walletBatchesWaiting": 2,
  "submittedBatches": 1,
  "failedBatches": 0,
  "confirmedBatches": 120
}
```

## 7. List batches

Filter wallet batches waiting for UI submission with:

```http
GET /api/v1/audit-anchor/batches?status=READY_FOR_WALLET&limit=100
```

The UI can read each returned `id` as the `batchId` and use:

```text
POST /api/v1/audit-anchor/wallet/{batchId}/submitted
```

The response field is `status`; `batch_status` is used in audit-log details and is equivalent to the batch status.

`GET /api/v1/audit-anchor/batches/{batchId}` returns the wallet batch's first 20 assigned `logs`, `logsTotal`, `logsReturned`, and `transactionBytes` after the wallet transaction has been prepared. The prepare endpoint still returns all prepared logs.

```http
GET /api/v1/audit-anchor/batches?tenantId={uuid}&status={status}&submissionMode={mode}&limit=100&offset=0
```

Query parameters:

| Parameter | Description |
| --- | --- |
| `tenantId` | Filter by tenant |
| `status` | Filter by batch status |
| `submissionMode` | `SERVICE` or `WALLET` |
| `limit` | Default `100`; maximum `200` |
| `offset` | Default `0` |

Response â€” `200 OK`:

```json
{
  "items": [
    {
      "batchId": "batch-uuid",
      "tenantId": "tenant-uuid",
      "status": "CONFIRMED",
      "submissionMode": "WALLET",
      "payerAccountId": "0.0.123456",
      "eventCount": 10,
      "merkleRoot": "64-character-sha256-root",
      "hederaTopicId": "0.0.789012",
      "hederaTransactionId": "0.0.123456@1787040300.987654321",
      "hederaSequenceNumber": "42",
      "hederaConsensusTimestamp": "1787040305.123456789",
      "createdAt": "2026-08-18T09:00:00.000Z",
      "confirmedAt": "2026-08-18T09:01:00.000Z"
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 100,
    "offset": 0,
    "hasMore": false
  }
}
```

## 8. Get one batch

```http
GET /api/v1/audit-anchor/batches/{batchId}
```

Response â€” `200 OK`:

```json
{
  "batchId": "batch-uuid",
  "tenantId": "tenant-uuid",
  "status": "CONFIRMED",
  "submissionMode": "SERVICE",
  "payerAccountId": null,
  "eventCount": 100,
  "merkleRoot": "64-character-sha256-root",
  "attemptCount": 1,
  "lastError": null,
  "hederaTopicId": "0.0.789012",
  "hederaTransactionId": "0.0.111111@1787040000.000000001",
  "hederaSequenceNumber": "41",
  "hederaConsensusTimestamp": "1787040005.111111111",
  "submittedAt": "2026-08-18T08:00:00.000Z",
  "confirmedAt": "2026-08-18T08:01:00.000Z"
}
```

## 9. Retry a failed service batch

```http
POST /api/v1/audit-anchor/batches/{batchId}/retry
```

Response â€” `202 Accepted`:

```json
{
  "accepted": true,
  "batchId": "batch-uuid",
  "status": "SUBMITTING"
}
```

This retries the same stored batch and root. It is valid only for recoverable `SERVICE` batches. Wallet batches return to the wallet flow.

## 10. Verify a batch

```http
POST /api/v1/audit-anchor/batches/{batchId}/verify
```

Response â€” `202 Accepted`:

```json
{
  "accepted": true,
  "batchId": "batch-uuid",
  "status": "VERIFYING"
}
```

Poll `GET /audit-anchor/batches/{batchId}` until `CONFIRMED` or `VERIFICATION_FAILED`.

## 11. List audit logs

```http
GET /api/v1/audit-anchor/logs
```

| Parameter | Description |
| --- | --- |
| `tenantId` | Filter by tenant UUID |
| `actorType` | Example: `HUMAN`, `AGENT`, or `SYSTEM` |
| `actionType` | Filter by action type |
| `status` | Filter by log status |
| `processed` | `true` if assigned to a batch; otherwise `false` |
| `limit` | Default `100`; range `1â€“200` |
| `offset` | Default `0`; minimum `0` |

Example:

```http
GET /api/v1/audit-anchor/logs?tenantId=11111111-1111-4111-8111-111111111111&processed=true&limit=100&offset=0
```

Response â€” `200 OK`:

```json
{
  "items": [
    {
      "id": "audit-log-uuid",
      "tenantId": "tenant-uuid",
      "actorType": "HUMAN",
      "actorId": "user-id",
      "actionType": "LOT_CREATED",
      "resourceType": "LOT",
      "resourceId": "lot-id",
      "status": "COMPLETED",
      "eventHash": "64-character-hash",
      "occurredAt": "2026-08-18T08:30:00.000Z",
      "batchId": "batch-uuid",
      "leafIndex": 0,
      "leafHash": "64-character-hash",
      "batchStatus": "CONFIRMED",
      "submissionMode": "SERVICE",
      "anchorStatus": "CONFIRMED",
      "merkleRoot": "64-character-sha256-root",
      "hederaTopicId": "0.0.789012",
      "hederaTransactionId": "0.0.111111@1787040000.000000001",
      "hederaSequenceNumber": "41",
      "hederaConsensusTimestamp": "1787040005.111111111"
    }
  ],
  "pagination": {
    "total": 1500,
    "limit": 100,
    "offset": 0,
    "hasMore": true
  }
}
```

Collection responses exclude `privateData` and full Merkle proofs.

| Anchor status | Meaning |
| --- | --- |
| `UNPROCESSED` | Not assigned to a batch |
| `PROCESSED_LOCALLY` | Batch and proof exist; not submitted |
| `WAITING_FOR_RECOVERY` | Submission or verification needs recovery |
| `WAITING_FOR_CONFIRMATION` | Submitted; Mirror Node confirmation pending |
| `CONFIRMED` | Public anchor verified |
| `UNKNOWN` | Unexpected state |

## 12. Verify one audit log

```http
GET /api/v1/audit-anchor/logs/{auditLogId}/verify
```

Confirmed response â€” `200 OK`:

```json
{
  "auditLogId": "audit-log-uuid",
  "batchId": "batch-uuid",
  "leafIndex": 0,
  "eventHashMatchesLeaf": true,
  "merkleProofValid": true,
  "hederaAnchorValid": true,
  "mirrorStatus": "FOUND",
  "batchStatus": "CONFIRMED",
  "verified": true
}
```

Unprocessed response â€” `200 OK`:

```json
{
  "auditLogId": "audit-log-uuid",
  "status": "UNPROCESSED",
  "verified": false
}
```

Verification requires the event hash to equal its leaf, the proof to reconstruct the stored root, and the HCS message to contain the same batch ID and root on the expected topic.

## Status models

| Batch status | Meaning |
| --- | --- |
| `BUILDING` | Batch is being created |
| `READY` | Service batch is ready to submit |
| `READY_FOR_WALLET` | Waiting for wallet execution |
| `SUBMITTING` | Service submission is in progress |
| `SUBMITTED` | Transaction recorded; confirmation pending |
| `VERIFYING` | Mirror Node verification in progress |
| `CONFIRMED` | HCS anchor verified |
| `SUBMISSION_FAILED` | Definite failure; same service batch may retry |
| `SUBMISSION_UNKNOWN` | Outcome uncertain; reconcile before retry |
| `VERIFICATION_FAILED` | Submission exists but verification failed |

Service flow:

```text
BUILDING â†’ READY â†’ SUBMITTING â†’ SUBMITTED â†’ VERIFYING â†’ CONFIRMED
```

Wallet flow:

```text
BUILDING â†’ READY_FOR_WALLET â†’ SUBMITTED â†’ VERIFYING â†’ CONFIRMED
```

Wallet rejection or UI closure leaves the batch at `READY_FOR_WALLET`; its logs remain assigned.

## Error format

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "code": "INVALID_PAYER_ACCOUNT_ID",
  "message": "payerAccountId must be a valid Hedera account ID",
  "requestId": "request-uuid"
}
```

| HTTP status | Use |
| --- | --- |
| `200` | Successful read, preparation, or synchronous result |
| `202` | Background operation accepted |
| `400` | Invalid path, query, or body value |
| `401` | Missing or invalid authentication |
| `403` | Caller lacks tenant or operation access |
| `404` | Job, batch, or log not found |
| `409` | Invalid batch state, payer mismatch, or stale transaction ID |
| `422` | Valid request cannot be processed safely |
| `429` | Rate limit or synchronization already running |
| `500` | Unexpected server failure |
| `503` | Hedera or Mirror Node unavailable |

## Safety requirements

- Never expose or accept Hedera private keys through an API.
- Never treat wallet-returned values as consensus proof.
- Verify wallet submissions independently through Mirror Node.
- Require payer and transaction ID to match the prepared transaction.
- Never submit a wallet batch through the service-operator path.
- Retry the same stored batch and root; never rebuild failed or uncertain batches.
- Paginate collection endpoints and cap `limit` at `200`.
- Exclude private audit data from collection responses.
- Derive tenant scope from authenticated claims for non-admin callers.
