# Audit Anchor Service

![PharmaTrace Audit Anchor and Hedera Architecture](./public/flow-pt-hedera-agent-logs.png)

NestJS service implementing one shared pipeline:

```text
PostgreSQL audit logs
        ↓
Batch membership and Merkle proofs
        ↓
Protected Hedera HCS topic
        ↓
Mirror Node verification
```

The service supports manual, automatic, and combined execution modes. Start with manual mode while testing.

It also supports a manual-wallet path: the backend creates and stores the batch, freezes unsigned HCS transaction bytes, and returns them for the user's wallet to sign and execute.

## What stays private

The original audit logs, leaf hashes, and Merkle proofs remain in PostgreSQL. HCS receives only:

```json
{
  "version": 1,
  "batchId": "batch-uuid",
  "merkleRoot": "64-character-sha256-root",
  "hashAlgorithm": "SHA-256"
}
```

For the wallet-only path, use an HCS topic without a submit key so the connected wallet can publish. HCS messages remain publicly readable through Mirror Nodes.

## Install and configure

```bash
npm install
cp .env.example .env
psql "$DATABASE_URL" -f src/database/001_audit_anchor.sql
npm run start:dev
```

Example development configuration:

```env
PORT=3000
DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres

ANCHOR_MODE=manual
BATCH_MAX_EVENTS=1000
MAX_BATCHES_PER_RUN=10

HEDERA_NETWORK=testnet
HEDERA_TOPIC_ID=0.0.YOUR_TOPIC
MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com

SUBMISSION_UNKNOWN_WAIT_MS=300000
SUBMITTING_STALE_AFTER_MS=300000
MIRROR_SEARCH_MAX_PAGES=10

PLATFORM_ADMIN_API_KEY=GENERATE_A_RANDOM_SECRET
```

Generate the temporary development API key with:

```bash
openssl rand -hex 32
```

Never commit `.env` or private keys.

For wallet-only runtime operation, do not configure `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, or `HEDERA_TOPIC_SUBMIT_KEY`. These are only used by the local topic-creation script when creating a topic.

## Load test variables

```bash
export API_BASE='http://localhost:3000/api/v1'
export TEST_TENANT_ID='11111111-1111-4111-8111-111111111111'
export PLATFORM_ADMIN_API_KEY='YOUR_CURRENT_ADMIN_KEY'
```

## Submission modes

The same stored batches, leaves, proofs, roots, and Mirror Node verification logic are used by both submission modes:

| Mode | Fee payer | Topic authorization | Submission |
| --- | --- | --- | --- |
| `SERVICE` | Configured operator account | Backend topic submit key | Backend executes automatically |
| `WALLET` | Connected user wallet | Topic without a submit key | UI asks the wallet to sign and execute |

The backend freezes wallet transaction bytes with the connected account as payer. The browser adds the payer signature and executes. The wallet-only path does not require operator or topic-submit credentials in the UI.

## API overview

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/audit-anchor/sync` | Start a normal service-wallet synchronization job |
| `GET` | `/audit-anchor/sync/{jobId}` | Poll synchronization job status |
| `POST` | `/audit-anchor/wallet/prepare` | Create one committed wallet batch and prepare unsigned transaction bytes |
| `POST` | `/audit-anchor/wallet/{batchId}/prepare-transaction` | Generate fresh transaction bytes for the same stored batch/root |
| `POST` | `/audit-anchor/wallet/{batchId}/submitted` | Report the exact transaction ID executed by the wallet |
| `GET` | `/audit-anchor/status` | Read service monitoring counters |
| `GET` | `/audit-anchor/batches` | List batches |
| `GET` | `/audit-anchor/batches/{batchId}` | Read one batch and its status |
| `POST` | `/audit-anchor/batches/{batchId}/retry` | Retry an existing service batch without rebuilding it |
| `POST` | `/audit-anchor/batches/{batchId}/verify` | Start Mirror Node verification |
| `GET` | `/audit-anchor/logs/{auditLogId}/verify` | Verify one audit-log leaf and public anchor |

All endpoints shown here are relative to `/api/v1` and require the platform-admin guard in the current development implementation.

## Lot status and recall events

