CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, workflow_id UUID,
 actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('HUMAN','AGENT','SYSTEM')),
 actor_id VARCHAR(255) NOT NULL, action_type VARCHAR(100) NOT NULL,
 resource_type VARCHAR(100), resource_id VARCHAR(255),
 status VARCHAR(30) NOT NULL CHECK (status IN ('STARTED','COMPLETED','FAILED','PENDING_REVIEW','APPROVED','REJECTED','EXPIRED')),
 description TEXT, private_data JSONB, fabric_transaction_id VARCHAR(255),
 previous_event_hash VARCHAR(64), event_hash VARCHAR(64) NOT NULL UNIQUE,
 occurred_at TIMESTAMPTZ NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_logs_unbatched_idx ON audit_logs(tenant_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS agent_reviews (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), agent_log_id UUID NOT NULL REFERENCES audit_logs(id),
 reviewer_id VARCHAR(255), status VARCHAR(30) NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','CHANGES_REQUESTED','EXPIRED')),
 reasoning TEXT, review_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), review_due_at TIMESTAMPTZ NOT NULL,
 review_opened_at TIMESTAMPTZ, review_completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    idempotency_key VARCHAR(64) NOT NULL UNIQUE,

    merkle_root VARCHAR(64),
    event_count INTEGER NOT NULL DEFAULT 0,

    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,

    status VARCHAR(30) NOT NULL DEFAULT 'BUILDING'
        CHECK (
            status IN (
                'BUILDING',
                'READY',
                'SUBMITTING',
                'SUBMITTED',
                'VERIFYING',
                'CONFIRMED',
                'SUBMISSION_FAILED',
                'VERIFICATION_FAILED',
                'SUBMISSION_UNKNOWN'
            )
        ),

    hedera_topic_id VARCHAR(100),
    hedera_transaction_id VARCHAR(255),
    hedera_sequence_number BIGINT,
    hedera_consensus_timestamp VARCHAR(50),
    wallet_transaction_bytes TEXT,

    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,

    processing_started_at TIMESTAMPTZ,
    processing_completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_batch_items (
 batch_id UUID NOT NULL REFERENCES audit_batches(id), audit_log_id UUID NOT NULL UNIQUE REFERENCES audit_logs(id),
 leaf_index INTEGER NOT NULL, merkle_proof JSONB, PRIMARY KEY(batch_id,audit_log_id), UNIQUE(batch_id,leaf_index),leaf_hash VARCHAR(64) NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_sync_jobs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source VARCHAR(20) NOT NULL CHECK(source IN ('AUTO','MANUAL','RECONCILIATION')),
 status VARCHAR(30) NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','PARTIALLY_COMPLETED','FAILED','SKIPPED')),
 tenant_id UUID, max_events INTEGER, batches_processed INTEGER NOT NULL DEFAULT 0, logs_processed INTEGER NOT NULL DEFAULT 0,
 error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);



CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;




BEGIN;

ALTER TABLE audit_batch_items
ADD COLUMN IF NOT EXISTS
    leaf_hash VARCHAR(64);

UPDATE audit_batch_items i
SET leaf_hash = LOWER(l.event_hash)
FROM audit_logs l
WHERE l.id = i.audit_log_id
  AND i.leaf_hash IS NULL;

ALTER TABLE audit_batch_items
ALTER COLUMN leaf_hash
SET NOT NULL;

ALTER TABLE audit_batches
ADD COLUMN IF NOT EXISTS
    submission_mode VARCHAR(20)
    NOT NULL
    DEFAULT 'SERVICE';

ALTER TABLE audit_batches
ADD COLUMN IF NOT EXISTS
    payer_account_id VARCHAR(100);

ALTER TABLE audit_batches
ADD COLUMN IF NOT EXISTS
    wallet_transaction_bytes TEXT;

ALTER TABLE audit_batches
DROP CONSTRAINT IF EXISTS
    audit_batches_status_check;

ALTER TABLE audit_batches
ADD CONSTRAINT
    audit_batches_status_check
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
        'VERIFICATION_FAILED',
        'SUBMISSION_UNKNOWN'
    )
);

