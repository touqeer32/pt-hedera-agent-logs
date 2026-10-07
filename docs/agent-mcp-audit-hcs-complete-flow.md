# PharmaTrace Agent, MCP, Audit Logs, and HCS Flow

## 1. System roles

| Component | Responsibility |
|---|---|
| Admin UI | Creates agent runs, displays progress/reports, collects human decisions, and submits HCS messages through the connected wallet. |
| Agent Orchestrator | Queues and executes agent runs, authenticates MCP servers, invokes tools, creates reports, and stores workflow state. |
| LLM provider | Produces the execution plan and reviews deterministic findings. NVIDIA is used in production; local Ollama can be used for development. |
| MCP server | Exposes PharmaTrace tools such as profile, recall, shortage, lot, and Hedera operations. |
| PharmaTrace services | Return source records and perform domain operations. |
| PostgreSQL | Stores agents, runs, steps, reports, findings, comments, decisions, attestations, and history snapshots. |
| Audit database | Stores immutable operational audit events in `audit_anchor.audit_logs`. |
| HCS | Stores the final immutable report or audit-batch proof submitted by a wallet. |
| Mirror Node | Verifies transaction status, topic, message, payer, sequence number, and consensus timestamp. |

## 2. Agent run initiated from the UI

The UI calls:

```http
POST /api/v1/agents/{agentId}/run
```

Required request context:

```http
x-tenant-id: <tenant UUID>
x-user-id: <user UUID>
x-service-api-key: <service key>
```

The backend creates an `agent_runs` row:

```text
QUEUED
```

The HTTP request returns a `runId`. The actual work is asynchronous and is performed by `ExecutionWorker`.

## 3. Background execution lifecycle

```text
UI creates run
    |
    v
agent_runs = QUEUED
    |
    v
ExecutionWorker claims run
    |
    v
PLANNING
    |
    +--> LLM planner creates execution plan
    |
    v
EXECUTING
    |
    +--> MCP authentication with Keycloak
    |
    +--> MCP tool authorization check
    |
    +--> MCP tool execution
    |
    v
GENERATING
    |
    +--> LLM reviews deterministic findings
    |
    +--> Backend persists the authoritative report
    |
    v
COMPLETED or FAILED
```

The UI polls:

```http
GET /api/v1/agents/{agentId}/runs/{runId}
GET /api/v1/agents/{agentId}/runs/{runId}/tool-calls
```

## 4. MCP and Keycloak flow

Before a protected MCP or PharmaTrace request:

1. The orchestrator resolves the tenant-owned MCP server.
2. `KeycloakAuthService` obtains or reuses an access token.
3. The token is sent as `Authorization: Bearer <token>`.
4. Tenant headers are sent when required:

```http
tenantid: <tenant UUID>
x-tenant-id: <tenant UUID>
```

5. The MCP server or GraphQL service processes the request.
6. On HTTP `401` or `403`, the token is invalidated and the request fails clearly.

The LLM does not receive credentials. It only selects an authorized tool and supplies tool arguments.

## 5. Tool execution and source records

The orchestrator performs these checks before execution:

- The tool is enabled.
- The tool is authorized for the agent.
- The input matches the stored JSON schema.
- The run has not been cancelled.
- The tool-call limit has not been exceeded.

Examples:

```text
run_serial_profile_compliance
run_sscc_profile_compliance
run_gdti_profile_compliance
run_recall_pattern_compliance
run_shortage_pattern_compliance
list_batch_lots
push_lots_to_hedera
```

The profile and pattern tools retrieve real source data, select records that are eligible for processing, run deterministic validations, and then pass grouped evidence to the LLM for contextual review.

## 6. Duplicate prevention and reprocessing

Before creating a report, the backend finds the latest report for the same:

```text
tenant_id + agent_type + record_type + record_id
```

The latest version is selected by:

```sql
ORDER BY report_version DESC, created_at DESC
```

Normal behavior:

| Latest status | Agent behavior |
|---|---|
| No report | Process the record. |
| `PENDING_REVIEW` | Skip. |
| `HUMAN_REVIEW` | Skip. |
| `APPROVED` | Skip. |
| `READY_FOR_WALLET` | Skip. |
| `SUBMITTED` | Skip. |
| `ATTESTED` | Skip. |
| `REJECTED` | Skip until explicitly returned to `AGENT_REVIEW`. |
| `AGENT_REVIEW` | Process again because a human returned it to the agent. |