Lot status changes and recall pushes are separate from audit-log anchoring:

```text
UI changes lot status or pushes recall
        ↓
UI wallet signs the Hedera transaction
        ↓
UI receives the Hedera transaction hash
        ↓
Core application stores the lot Hedera metadata
        ↓
Audit event is written to audit_logs
        ↓
Wallet preparation batches the audit event
        ↓
UI submits the Merkle root to HCS
```

The current frontend paths are:

- `DELIVERY` status uses `createLotAnchorOnHedera()`.
- Recall uses `pushLotRecallOnHedera()`.
- `ACTIVATED`, `SUSPENDED`, and `DEACTIVATE` currently update the lot without an additional Hedera transaction.
- `setHederaAnchorOnLot` stores Hedera metadata on the lot; it does not create an `audit_logs` row.

The core application must create an audit-log row for each successful business event. The audit-anchor service does not infer a business event from a Hedera transaction. The recommended event types are:

```text
LOT_STATUS_CHANGED
LOT_RECALL_PUSHED
```

The event should include the lot ID, actor, previous and new status or recall mode, Hedera transaction hash, topic/contract information, and the wallet address. The event must be written only after the Hedera transaction succeeds. If the wallet transaction fails or is rejected, write a failed event only if the product requires failed-action auditing.

Example audit event fields:

```json
{
  "tenantId": "tenant-uuid",
  "actorType": "HUMAN",
  "actorId": "user-id",
  "actionType": "LOT_RECALL_PUSHED",
  "resourceType": "LOT",
  "resourceId": "lot-id",
  "status": "COMPLETED",
  "description": "Lot recall pushed to Hedera",
  "privateData": {
    "recallMode": "WHOLE_LOT",
    "hederaTransactionId": "0x...",
    "walletAddress": "0x..."
  }
}
```

Do not write directly to PostgreSQL from the browser. Use the core application audit API or add an authenticated backend ingestion endpoint that creates the `audit_logs` row and calculates its `event_hash`.

## Wallet database fields

Existing installations must support the wallet status and submission metadata:

```sql
ALTER TABLE audit_batches
ADD COLUMN IF NOT EXISTS submission_mode VARCHAR(20)
    NOT NULL DEFAULT 'SERVICE',
ADD COLUMN IF NOT EXISTS payer_account_id VARCHAR(100);

ALTER TABLE audit_batches
DROP CONSTRAINT IF EXISTS audit_batches_status_check;

ALTER TABLE audit_batches
ADD CONSTRAINT audit_batches_status_check
CHECK (
    status IN (
        'BUILDING',
        'READY',
        'READY_FOR_WALLET',
        'SUBMITTING',
        'SUBMITTED',
        'VERIFYING',
        'CONFIRMED',
        'SUBMISSION_FAILED',
        'SUBMISSION_UNKNOWN',
        'VERIFICATION_FAILED'
    )
);

ALTER TABLE audit_batches
DROP CONSTRAINT IF EXISTS audit_batches_submission_mode_check;

ALTER TABLE audit_batches
ADD CONSTRAINT audit_batches_submission_mode_check
CHECK (submission_mode IN ('SERVICE', 'WALLET'));
```

The project migration already contains these changes; the SQL above documents what is required for an existing database.

## Prepare and submit with a user wallet

The wallet account ID is required because the backend must freeze the transaction with that account as payer.

```bash
export WALLET_ACCOUNT_ID='0.0.USER_ACCOUNT'

curl -s -X POST \
  "$API_BASE/audit-anchor/wallet/prepare" \
  -H 'Content-Type: application/json' \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" \
  -d "{
    \"tenantId\": \"$TEST_TENANT_ID\",
    \"maxEvents\": 1000,
    \"payerAccountId\": \"$WALLET_ACCOUNT_ID\"
  }" |
jq
```

Omit `tenantId` to process all currently unbatched logs. Logs are still separated into one batch per tenant, and `maxEvents` applies to the entire request.

Example response:

