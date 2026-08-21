Focus the **Audit Anchor Service** on one shared anchoring pipeline with two ways to start it:

```text
AUTO mode → scheduler starts synchronization
MANUAL mode → protected API starts synchronization
                         ↓
                Same anchoring pipeline
```

## Common anchoring pipeline

Regardless of how it starts, the service performs:

```text
Find unbatched logs
        ↓
Lock selected logs
        ↓
Create batch
        ↓
Build Merkle tree
        ↓
Store root and proofs
        ↓
Sign and submit root to HCS
        ↓
Store Hedera receipt
        ↓
Verify through Mirror Node
        ↓
Mark batch confirmed
```

## Auto mode

The service runs a scheduler automatically.

It triggers when either:

* Ten minutes have passed.
* Unbatched logs reach a configured limit, such as 1,000.
* A previous failed batch is ready for retry.

Configuration could include:

```text
ANCHOR_MODE=auto
BATCH_INTERVAL_MINUTES=10
BATCH_MAX_EVENTS=1000
BATCH_MIN_EVENTS=1
HEDERA_NETWORK=testnet
```

The service uses a configured Hedera operator account and submit key to sign transactions automatically.

The private key should come from Vault, KMS integration or a protected Kubernetes Secret—not from the database or application configuration file.

## Manual API mode

Expose a protected endpoint:

```http
POST /audit-anchor/sync
```

The API should start a background synchronization job and return its job ID immediately. It should not keep the HTTP request open while waiting for Hedera and the Mirror Node.

The caller can optionally select:

* Tenant
* Maximum number of logs
* Time range
* Retry of a specific failed batch

Only platform administrators or authorized internal services should call this endpoint.

Additional endpoints:

```http
GET /audit-anchor/jobs/{jobId}
GET /audit-anchor/batches/{batchId}
POST /audit-anchor/batches/{batchId}/retry
GET /audit-anchor/batches/{batchId}/verify
```

The manual trigger still uses the service’s configured Hedera wallet. The API caller should not provide a Hedera private key.

## Wallet connection

For a backend service, “wallet connection” normally means:

* Hedera operator account ID
* Operator private key
* HCS topic ID
* Optional separate topic submit key

The operator account pays the HCS transaction fee. The topic submit key controls permission to publish to the topic.

Use separate credentials for:

```text
Testnet auto-anchor service
Testnet manual-anchor service, if required
Production Mainnet service
```

However, both modes can safely use the same service account initially because they share the same anchoring pipeline.

If you mean a browser wallet such as HashPack, that should be a separate optional manual-signing mode. It is not recommended for scheduled anchoring because a person would need to approve every batch transaction.

## Prevent duplicate submissions

Both modes may run at the same time, so the service must prevent the same logs from being processed twice.

When selecting logs:

* Use a database transaction.
* Lock rows using `FOR UPDATE SKIP LOCKED`.
* Assign the selected logs to a batch before releasing the lock.
* Give every batch an idempotency key.
* Never rebuild a confirmed batch.
* If submission times out, check Hedera before submitting again.

The manual API may find that the automatic worker already selected all logs. In that case, it should complete successfully with “no unbatched logs found.”

## Recommended operating configuration

Support three settings:

```text
ANCHOR_MODE=auto
ANCHOR_MODE=manual
ANCHOR_MODE=both
```

For development, begin with `manual`. It makes testing easier because you control when batches are created.

After confirming Merkle creation, HCS submission and Mirror Node verification, switch to `both`:

* Automatic anchoring handles normal operations.
* Manual sync supports testing, operational recovery and urgent synchronization.

Manual sync should trigger the exact same worker used by auto mode—do not implement two separate anchoring systems.
