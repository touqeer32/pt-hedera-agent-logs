# PharmaTrace Agentic Compliance and HCS Audit Architecture

## Abstract

PharmaTrace uses an asynchronous agent-orchestration architecture to validate pharmaceutical records, explain compliance findings, and preserve an auditable history of automated and human decisions. The Admin UI starts an agent run through the orchestrator, while background workers execute the run independently of the browser request. The orchestrator authenticates tenant-scoped MCP servers with Keycloak, authorizes the tools assigned to the agent, retrieves live records from PharmaTrace services, and applies deterministic validation rules before asking the configured language model for contextual assessment. Production runs can use the NVIDIA OpenAI-compatible endpoint; local development can use an Ollama-compatible endpoint.

The backend remains authoritative for compliance state. Deterministic rules identify findings, retain the source evidence and finding identifiers, and group related findings with the relevant profile or source record before the language model reviews them. The model may clarify an assessment and propose an actionable remediation, but it cannot invent source values, rule identifiers, or workflow state. The resulting report contains the record identity, source fingerprint, evidence and report digests, findings, review policy, and the current processing status. A record is not processed repeatedly: the agent selects records with no report or records explicitly returned to `AGENT_REVIEW`, and skips records already pending human review, approved, submitted, attested, or otherwise completed. A reset option exists only for deliberate testing.

The architecture keeps three kinds of observability separate. Agent execution data is stored in the orchestrator through `agent_runs`, `run_steps`, and tool-call records. Operational audit events are written to the dedicated `audit_anchor.audit_logs` store, including agent-run start and completion, MCP tool-call start, completion, and failure, and human report access or decision events. Upstream gateway access logs are a third source and are produced only when traffic passes through that gateway. Therefore, direct calls from an agent to a serial-number, GDTI, recall, or shortage service require explicit instrumentation if detailed source API events are required. Each agent event is tenant-scoped and identifies the agent or run as the actor and workflow.

When an agent creates a report, the system can submit a compact report-created attestation using the configured agent identity. This establishes the report’s origin and is distinct from human approval. Human comments, finding resolutions, overrides, and rejection decisions remain in PostgreSQL as report history; they are not sent to HCS individually. If a human rejects a report or disagrees with its findings, the report is routed to agent review. The agent can accept the human resolution or create a linked, higher-version revision with a new justification. This preserves the complete decision history without producing unnecessary HCS traffic.

Once all required findings are resolved or explicitly overridden, the user can approve the report. The backend creates one deterministic approval snapshot containing the report and evidence digests, finding-state root, history root, action count, approval actor, approval time, and any previous-revision reference. The exact canonical JSON message is stored with the prepared attestation and must remain at or below HCS’s 1,024-byte UTF-8 limit. The UI supplies the connected Hedera payer account to the prepare endpoint; the backend validates and stores that payer and never substitutes the agent account for human approval.

The approval workflow is wallet-paid. The backend prepares the canonical message but does not sign, freeze, or pay for the human transaction. The UI passes the exact message returned by the backend to the connected Hedera wallet, which signs and submits it to the configured network and topic. The UI then sends the real transaction receipt to the backend. The backend verifies the transaction through the Hedera Mirror Node, including transaction success, topic, payer, exact message equality, and agreement with the stored history and finding roots, before marking the attestation and report as confirmed and attested. Audit-log batches follow the same one-message wallet flow using a compact Merkle-root payload.

This design combines deterministic compliance controls, contextual agent reasoning, tenant-scoped MCP access, explainable remediation, immutable operational history, and user-authorized HCS anchoring. It also provides clear failure boundaries: model failures remain agent-run failures, source-service failures remain tool-call failures, audit persistence failures remain operational errors, and HCS or Mirror Node failures prevent attestation rather than being represented as successful compliance.

## Terminology and boundaries

| Area | Authoritative record | Purpose |
|---|---|---|
| Agent execution | `agent_runs`, `run_steps`, tool calls | Plan, execute, retry, and report agent work |
| Compliance | Reports, findings, actions, revisions | Explain and manage review decisions |
| Operational audit | `audit_anchor.audit_logs` | Record who or what accessed or changed the system |
| HCS attestation | Report or audit attestation | Anchor one canonical snapshot on Hedera |
| Mirror verification | Backend verification state | Confirm the submitted topic, payer, message, and digest |