```json
{
      "batchId": "batch-uuid",
      "tenantId": "tenant-uuid",
      "status": "READY_FOR_WALLET",
      "eventCount": 10,
      "topicId": "0.0.YOUR_TOPIC",
      "merkleRoot": "64-character-sha256-root",
      "transactionId": "0.0.USER_ACCOUNT@SECONDS.NANOS",
      "payerAccountId": "0.0.USER_ACCOUNT",
      "transactionBytes": "BASE64_UNSIGNED_TRANSACTION_BYTES",
      "logs": []
    }
}
```

The batch, batch items, leaf hashes, Merkle proofs, and root are committed before transaction bytes are created. A preparation or wallet failure therefore never returns those logs to the unprocessed pool.

### Sign and execute in the UI

The UI reconstructs the backend-prepared transaction and asks the connected Hedera wallet to add the payer signature and execute it. The exact wallet SDK call depends on the wallet connector, but the transaction bytes are reconstructed with the Hedera SDK:

```ts
import {
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";

const transaction =
  TopicMessageSubmitTransaction.fromBytes(
    Uint8Array.from(
      atob(preparedBatch.transactionBytes),
      (character) => character.charCodeAt(0),
    ),
  );

const response =
  await transaction.executeWithSigner(
    walletSigner,
  );

const transactionId =
  response.transactionId.toString();
```

The connected wallet account must equal the `payerAccountId` sent to `/wallet/prepare`. After execution, report the exact transaction ID:

```bash
export BATCH_ID='RETURNED_BATCH_UUID'
export HEDERA_TRANSACTION_ID='0.0.USER_ACCOUNT@SECONDS.NANOS'

curl -s -X POST \
  "$API_BASE/audit-anchor/wallet/$BATCH_ID/submitted" \
  -H 'Content-Type: application/json' \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" \
  -d "{\"transactionId\":\"$HEDERA_TRANSACTION_ID\",\"topicId\":\"0.0.YOUR_TOPIC\",\"sequenceNumber\":\"10\",\"consensusTimestamp\":\"SECONDS.NANOS\"}" |
jq
```

The callback returns HTTP `202`. The backend independently verifies the topic, payer, batch ID, Merkle root, transaction result, sequence number, and consensus timestamp through Mirror Node before changing the batch to `CONFIRMED`.

Expected callback response:

```json
{
  "accepted": true,
  "batchId": "batch-uuid",
  "status": "SUBMITTED"
}
```

`accepted: true` means the transaction ID was accepted for background verification. It does not mean that the HCS message is confirmed yet.

If the frozen transaction expires before wallet execution, request fresh bytes for the same stored batch and root:

```bash
curl -s -X POST \
  "$API_BASE/audit-anchor/wallet/$BATCH_ID/prepare-transaction" \
  -H 'Content-Type: application/json' \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" \
  -d "{\"payerAccountId\":\"$WALLET_ACCOUNT_ID\"}" |
jq
```

Wallet batches follow `READY_FOR_WALLET → SUBMITTED → VERIFYING → CONFIRMED`. Rejection or UI closure leaves the batch at `READY_FOR_WALLET`; its logs remain permanently assigned to that batch.

The regenerated transaction has a new Hedera transaction ID and validity window, but keeps the same batch ID, logs, leaf hashes, proofs, and Merkle root.

### Wallet safety rules

- The UI never receives `HEDERA_TOPIC_SUBMIT_KEY` or `HEDERA_OPERATOR_KEY`.
- A wallet batch can never be submitted through the backend service-operator path.
- The prepared transaction ID is not proof of submission. The wallet may submit with a different valid-start timestamp.
- The submitted callback may receive an empty transaction ID when the wallet connector does not return receipt details. The backend treats this as `SUBMISSION_UNKNOWN` and searches Mirror Node by batch ID and Merkle root.
- The transaction payer must match the stored `payer_account_id`.
- Values returned by the UI are not considered proof of consensus.
- Mirror Node must confirm the topic, payer, transaction result, batch ID, and Merkle root.
- `READY_FOR_WALLET` batches wait for the user; submitted wallet batches continue through reconciliation even when `ANCHOR_MODE=manual`.



## Create a wallet-enabled HCS topic

The operator account pays the topic-creation fee. The script creates a topic without a submit key so connected wallets can publish.