`resetReports=true` is reserved for deliberate testing and forces a new evaluation.

## 7. Agent-run logs and audit logs

These are separate records.

### Agent execution records

Stored in the orchestrator database:

- `agent_runs`
- `run_steps`
- tool-call payloads and results
- planner output
- final response
- token counts and error details

### Operational audit records

Stored in the dedicated `audit_anchor` database table `audit_logs`.

The orchestrator emits at least:

```text
AGENT_RUN_STARTED
MCP_TOOL_CALL_STARTED
MCP_TOOL_CALL_COMPLETED
MCP_TOOL_CALL_FAILED
AGENT_RUN_COMPLETED
AGENT_RUN_FAILED
```

Typical event fields:

```json
{
  "tenant_id": "tenant-uuid",
  "workflow_id": "agent-run-uuid",
  "actor_type": "AGENT",
  "actor_id": "agent-uuid",
  "action_type": "MCP_TOOL_CALL_COMPLETED",
  "resource_type": "MCP_TOOL",
  "resource_id": "run_gdti_profile_compliance",
  "status": "COMPLETED",
  "previous_event_hash": "...",
  "event_hash": "..."
}
```

Human report access and decisions also create audit events:

```text
COMPLIANCE_REPORT_LISTED
COMPLIANCE_REPORT_VIEWED
COMPLIANCE_REPORT_APPROVED
COMPLIANCE_REPORT_REJECTED
```

Direct source-service calls and UI gateway calls are different. UI calls through the gateway may be logged by gateway middleware. Direct agent calls to serial-profile or GDTI services must be instrumented separately if detailed source API events such as `getAllProfiles` are required.

## 8. Report creation

The backend, not the LLM, owns the authoritative report structure:

- report ID and version
- agent type and record type
- source record ID and source system
- record fingerprint
- report digest and evidence digest
- finding IDs
- rule IDs, fields, evidence, severity, and remediation
- review policy and status

The LLM receives deterministic findings grouped with the relevant profile, rules, and evidence. It may provide:

```json
{
  "findingId": "uuid",
  "assessment": "CONFIRMED|DISPUTED|NEEDS_CONTEXT",
  "comment": "Meaningful explanation",
  "instruction": "Exact A -> B remediation when applicable"
}
```

The backend preserves finding IDs and rejects invented rule IDs, fields, values, or actions.

## 9. Initial agent-created HCS attestation

When an agent creates a report, the existing agent-created attestation may be submitted using the configured agent Hedera signer. This proves that the report originated from the agent.

This is separate from human approval.

The agent-created transaction should contain a compact report-created payload that remains below 1,024 UTF-8 bytes.

## 10. Human review actions

Human comments, finding resolutions, overrides, and rejection decisions are stored in PostgreSQL:

- `compliance_action_events`
- `compliance_findings`
- `compliance_decisions`
- report revision references

They are not submitted as individual HCS messages.

If a user rejects or disagrees with a report, the report moves to `AGENT_REVIEW`. The agent can agree or create a linked revised report with a higher version.

## 11. Approval snapshot

After all required findings are resolved or explicitly overridden, the user approves the report.

The backend builds one deterministic history snapshot containing:

```json
{
  "version": 1,
  "type": "COMPLIANCE_REPORT_APPROVED",
  "reportId": "report-uuid",
  "reportVersion": 1,
  "reportDigest": "sha256",
  "evidenceDigest": "sha256",
  "historyMerkleRoot": "sha256",
  "findingStateRoot": "sha256",
  "actionCount": 12,
  "approvedBy": "user-uuid",
  "approvedAt": "2026-10-07T12:00:00.000Z"
}
```

The exact serialized JSON string is stored on the prepared attestation and must be the same string submitted to HCS.

## 12. Human wallet preparation

The UI calls:

```http
POST /api/v1/compliance/reports/{reportId}/wallet/prepare
```

Request:

```json
{
  "payerAccountId": "0.0.10310420"
}
```