ALTER TABLE audit_batches
DROP CONSTRAINT IF EXISTS
    audit_batches_submission_mode_check;

ALTER TABLE audit_batches
ADD CONSTRAINT
    audit_batches_submission_mode_check
CHECK (
    submission_mode IN (
        'SERVICE',
        'WALLET'
    )
);

CREATE INDEX IF NOT EXISTS
    audit_batches_reconciliation_idx
ON audit_batches (
    status,
    next_retry_at,
    created_at
);

CREATE INDEX IF NOT EXISTS
    audit_batch_items_batch_leaf_idx
ON audit_batch_items (
    batch_id,
    leaf_index
);

COMMIT;

-- Test tenant:
-- 11111111-1111-4111-8111-111111111111
--
-- Test workflow:
-- 22222222-2222-4222-8222-222222222222


-- 1. Human creates a pharmaceutical lot

INSERT INTO audit_logs (
    id,
    tenant_id,
    workflow_id,
    actor_type,
    actor_id,
    action_type,
    resource_type,
    resource_id,
    status,
    description,
    private_data,
    fabric_transaction_id,
    previous_event_hash,
    event_hash,
    occurred_at
)
VALUES (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'HUMAN',
    'user-admin-001',
    'LOT_CREATED',
    'LOT',
    'LOT-TEST-001',
    'COMPLETED',
    'Test pharmaceutical lot created',
    '{
        "lotNumber": "LOT-TEST-001",
        "productCode": "MED-001",
        "quantity": 1000,
        "expiryDate": "2028-12-31"
    }'::jsonb,
    'fabric-tx-test-001',
    NULL,
    encode(
        digest(
            'test-event-001-lot-created',
            'sha256'
        ),
        'hex'
    ),
    NOW() - INTERVAL '20 minutes'
)
ON CONFLICT (id) DO NOTHING;


-- 2. Human generates serial numbers

INSERT INTO audit_logs (
    id,
    tenant_id,
    workflow_id,
    actor_type,
    actor_id,
    action_type,
    resource_type,
    resource_id,
    status,
    description,
    private_data,
    fabric_transaction_id,
    previous_event_hash,
    event_hash,
    occurred_at
)
VALUES (
    '10000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'HUMAN',
    'user-admin-001',
    'SERIAL_NUMBERS_GENERATED',
    'SERIAL_NUMBER_BATCH',
    'SERIAL-BATCH-001',
    'COMPLETED',
    'Generated serial numbers for test lot',
    '{
        "lotNumber": "LOT-TEST-001",
        "startSerial": "SN-000001",
        "endSerial": "SN-001000",
        "totalSerials": 1000
    }'::jsonb,
    'fabric-tx-test-002',
    encode(
        digest(
            'test-event-001-lot-created',
            'sha256'
        ),
        'hex'
    ),
    encode(
        digest(
            'test-event-002-serials-generated',
            'sha256'
        ),
        'hex'
    ),
    NOW() - INTERVAL '18 minutes'
)
ON CONFLICT (id) DO NOTHING;


-- 3. Human creates a delivery

INSERT INTO audit_logs (
    id,
    tenant_id,
    workflow_id,
    actor_type,
    actor_id,
    action_type,
    resource_type,
    resource_id,
    status,
    description,
    private_data,
    fabric_transaction_id,
    previous_event_hash,
    event_hash,
    occurred_at
)
VALUES (
    '10000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'HUMAN',
    'warehouse-user-001',
    'DELIVERY_CREATED',
    'DELIVERY',
    'DELIVERY-TEST-001',
    'COMPLETED',
    'Test delivery created for the lot',
    '{
        "lotNumber": "LOT-TEST-001",
        "destination": "Test Pharmacy Malta",
        "quantity": 100
    }'::jsonb,
    'fabric-tx-test-003',
    encode(
        digest(
            'test-event-002-serials-generated',
            'sha256'
        ),
        'hex'
    ),
    encode(
        digest(
            'test-event-003-delivery-created',
            'sha256'
        ),
        'hex'
    ),
    NOW() - INTERVAL '15 minutes'
)
ON CONFLICT (id) DO NOTHING;


-- 4. Agent recommends a recall