```bash
export HEDERA_NETWORK='testnet'
HEDERA_OPERATOR_ID='0.0.YOUR_OPERATOR_ACCOUNT' \
HEDERA_OPERATOR_KEY='PRIVATE_KEY' \
npm run hedera:create-topic

npm run hedera:create-topic
```

The script returns values similar to:

```text
HEDERA_TOPIC_ID=0.0.YOUR_TOPIC
```

Save `HEDERA_TOPIC_ID` in the runtime Secret and verify the topic metadata:

```bash
curl -s \
  "$MIRROR_NODE_URL/api/v1/topics/$HEDERA_TOPIC_ID" |
jq '{topic_id, memo, deleted, submit_key}'
```

## Trigger a manual synchronization

Manual synchronization selects only logs that do not already have a row in `audit_batch_items`.

```bash
curl -s -X POST \
  "$API_BASE/audit-anchor/sync" \
  -H 'Content-Type: application/json' \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" \
  -d "{
    \"tenantId\": \"$TEST_TENANT_ID\",
    \"maxEvents\": 1000
  }" |
jq
```

Expected response:

```json
{
  "jobId": "job-uuid",
  "status": "QUEUED"
}
```

Poll the job:

```bash
export JOB_ID='RETURNED_JOB_ID'

curl -s \
  "$API_BASE/audit-anchor/sync/$JOB_ID" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

Job states are `QUEUED`, `RUNNING`, `COMPLETED`, `PARTIALLY_COMPLETED`, `FAILED`, and `SKIPPED`.

If a sync processes zero logs, those logs may already belong to an existing batch. A failed batch must be retried; its logs must not be placed in a new batch.


## Inspect batches in PostgreSQL

```sql
SELECT
    id,
    status,
    submission_mode,
    payer_account_id,
    event_count,
    merkle_root,
    attempt_count,
    last_attempt_at,
    next_retry_at,
    last_error,
    hedera_topic_id,
    hedera_transaction_id,
    hedera_sequence_number,
    hedera_consensus_timestamp,
    submitted_at,
    confirmed_at,
    processing_completed_at
FROM audit_batches
ORDER BY created_at DESC;
```

Check unprocessed logs:

```sql
SELECT
    l.id,
    l.action_type,
    l.event_hash,
    l.occurred_at
FROM audit_logs l
LEFT JOIN audit_batch_items i
    ON i.audit_log_id = l.id
WHERE i.audit_log_id IS NULL
ORDER BY l.occurred_at, l.id;
```

## Retry an existing failed batch

Do not call manual sync to recover logs already assigned to a batch. Retry the same stored batch and Merkle root:

```bash
export BATCH_ID='FAILED_BATCH_UUID'

curl -s -X POST \
  "$API_BASE/audit-anchor/batches/$BATCH_ID/retry" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

Expected lifecycle:

```text
SUBMISSION_FAILED → SUBMITTING → SUBMITTED → VERIFYING → CONFIRMED
```

The retry increments `attempt_count` but keeps the same batch ID, logs, leaf hashes, proofs, and Merkle root.

## Verify the HCS message directly

Get the topic ID and sequence number from `audit_batches`, then query Mirror Node:

```bash
export HEDERA_TOPIC_ID='0.0.YOUR_TOPIC'
export HEDERA_SEQUENCE_NUMBER='1'

curl -s \
  "$MIRROR_NODE_URL/api/v1/topics/$HEDERA_TOPIC_ID/messages/$HEDERA_SEQUENCE_NUMBER" |
jq
```

Decode the Base64 message:

```bash
curl -s \
  "$MIRROR_NODE_URL/api/v1/topics/$HEDERA_TOPIC_ID/messages/$HEDERA_SEQUENCE_NUMBER" |
jq -r '.message' |
base64 --decode |
jq
```

Confirm that `batchId` and `merkleRoot` match PostgreSQL.

## Verify a complete batch through the API

```bash
curl -s -X POST \
  "$API_BASE/audit-anchor/batches/$BATCH_ID/verify" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

`{"accepted":true}` means background verification was accepted. It does not mean confirmation has finished. Check the database afterward.

A successful batch must have:

```text
status = CONFIRMED
hedera_consensus_timestamp = populated
confirmed_at = populated
processing_completed_at = populated
last_error = NULL
```

## Verify an individual audit log

Each audit log maps to its exact leaf through `audit_batch_items`:

```text
audit_log_id → leaf_hash → leaf_index → merkle_proof → batch_id
```

```bash
export AUDIT_LOG_ID='AUDIT_LOG_UUID'

