# UI wallet-only integration

The UI uses four operations. The backend never signs, pays, or submits the HCS transaction.

```text
GET  /audit-anchor/logs?processed=false
  ↓
POST /audit-anchor/wallet/prepare
  ↓
UI wallet signs and submits transactionBytes to HCS
  ↓
POST /audit-anchor/wallet/{batchId}/submitted
  ↓
GET  /audit-anchor/batches/{batchId}  (optional status polling)
```

All URLs include the global prefix:

```text
/api/v1
```

The temporary API guard requires `x-platform-admin-key: $PLATFORM_ADMIN_API_KEY` on every request.

## 1. Get unprocessed logs

```http
GET /api/v1/audit-anchor/logs?tenantId=f6b27eb5-5d5a-4f84-8016-45e2e1193aa1&processed=false&limit=1000
```

To list logs assigned to wallet batches waiting for submission, add:

```text
&batchStatus=READY_FOR_WALLET
```

Use `processed=false` to show logs whose response field is:

```json
{
  "anchor_status": "UNPROCESSED"
}
```

The UI can display `items` and `pagination`. This call is informational; batch assignment happens during preparation.

## 2. Prepare one wallet batch

```http
POST /api/v1/audit-anchor/wallet/prepare
Content-Type: application/json
```

```json
{
  "payerAccountId": "0.0.10031223",
  "tenantId": "f6b27eb5-5d5a-4f84-8016-45e2e1193aa1",
  "maxEvents": 1000
}
```

The connected wallet account must equal `payerAccountId`.

The backend selects unprocessed logs, keeps a batch tenant-specific, stores batch items, leaf hashes, proofs, and the Merkle root in PostgreSQL, then creates unsigned HCS transaction bytes. It does not use operator credentials.

Example response, `200 OK`:

```json
{
  "batchId": "batch-uuid",
  "tenantId": "f6b27eb5-5d5a-4f84-8016-45e2e1193aa1",
  "status": "READY_FOR_WALLET",
  "eventCount": 10,
  "merkleRoot": "64-character-root",
  "topicId": "0.0.10123883",
  "payerAccountId": "0.0.10031223",
  "transactionId": "0.0.10031223@1787059429.951",
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

The UI only needs `transactionBytes` for wallet submission. The remaining fields are useful for displaying batch details.

## 3. Sign and submit through the wallet

```ts
const bytes = Uint8Array.from(
  atob(prepared.transactionBytes),
  (character) => character.charCodeAt(0),
);

const transaction = Transaction.fromBytes(bytes);
const walletResult = await wallet.executeTransaction(transaction);
```

Use the transaction ID returned by the wallet, or the exact prepared transaction ID when the wallet connector returns it unchanged. The wallet signs, pays, and submits the Merkle-root message to `topicId`.

The UI must not send private keys or these runtime variables:

```text
HEDERA_OPERATOR_ID
HEDERA_OPERATOR_KEY
HEDERA_TOPIC_SUBMIT_KEY
```

The configured topic must not have a submit key. Otherwise the wallet transaction requires an additional submit-key signature.

## 4. Report the wallet submission

Call this only after the wallet successfully submits the transaction.

```http
POST /api/v1/audit-anchor/wallet/{batchId}/submitted
Content-Type: application/json
```

```json
{
  "transactionId": "0.0.10031223@1787059429.951",
  "topicId": "0.0.10123883",
  "sequenceNumber": "10",
  "consensusTimestamp": "1787059432.123456789"
}
```

Response, `202 Accepted`:

```json
{
  "accepted": true,
  "batchId": "batch-uuid",
  "status": "SUBMITTED"
}
```

The callback stores the Hedera transaction details and queues Mirror Node verification. `SUBMITTED` does not mean confirmed yet.

## 5. Poll batch status

To list all batches waiting for wallet submission:

```http
GET /api/v1/audit-anchor/batches?status=READY_FOR_WALLET&limit=100
```

Use each returned `id` as the `batchId` for the submission callback.

```http
GET /api/v1/audit-anchor/batches/{batchId}
```

For a wallet batch, the response includes the first 20 assigned `logs` and the persisted `transactionBytes`:

```json
{
  "id": "batch-uuid",
  "status": "READY_FOR_WALLET",
  "submission_mode": "WALLET",
  "hedera_transaction_id": "0.0.10031223@1787070011.856286607",
  "transactionBytes": "BASE64_UNSIGNED_TRANSACTION_BYTES",
  "logsTotal": 1000,
  "logsReturned": 20,
  "logs": [
    {
      "auditLogId": "log-uuid",
      "leafIndex": 0,
      "leafHash": "64-character-leaf-hash",
      "merkleProof": []
    }
  ]
}
```

`POST /wallet/prepare` continues to return the complete prepared log list. Only the batch-detail endpoint limits `logs` to 20 records.

The database migration adds `wallet_transaction_bytes`. Existing `READY_FOR_WALLET` batches are backfilled lazily from their stored transaction ID when this endpoint is first requested.

Expected lifecycle:

```text
READY_FOR_WALLET → SUBMITTED → VERIFYING → CONFIRMED
```

The reconciliation scheduler continues checking submitted wallet batches while `ANCHOR_MODE=manual`. If the transaction is rejected or never submitted, the batch remains recoverable and its logs stay assigned to that batch.

## 6. Dashboard counters

Use the status endpoint for the UI summary cards:

```http
GET /api/v1/audit-anchor/status
```

The relevant response fields are:

```json
{
  "totalAudit": 4,
  "unprocessed": 0,
  "readySubmitted": 0,
  "confirmed": 0
}
```

Display them as:

```text
Total Audit:     totalAudit
Unprocessed:     unprocessed
Ready/Submitted: readySubmitted
Confirmed:       confirmed
```

## Runtime configuration

The deployed backend needs only:

```env
ANCHOR_MODE=manual
PLATFORM_ADMIN_API_KEY=YOUR_RANDOM_ADMIN_API_KEY
HEDERA_NETWORK=testnet
HEDERA_TOPIC_ID=0.0.10123883
MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
SUBMISSION_UNKNOWN_WAIT_MS=300000
SUBMITTING_STALE_AFTER_MS=300000
MIRROR_SEARCH_MAX_PAGES=10
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:1234/postgres
```

`HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` are only needed when running the local topic-creation script. They must not be present in the deployed runtime Secret. Do not place inline explanatory comments in `.env` values.