INSERT INTO audit_logs (
    id,
    tenant_id,
    workflow_id,
    actor_type,
    actor_id,
    action_type,
    resource_type,
    resource_id,
    status,
    description,
    private_data,
    fabric_transaction_id,
    previous_event_hash,
    event_hash,
    occurred_at
)
VALUES (
    '10000000-0000-4000-8000-000000000004',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'AGENT',
    'recall-agent-v1',
    'RECALL_PROPOSED',
    'LOT',
    'LOT-TEST-001',
    'PENDING_REVIEW',
    'Agent detected a temperature anomaly and proposed a recall',
    '{
        "riskScore": 0.92,
        "reason": "Temperature exceeded the configured limit",
        "maximumTemperature": 12.4,
        "allowedMaximum": 8.0,
        "evidenceIds": [
            "TEMP-READING-001",
            "TEMP-READING-002"
        ]
    }'::jsonb,
    NULL,
    encode(
        digest(
            'test-event-003-delivery-created',
            'sha256'
        ),
        'hex'
    ),
    encode(
        digest(
            'test-event-004-recall-proposed',
            'sha256'
        ),
        'hex'
    ),
    NOW() - INTERVAL '10 minutes'
)
ON CONFLICT (id) DO NOTHING;


-- Review record for the agent action

INSERT INTO agent_reviews (
    id,
    agent_log_id,
    reviewer_id,
    status,
    reasoning,
    review_created_at,
    review_due_at,
    review_opened_at,
    review_completed_at
)
VALUES (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'compliance-user-001',
    'APPROVED',
    'Temperature evidence confirms the recall recommendation',
    NOW() - INTERVAL '9 minutes',
    NOW() + INTERVAL '51 minutes',
    NOW() - INTERVAL '8 minutes',
    NOW() - INTERVAL '7 minutes'
)
ON CONFLICT (id) DO NOTHING;


-- 5. Human approval is stored as a separate append-only log

INSERT INTO audit_logs (
    id,
    tenant_id,
    workflow_id,
    actor_type,
    actor_id,
    action_type,
    resource_type,
    resource_id,
    status,
    description,
    private_data,
    fabric_transaction_id,
    previous_event_hash,
    event_hash,
    occurred_at
)
VALUES (
    '10000000-0000-4000-8000-000000000005',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'HUMAN',
    'compliance-user-001',
    'RECALL_APPROVED',
    'LOT',
    'LOT-TEST-001',
    'APPROVED',
    'Compliance user approved the agent recall recommendation',
    '{
        "agentLogId": "10000000-0000-4000-8000-000000000004",
        "decision": "APPROVED",
        "reason": "Temperature evidence confirmed"
    }'::jsonb,
    NULL,
    encode(
        digest(
            'test-event-004-recall-proposed',
            'sha256'
        ),
        'hex'
    ),
    encode(
        digest(
            'test-event-005-recall-approved',
            'sha256'
        ),
        'hex'
    ),
    NOW() - INTERVAL '7 minutes'
)
ON CONFLICT (id) DO NOTHING;


-- 6. System executes the approved recall on Fabric

INSERT INTO audit_logs (
    id,
    tenant_id,
    workflow_id,
    actor_type,
    actor_id,
    action_type,
    resource_type,
    resource_id,
    status,
    description,
    private_data,
    fabric_transaction_id,
    previous_event_hash,
    event_hash,
    occurred_at
)
VALUES (
    '10000000-0000-4000-8000-000000000006',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'SYSTEM',
    'recall-execution-service',
    'RECALL_EXECUTED',
    'LOT',
    'LOT-TEST-001',
    'COMPLETED',
    'Approved recall executed successfully',
    '{
        "lotNumber": "LOT-TEST-001",
        "recalledQuantity": 1000,
        "executionSource": "AGENT_RECOMMENDATION"
    }'::jsonb,
    'fabric-tx-test-004',
    encode(
        digest(
            'test-event-005-recall-approved',
            'sha256'
        ),
        'hex'
    ),
    encode(
        digest(
            'test-event-006-recall-executed',
            'sha256'
        ),
        'hex'
    ),
    NOW() - INTERVAL '5 minutes'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