curl -s \
  "$API_BASE/audit-anchor/logs/$AUDIT_LOG_ID/verify" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

Successful verification requires:

```text
audit_logs.event_hash = audit_batch_items.leaf_hash
leaf_hash + merkle_proof = audit_batches.merkle_root
database Merkle root = HCS Merkle root
```

Expected result:

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

An unprocessed log has no batch item or proof and should return `verified: false` with status `UNPROCESSED`, rather than an HTTP 500 error.

Add a paginated API. Do not return every database row in one response.

```http
GET /api/v1/audit-anchor/logs
```

Optional filters:

```text
tenantId
actorType
actionType
status
processed
limit
offset
```

Example:

```bash
curl -s \
  "$API_BASE/audit-anchor/logs?tenantId=$TEST_TENANT_ID&limit=100&offset=0" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

## 1. Add to `BatchService`

```ts
async listAuditLogs(input: {
  tenantId?: string;
  actorType?: string;
  actionType?: string;
  status?: string;
  processed?: boolean;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(
    Math.max(
      Number(input.limit ?? 100),
      1,
    ),
    200,
  );

  const offset = Math.max(
    Number(input.offset ?? 0),
    0,
  );

  const conditions: string[] = [];
  const values: unknown[] = [];

  const addCondition = (
    condition: string,
    value: unknown,
  ) => {
    values.push(value);

    conditions.push(
      condition.replace(
        "?",
        `$${values.length}`,
      ),
    );
  };

  if (input.tenantId) {
    addCondition(
      "l.tenant_id = ?::uuid",
      input.tenantId,
    );
  }

  if (input.actorType) {
    addCondition(
      "l.actor_type = ?",
      input.actorType,
    );
  }

  if (input.actionType) {
    addCondition(
      "l.action_type = ?",
      input.actionType,
    );
  }

  if (input.status) {
    addCondition(
      "l.status = ?",
      input.status,
    );
  }

  if (input.processed === true) {
    conditions.push(
      "i.audit_log_id IS NOT NULL",
    );
  }

  if (input.processed === false) {
    conditions.push(
      "i.audit_log_id IS NULL",
    );
  }

  const where =
    conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

  const countResult =
    await this.db.query<{
      total: string;
    }>(
      `
      SELECT COUNT(*)::text AS total
      FROM audit_logs l
      LEFT JOIN audit_batch_items i
        ON i.audit_log_id = l.id
      ${where}
      `,
      values,
    );

  const limitPosition =
    values.length + 1;

  const offsetPosition =
    values.length + 2;

  const result =
    await this.db.query(
      `
      SELECT
        l.id,
        l.tenant_id,
        l.workflow_id,

        l.actor_type,
        l.actor_id,
        l.action_type,

        l.resource_type,
        l.resource_id,

        l.status,
        l.description,

        l.fabric_transaction_id,
        l.previous_event_hash,
        l.event_hash,

        l.occurred_at,
        l.recorded_at,

        i.batch_id,
        i.leaf_index,
        i.leaf_hash,

        b.status AS batch_status,
        b.submission_mode,
        b.merkle_root,

        b.hedera_topic_id,
        b.hedera_transaction_id,
        b.hedera_sequence_number,
        b.hedera_consensus_timestamp,

        CASE
          WHEN i.audit_log_id IS NULL
            THEN 'UNPROCESSED'

          WHEN b.status IN (
            'BUILDING',
            'READY',
            'READY_FOR_WALLET'
          )
            THEN 'PROCESSED_LOCALLY'

          WHEN b.status IN (
            'SUBMITTING',
            'SUBMISSION_FAILED',
            'SUBMISSION_UNKNOWN',
            'VERIFICATION_FAILED'
          )
            THEN 'WAITING_FOR_RECOVERY'

          WHEN b.status IN (
            'SUBMITTED',
            'VERIFYING'
          )
            THEN 'WAITING_FOR_CONFIRMATION'

          WHEN b.status = 'CONFIRMED'
            THEN 'CONFIRMED'

          ELSE 'UNKNOWN'
        END AS anchor_status

      FROM audit_logs l

      LEFT JOIN audit_batch_items i
        ON i.audit_log_id = l.id

      LEFT JOIN audit_batches b
        ON b.id = i.batch_id

      ${where}

      ORDER BY
        l.occurred_at DESC,
        l.id DESC

      LIMIT $${limitPosition}
      OFFSET $${offsetPosition}
      `,
      [
        ...values,
        limit,
        offset,
      ],
    );

  const total = Number(
    countResult.rows[0]?.total ?? 0,
  );

  return {
    items: result.rows,
    pagination: {
      total,
      limit,
      offset,
      hasMore:
        offset + result.rows.length <
        total,
    },
  };
}
```

This deliberately excludes `private_data` from the list response.

## 2. Add to `AuditAnchorController`

Import `Query`:

```ts
import {
  Controller,
  Get,
  Query,
  // Existing imports...
} from "@nestjs/common";
```

Add the endpoint:

```ts
@Get("logs")
async listLogs(
  @Query("tenantId")
  tenantId?: string,

  @Query("actorType")
  actorType?: string,

  @Query("actionType")
  actionType?: string,

  @Query("status")
  status?: string,

  @Query("processed")
  processedValue?: string,

  @Query("limit")
  limitValue?: string,

  @Query("offset")
  offsetValue?: string,
) {
  let processed:
    | boolean
    | undefined;

  if (
    processedValue === "true"
  ) {
    processed = true;
  } else if (
    processedValue === "false"
  ) {
    processed = false;
  }

  return this.batches.listAuditLogs({
    tenantId,
    actorType,
    actionType,
    status,
    processed,

    limit: limitValue
      ? Number(limitValue)
      : 100,

    offset: offsetValue
      ? Number(offsetValue)
      : 0,
  });
}
```

## 3. Example responses

```json
{
  "items": [
    {
      "id": "audit-log-uuid",
      "tenant_id": "tenant-uuid",
      "actor_type": "HUMAN",
      "actor_id": "user-id",
      "action_type": "LOT_CREATED",
      "resource_type": "LOT",
      "resource_id": "lot-id",
      "status": "COMPLETED",
      "event_hash": "64-character-hash",
      "batch_id": "batch-uuid",
      "leaf_index": 0,
      "leaf_hash": "64-character-hash",
      "batch_status": "CONFIRMED",
      "submission_mode": "SERVICE",
      "anchor_status": "CONFIRMED",
      "hedera_topic_id": "0.0.123",
      "hedera_sequence_number": "10"
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

## 4. Useful calls

All logs:

```bash
curl -s \
  "$API_BASE/audit-anchor/logs?limit=100&offset=0" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

Unprocessed logs:

```bash
curl -s \
  "$API_BASE/audit-anchor/logs?processed=false" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

Processed logs:

```bash
curl -s \
  "$API_BASE/audit-anchor/logs?processed=true" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

Filter by action:

```bash
curl -s \
  "$API_BASE/audit-anchor/logs?actionType=LOT_CREATED" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

Filter by tenant and actor:

```bash
curl -s \
  "$API_BASE/audit-anchor/logs?tenantId=$TEST_TENANT_ID&actorType=AGENT" \
  -H "x-platform-admin-key: $PLATFORM_ADMIN_API_KEY" |
jq
```

For production, derive `tenantId` from the authenticated JWT rather than allowing normal tenant users to choose an arbitrary tenant ID. Only platform administrators should be allowed to query across every tenant.

## Verify leaf mapping in PostgreSQL

```sql
SELECT
    i.leaf_index,
    i.audit_log_id,
    l.action_type,
    i.leaf_hash,
    l.event_hash,
    i.leaf_hash = l.event_hash AS hash_matches,
    i.merkle_proof,
    b.id AS batch_id,
    b.merkle_root,
    b.status
FROM audit_batch_items i
JOIN audit_logs l ON l.id = i.audit_log_id
JOIN audit_batches b ON b.id = i.batch_id
WHERE i.batch_id = 'BATCH_UUID'
ORDER BY i.leaf_index;
```

## Recovery behavior

### Service batches

- `READY`: submit the stored batch and root.
- `SUBMISSION_FAILED`: retry the same batch after `next_retry_at` or through the retry endpoint.
- `SUBMISSION_UNKNOWN`: search Mirror Node by batch ID and root before considering resubmission.
- `SUBMISSION_UNKNOWN` not found during the safe waiting period: leave unchanged and check again.
- `SUBMISSION_UNKNOWN` not found after the safe waiting period: retry the same stored batch/root.
- Stale `SUBMITTING`: treat as `SUBMISSION_UNKNOWN` because Hedera may already have accepted it.
- `SUBMITTED`, `VERIFYING`, or `VERIFICATION_FAILED`: verify through Mirror Node without resubmitting.
- `CONFIRMED`: never rebuild or resubmit.

### Wallet batches

- `READY_FOR_WALLET`: wait for the UI wallet; reconciliation does not submit it.
- Wallet rejection or UI closure: remain `READY_FOR_WALLET`.
- Expired frozen transaction: prepare fresh transaction bytes for the same batch/root.
- `SUBMITTED`, `VERIFYING`, or `VERIFICATION_FAILED`: verify through Mirror Node without creating a new batch.
- `SUBMISSION_UNKNOWN`: search Mirror Node by topic, payer, batch ID, and Merkle root. If found, store the recovered transaction ID and confirm the batch.
- A wallet batch with no recovered transaction after the safe wait returns to `READY_FOR_WALLET`; the UI can submit the same batch again.
- `CONFIRMED`: never rebuild or resubmit.

Mirror Node `404` means the message may not be indexed yet. An HTTP failure or invalid response is a verification error, not `NOT_FOUND`.

## Concurrency and duplicate prevention

- A PostgreSQL advisory lock prevents overlapping runs across replicas.
- `FOR UPDATE SKIP LOCKED` protects selected audit-log rows.
- Unique `audit_batch_items.audit_log_id` prevents a log entering two batches.
- Batch data is committed before Hedera is contacted.
- Failed submissions keep the same stored root and proofs.
- Each batch belongs to exactly one tenant, even when wallet preparation omits `tenantId`.
- Wallet preparation validates the payer, topic, and topic submit key before assigning logs.

## Production checklist

- Replace `PlatformAdminGuard` with JWT/Keycloak platform-admin authorization.
- Rotate any development admin key exposed in terminals, documentation, or chat.
- Inject Hedera keys through Vault or protected Kubernetes Secrets.
- Never store Hedera private keys in PostgreSQL.
- Never expose backend secrets through `NEXT_PUBLIC_*`, `VITE_*`, or other frontend environment variables.
- Use deterministic canonical serialization when generating and recalculating `event_hash`.
- Run migrations through the deployment pipeline.
- Test definite failure, uncertain submission, stale workers, Mirror Node delay, and duplicate prevention.
- Keep `ANCHOR_MODE=manual` until recovery tests pass; then use `ANCHOR_MODE=both`.

## Verification boundary

Current leaf verification proves that the stored `audit_logs.event_hash` is included in the Merkle root anchored on HCS. For complete private-record tamper detection, recalculate `event_hash` from a canonical representation of the audit-log fields and compare it with the stored hash before verifying the Merkle proof.



## Safe deployment commands

Use short-lived AWS credentials from your local credential helper or CI secret store. Do not place credentials, passwords, MFA tokens, session tokens, or private keys in this README.

```bash
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker build --platform linux/amd64 \
  -t "$ECR_REGISTRY/audit-anchor:$IMAGE_TAG" .

docker push "$ECR_REGISTRY/audit-anchor:$IMAGE_TAG"

helm upgrade --install audit-anchor ./audit-anchor \
  --namespace serialization \
  --create-namespace \
  --set image.repository="$ECR_REGISTRY/audit-anchor" \
  --set image.tag="$IMAGE_TAG"

kubectl -n serialization logs deployment/audit-anchor --all-pods=true --prefix
```

For database access, use a Kubernetes Secret or an interactive password prompt. Never put `PGPASSWORD` values in shell history or documentation.