Response:

```json
{
  "attestationId": "uuid",
  "payerAccountId": "0.0.10310420",
  "topicId": "0.0.10905811",
  "message": "{\"version\":1,\"type\":\"COMPLIANCE_REPORT_APPROVED\",...}",
  "historyMerkleRoot": "sha256",
  "findingStateRoot": "sha256",
  "actionCount": 12,
  "status": "READY_FOR_WALLET"
}
```

The backend does not:

- use `AGENT_HEDERA_ACCOUNT_ID` as the human payer;
- use an operator key for human approval;
- freeze a transaction;
- return `transactionBytes`;
- pay HBAR for the human approval.

## 13. Wallet submission and verification

The UI passes the exact returned `message` unchanged to the Hedera wallet/Snap:

```text
connected wallet signs and pays
    |
    v
HCS topic receives the JSON message
    |
    v
UI calls /wallet/submitted
```

Callback:

```http
POST /api/v1/compliance/reports/{reportId}/wallet/submitted
```

```json
{
  "attestationId": "uuid",
  "transactionId": "0.0.10310420@...",
  "topicId": "0.0.10905811",
  "sequenceNumber": "23",
  "consensusTimestamp": "..."
}
```

The backend then verifies through Mirror Node:

1. The transaction exists and succeeded.
2. The transaction belongs to the configured HCS topic.
3. The payer matches the prepared payer.
4. The HCS message exactly equals the stored canonical `message`.
5. The stored history and finding roots match the prepared snapshot.
6. The attestation becomes `CONFIRMED`.
7. The report becomes `ATTESTED`.

## 14. Audit-batch HCS flow

Audit logs are grouped into a batch and represented by a Merkle root.

Preparation returns one canonical JSON message:

```json
{
  "version": 1,
  "batchId": "batch-uuid",
  "merkleRoot": "sha256-root",
  "hashAlgorithm": "SHA-256",
  "eventCount": 8
}
```

The audit wallet flow is also wallet-paid:

```text
POST /api/v1/audit-anchor/wallet/prepare
    |
    v
UI receives payerAccountId, topicId, and message
    |
    v
Wallet signs and submits the unchanged message
    |
    v
POST /api/v1/audit-anchor/wallet/{batchId}/submitted
    |
    v
Mirror Node verifies topic, payer, message, sequence, and Merkle root
```

No backend operator key is used for this wallet flow.

## 15. Important status transitions

### Report

```text
PENDING_REVIEW
    -> HUMAN_REVIEW
    -> APPROVED
    -> READY_FOR_WALLET
    -> VERIFYING
    -> ATTESTED
```

Alternative paths:

```text
HUMAN_REVIEW -> AGENT_REVIEW
AGENT_REVIEW -> HUMAN_REVIEW
AGENT_REVIEW -> new report revision
```

### Attestation

```text
PREPARED
    -> SUBMITTED
    -> VERIFYING
    -> CONFIRMED
```

Message mismatch, wrong topic, wrong payer, or failed Mirror verification produces `FAILED` / `VERIFICATION_FAILED` and never marks the report as attested.

## 16. Operational verification

Check an agent run:

```http
GET /api/v1/agents/{agentId}/runs/{runId}
GET /api/v1/agents/{agentId}/runs/{runId}/tool-calls
```

Check compliance reports:

```http
GET /api/v1/compliance/reports?limit=50&offset=0
GET /api/v1/compliance/reports/{reportId}
GET /api/v1/compliance/reports/{reportId}/verify
```

Check audit events in `audit_anchor`:

```sql
SELECT actor_type, actor_id, workflow_id, action_type,
       resource_type, resource_id, status, occurred_at
FROM audit_logs
WHERE tenant_id = '<tenant-uuid>'
ORDER BY occurred_at DESC;
```

The orchestrator needs the dedicated audit connection:

```ini
AUDIT_DB_HOST=serialization-pg16.remote-systems.svc.cluster.local
AUDIT_DB_PORT=5432
AUDIT_DB_NAME=audit_anchor
AUDIT_DB_USER=postgres
AUDIT_DB_PASSWORD=<secret>
AUDIT_DB_SSL_MODE=disable
```
