Start with four PostgreSQL tables: logs, agent reviews, batches, and batch membership.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    workflow_id UUID,

    actor_type VARCHAR(20) NOT NULL
        CHECK (actor_type IN ('HUMAN', 'AGENT', 'SYSTEM')),

    actor_id VARCHAR(255) NOT NULL,
    action_type VARCHAR(100) NOT NULL,

    resource_type VARCHAR(100),
    resource_id VARCHAR(255),

    status VARCHAR(30) NOT NULL
        CHECK (status IN (
            'STARTED',
            'COMPLETED',
            'FAILED',
            'PENDING_REVIEW',
            'APPROVED',
            'REJECTED',
            'EXPIRED'
        )),

    description TEXT,
    private_data JSONB,

    fabric_transaction_id VARCHAR(255),

    previous_event_hash VARCHAR(64),
    event_hash VARCHAR(64) NOT NULL UNIQUE,

    occurred_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Important columns:

* `tenant_id`: identifies the client that owns the log.
* `workflow_id`: connects multiple logs belonging to one operation.
* `actor_type`: tells whether a human, agent, or system created the event.
* `actor_id`: identifies the human or agent.
* `action_type`: such as `LOT_CREATED`, `DELIVERY_CREATED` or `RECALL_PROPOSED`.
* `resource_type` and `resource_id`: identify the affected lot, delivery or serial-number batch.
* `status`: result or current state of the action.
* `description`: readable summary for users and auditors.
* `private_data`: detailed private information specific to the action.
* `fabric_transaction_id`: links an executed operation to Fabric.
* `event_hash`: deterministic hash used to build the Merkle tree.
* `previous_event_hash`: optionally links logs together for additional tamper evidence.
* `occurred_at`: when the action happened.
* `recorded_at`: when the audit service stored it.

For agent actions, store review information separately:

```sql
CREATE TABLE agent_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    agent_log_id UUID NOT NULL
        REFERENCES audit_logs(id),

    reviewer_id VARCHAR(255),

    status VARCHAR(30) NOT NULL
        CHECK (status IN (
            'PENDING',
            'APPROVED',
            'REJECTED',
            'CHANGES_REQUESTED',
            'EXPIRED'
        )),

    reasoning TEXT,

    review_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    review_due_at TIMESTAMPTZ NOT NULL,
    review_opened_at TIMESTAMPTZ,
    review_completed_at TIMESTAMPTZ
);
```

This stores:

* Which agent action needs review
* Who reviewed it
* Approval or rejection
* Human reasoning
* How long the user was given
* When they opened and completed the review

Human-created actions do not need a record in `agent_reviews`.

Now store each batch:

```sql
CREATE TABLE audit_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,

    merkle_root VARCHAR(64),
    event_count INTEGER NOT NULL DEFAULT 0,

    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'BUILDING'
        CHECK (status IN (
            'BUILDING',
            'READY',
            'SUBMITTED',
            'CONFIRMED',
            'FAILED'
        )),

    hedera_topic_id VARCHAR(100),
    hedera_transaction_id VARCHAR(255),
    hedera_sequence_number BIGINT,
    hedera_consensus_timestamp VARCHAR(50),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ
);
ALTER TABLE audit_batches
ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0,
ADD COLUMN last_error TEXT,
ADD COLUMN last_attempt_at TIMESTAMPTZ,
ADD COLUMN next_retry_at TIMESTAMPTZ,
ADD COLUMN processing_started_at TIMESTAMPTZ,
ADD COLUMN processing_completed_at TIMESTAMPTZ;
```

This stores the Merkle root submitted to Hedera and the receipt needed to verify it later.

Finally, connect individual logs to their batch:

```sql
CREATE TABLE audit_batch_items (
    batch_id UUID NOT NULL
        REFERENCES audit_batches(id),

    audit_log_id UUID NOT NULL UNIQUE
        REFERENCES audit_logs(id),

    leaf_index INTEGER NOT NULL,
    merkle_proof JSONB,

    PRIMARY KEY (batch_id, audit_log_id),
    UNIQUE (batch_id, leaf_index)
);


ALTER TABLE audit_batch_items
ADD COLUMN leaf_hash VARCHAR(64) NOT NULL;
CREATE INDEX IF NOT EXISTS audit_batches_reconciliation_idx
ON audit_batches(status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS audit_batch_items_batch_leaf_idx
ON audit_batch_items(batch_id, leaf_index);


ALTER TABLE audit_batches
ADD COLUMN submission_mode VARCHAR(20) NOT NULL DEFAULT 'SERVICE'
CHECK (submission_mode IN ('SERVICE', 'WALLET'));


```


`leaf_index` records the log’s position in the Merkle tree. `merkle_proof` allows one specific private log to be verified against the root stored on Hedera.

Two examples:

1. A human creates a lot. One `audit_logs` record is created with `actor_type = HUMAN`, `action_type = LOT_CREATED`, the Fabric transaction ID and the resulting event hash. No review is created.

2. An agent recommends a recall. One `audit_logs` record is created with `actor_type = AGENT` and `status = PENDING_REVIEW`. An `agent_reviews` record stores the deadline. After the human approves or rejects it, new audit logs record that decision.

Later, both logs can be included in the same batch and represented by one Merkle root on Hedera.
