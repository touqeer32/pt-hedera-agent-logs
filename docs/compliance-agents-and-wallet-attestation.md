# Compliance Agents and UI-Wallet Attestation

## Purpose

Add compliance-focused agents that inspect PharmaTrace data, produce evidence-based reports, and allow an authorized user to review and sign an approved report through the existing UI-wallet and Hedera flow.

Agents analyze data and recommend actions. They do not silently change business records or sign transactions. Mutations and HCS publication require explicit authorization and a connected wallet.

## Document structure

This document contains the shared architecture and controls used by every compliance agent: report lifecycle, issue fingerprints, evidence and digest rules, UI review, approval, wallet signing, HCS attestation, Mirror Node verification, security, and common APIs.

Agent-specific rules are maintained separately so each agent can evolve without changing the shared control model:

- [Serial profile agent](./compliance-agents/serial-profile-agent.md)
- [Serial generation and collision agent](./compliance-agents/serial-collision-agent.md)
- [Audit lifecycle anomaly agent](./compliance-agents/audit-anomaly-agent.md)
- [Timing and workflow agent](./compliance-agents/timing-workflow-agent.md)
- [Lot compliance agent](./compliance-agents/lot-compliance-agent.md)
- [Shortage analysis agent](./compliance-agents/shortage-analysis-agent.md)
- [Recall and return agent](./compliance-agents/recall-return-agent.md)

## Agent suite

### Serial number profile verification

Checks serial-number profiles against a configured GS1 rule set and rule version. It checks required fields, Application Identifier structure, length and character rules, prefixes, check digits, uniqueness scope, tenant ownership, product/lot/expiration relationships, and profile completeness.

Output:

- PASS, FAIL, or REVIEW
- Rule-set version and failed rule identifiers
- Evidence references, severity, impact, and corrective comments

A failed result must include an improvement comment, for example:

> The serial profile does not satisfy the configured GS1 check-digit rule. Recalculate the check digit and validate the prefix before enabling this profile.

GS1 rules must be versioned and configurable. The agent must not claim compliance with an unspecified standard version.

### Serial-number generation and collision detection

Detects duplicate or unsafe serial-number generation:

- Duplicate serial numbers within a tenant
- Reuse across products or lots
- Reuse after void, recall, or retirement
- Concurrent-generation collisions
- Numbers generated but never assigned
- Numbers assigned to more than one item
- Gaps or unexpected sequence patterns
- Conflicts between database and on-chain records

Output includes a provider/client bug report, conflicting numbers, ownership history, affected product/lot/item/actor, recommended quarantine action, and a DO NOT USE list.

A conflict cannot be marked resolved without an authorized user action. Resolution requires a comment, backend persistence, wallet signing, and an HCS attestation.

### Audit anomaly detection

Finds suspicious or inconsistent activity:

- Serial number generated but never used
- Attempt to use a serial number that does not exist
- Repeated failed use attempts
- Item creation without a matching serial-generation event
- Delivery without item creation
- Invalid status transitions
- Actor, tenant, or location mismatch
- Broken event timing or hash relationships

The report includes the event chain, affected records, actor, tenant, location, timestamps, and why the activity is suspicious.

### Timing and workflow analysis

Checks event timing and workflow order, including generation-to-delivery intervals, delivery before item creation, recall before activation, and multiple actions from different locations at the same timestamp.

Rules are configurable by event type and workflow. Results are classified as EXPECTED, REQUIRES_JUSTIFICATION, SUSPICIOUS, or INVALID_SEQUENCE.

### Lot compliance

Checks expired or soon-to-expire lots, invalid dates, missing product/drug/site, inconsistent item counts, pending items, recall/delivery inconsistencies, missing anchors, duplicate lot keys, and duplicate Merkle roots.

Findings are grouped by lot, product, manufacturing site, severity, and recommended action.

### Shortage analysis

Analyzes open, resolved, and overdue shortages, comments, responsible actors, repeated shortages by product/lot/site/warehouse/region, resolution time, reopened shortages, and shortages without supporting delivery or inventory events.

Output includes trends, affected locations, unresolved items, and recommended actions.

### Recall and return analysis

Analyzes recalled products and lots, return-to-site status, recalled versus returned quantities, verifier identity, missing evidence, digital-signature requirements, signature completion, repeated recall sites/products, deliveries after recall, and recall closure completeness.

The report separates recall identified, return required, return received, return verified, digital signature required, digital signature completed, and recall resolved.

## Common report model

Every agent returns a common report:

~~~json
{
  "reportId": "uuid",
  "agentType": "SERIAL_PROFILE",
  "tenantId": "uuid",
  "status": "PASS|FAIL|REVIEW",
  "severity": "INFO|LOW|MEDIUM|HIGH|CRITICAL",
  "ruleSetVersion": "configured-version",
  "summary": "Short conclusion",
  "findings": [
    {
      "findingId": "uuid",
      "status": "PASS|FAIL|REVIEW",
      "severity": "MEDIUM",
      "title": "Duplicate serial number",
      "comment": "Do not use this serial number until ownership is resolved.",
      "recommendation": "Quarantine the later assignment and issue a replacement.",
      "evidence": [
        {
          "entityType": "serial_number",
          "entityId": "uuid",
          "eventId": "uuid",
          "field": "serialNumber",
          "observedValue": "masked-or-authorized-value"
        }
      ]
    }
  ],
  "counts": { "pass": 0, "fail": 0, "review": 0 },
  "requiresApproval": true
}
~~~

Reports reference evidence IDs instead of copying sensitive payloads into prompts or HCS.

## Architecture flow

~~~text
User selects compliance agent
        ↓
Backend creates agent run
        ↓
Agent authenticates and reads authorized data tools
        ↓
Agent validates records and creates findings
        ↓
Backend stores report, findings, evidence, and audit event
        ↓
UI displays PASS / FAIL / REVIEW report
        ↓
User reviews findings and adds comments
        ↓
User approves or rejects report
        ↓
Backend prepares canonical attestation and unsigned HCS bytes
        ↓
Connected UI wallet signs and submits to HCS
        ↓
Backend records actual Hedera transaction details
        ↓
Mirror Node verification
        ↓
Report becomes ATTESTED or remains SUBMITTED
~~~

## UI changes

### Compliance dashboard

Add agent selection, tenant/date filters, product/lot/site/location/severity filters, run status, report status, open-finding count, reports awaiting approval, reports awaiting signature, and attested/failed report counts.

### Agent run screen

Show agent name, purpose, run ID, data scope, timestamps, MCP tools used, tool-call status, findings, evidence, errors, retry action, and final report.

Distinguish:

~~~text
Analysis completed
Report approved
Signature pending
Submitted to HCS
Confirmed on HCS
~~~

### Finding detail

Show rule ID/version, severity, affected entity, evidence timeline, current status, agent comment, recommendation, user comment, and resolve/reject/defer actions.

For serial conflicts, show a prominent DO NOT USE warning.

### Approval and wallet signing

The UI must not sign automatically.

1. User opens the report.
2. UI loads the report and findings.
3. User reviews high and critical findings.
4. User enters or confirms a resolution comment.
5. User selects Approve and sign.
6. Backend creates the canonical attestation and unsigned HCS transaction bytes.
7. UI displays the report summary and digest.
8. Connected wallet signs and submits.
9. UI sends actual transaction details to the backend.
10. UI polls verification and displays the HCS link.

Approval should be disabled while critical findings remain unresolved unless the user has explicit override permission.

## Proposed APIs

These are additions to the current agent and audit-anchor APIs.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /compliance-agents/runs | Start a compliance analysis |
| GET | /compliance-agents/runs/{runId} | Read run status and report |
| GET | /compliance-agents/reports/{reportId} | Read report and findings |
| POST | /compliance-agents/reports/{reportId}/findings/{findingId}/comment | Add an authorized comment |
| POST | /compliance-agents/reports/{reportId}/approve | Approve report for signing |
| POST | /compliance-agents/reports/{reportId}/reject | Reject report |
| POST | /compliance-agents/reports/{reportId}/resolve | Resolve a finding |
| POST | /compliance-agents/reports/{reportId}/wallet/prepare | Prepare unsigned HCS attestation |
| POST | /compliance-agents/reports/{reportId}/wallet/submitted | Store wallet transaction details |
| GET | /compliance-agents/reports/{reportId}/verify | Verify attestation through Mirror Node |

Wallet endpoints reuse the existing audit-anchor conventions: Base64 unsigned transaction bytes, report ID, transaction ID, topic ID, sequence number, consensus timestamp, SUBMITTED to CONFIRMED reconciliation, and transaction-ID normalization.

## HCS attestation

HCS stores only a compact canonical attestation. It must not contain raw audit logs, private data, credentials, or complete evidence payloads.

~~~json
{
  "version": 1,
  "type": "COMPLIANCE_REPORT_ATTESTATION",
  "reportId": "uuid",
  "tenantId": "uuid",
  "agentType": "SERIAL_COLLISION",
  "reportStatus": "FAIL",
  "findingCount": 3,
  "criticalFindingCount": 1,
  "reportDigest": "sha256-hex",
  "evidenceDigest": "sha256-hex",
  "ruleSetVersion": "configured-version",
  "approvedBy": "user-uuid",
  "approvalCommentDigest": "sha256-hex",
  "approvedAt": "timestamp"
}
~~~

The backend creates the payload and unsigned transaction. The UI wallet signs and pays. The backend verifies the expected report ID and digest through Mirror Node.

## Signing states

~~~text
DRAFT → ANALYSIS_RUNNING → REPORT_READY → APPROVAL_REQUIRED
      → APPROVED → READY_FOR_WALLET → SUBMITTED
      → WAITING_FOR_CONFIRMATION → ATTESTED
~~~

Failure states are ANALYSIS_FAILED, APPROVAL_REJECTED, SIGNATURE_REJECTED, SUBMISSION_UNKNOWN, and VERIFICATION_FAILED.

Reconcile uncertain submissions through Mirror Node before retrying. Do not create a second attestation for the same approved report without an explicit new report version.

## Audit and security requirements

Create an audit event for agent run started/completed, finding creation, comments, finding resolution, report approval/rejection, wallet signing, wallet submission, and HCS confirmation.

Each event includes tenant, actor, action, report ID, finding ID where applicable, timestamp, and correlation ID.

Agent credentials and contract private keys remain backend-only. The UI wallet signs only prepared transaction bytes. HCS contains a digest and summary, not private audit data. Critical findings require explicit approval. Mutations are idempotent. Approved report versions are immutable. Resolution comments are preserved. Tool calls, outputs, and errors are retained. Tenant identity is checked against every evidence record.

## Implementation order

1. Define report, finding, evidence, approval, and attestation tables.
2. Add the common report schema and agent result contract.
3. Implement read-only compliance agents.
4. Add run and report APIs.
5. Add comments and resolution workflow.
6. Add report approval rules.
7. Add wallet prepare/submitted/verify endpoints using the existing HCS flow.
8. Add dashboard, report details, finding resolution, and wallet signing UI.
9. Add Mirror Node reconciliation.
10. Test duplicates, expired lots, suspicious timing, shortage resolution, recall returns, wallet rejection, duplicate submission, and delayed Mirror Node indexing.


## Actors and responsibilities

| Actor | Responsibility |
| --- | --- |
| Compliance user | Selects an agent, reviews findings, adds comments, approves or rejects the report, and signs approved attestations |
| Compliance agent | Reads authorized records, applies rules, correlates events, and produces findings |
| Orchestrator | Authenticates MCP access, runs tools, stores run status, and records tool results |
| PharmaTrace APIs | Provide serial, item, lot, delivery, shortage, recall, and audit data |
| Compliance backend | Stores reports, evidence references, comments, approvals, and attestation state |
| UI wallet | Signs and pays the prepared Hedera transaction |
| Hedera HCS / contract | Stores the public attestation or executes the approved contract mutation |
| Mirror Node | Confirms transaction result, consensus timestamp, and public message content |

The agent is not the approver. The wallet is not the report generator. The backend is responsible for producing the canonical payload that the user signs.

## Detailed interaction flow

### A. Start an analysis

~~~text
User → UI: Select agent and scope
UI → Backend: POST /compliance-agents/runs
Backend → Database: Create run with tenant, actor, scope, and rule-set version
Backend → Orchestrator: Queue run
Orchestrator → Keycloak: Authenticate before MCP calls
Keycloak → Orchestrator: Access token
Orchestrator → MCP/API: Execute authorized read tools
MCP/API → Orchestrator: Return records and pagination
Orchestrator → Database: Store tool calls and results
Agent → Orchestrator: Produce report and findings
Orchestrator → Database: Store report and evidence references
Backend → UI: Report is ready
~~~

The run must fail before tool execution if authentication, tenant authorization, or tool authorization fails.

### B. Review findings

~~~text
User → UI: Open report
UI → Backend: GET /compliance-agents/reports/{reportId}
Backend → Database: Load report, findings, evidence, and comments
Database → Backend: Return report
Backend → UI: Display findings and recommendations
User → UI: Add comment, resolve, reject, or defer finding
UI → Backend: Save comment/action
Backend → Database: Store immutable finding history
Backend → Audit log: Record user action
Backend → UI: Return updated finding status
~~~

A finding history must preserve the original agent result. User comments and later resolutions are additional records, not replacements.

### C. Approve and prepare an attestation

~~~text
User → UI: Select Approve and sign
UI → Backend: POST /compliance-agents/reports/{reportId}/approve
Backend → Database: Check report version and approval permissions
Backend → Backend: Check unresolved critical findings
Backend → Backend: Canonicalize report summary and evidence references
Backend → Backend: Calculate reportDigest and evidenceDigest
Backend → Database: Store approval and immutable report version
Backend → Audit log: Record approval
Backend → Backend: Build HCS attestation message
Backend → Backend: Build unsigned transaction bytes
Backend → UI: Return READY_FOR_WALLET and transactionBytes
~~~

The backend must reject approval when the report is already attested, the report version changed, the user lacks permission, or unresolved critical findings require an override.

### D. Sign and confirm through the existing wallet flow

~~~text
UI → Wallet: Decode transactionBytes
UI → Wallet: Request user confirmation
Wallet → Hedera: Sign and submit
Hedera → Wallet: Return transaction ID
Wallet → UI: Return transaction ID
UI → Backend: POST /reports/{reportId}/wallet/submitted
Backend → Database: Store transaction ID and SUBMITTED state
Backend → Mirror Node: Search for transaction/message
Mirror Node → Backend: Return SUCCESS, sequence, and consensus timestamp
Backend → Backend: Compare reportDigest and reportId
Backend → Database: Store confirmation and ATTESTED state
Backend → UI: Return confirmed status and HashScan link
~~~

The UI must send the actual transaction ID returned by the wallet. It must never construct a transaction ID from the prepared ID.

### E. Reject or resolve a finding

~~~text
User → UI: Select Reject or Resolve
UI → Backend: Send action, comment, and finding version
Backend → Backend: Check authorization and current version
Backend → Database: Store action and comment
Backend → Audit log: Record action
Backend → UI: Return updated report status
~~~

Resolving a collision must include a remediation action, such as quarantine, replacement serial, reassignment, or accepted exception. An accepted exception requires a reason and an authorized approver.

## Use cases

### Use case 1: GS1 serial profile passes

Preconditions:

- Serial profile exists
- GS1 rule-set version is configured
- Agent has read access to profile and related product data

Flow:

1. User starts Serial Profile Verification.
2. Agent loads the profile and related product/lot data.
3. Agent validates each configured GS1 rule.
4. Agent stores passing rule results and evidence references.
5. Agent generates a PASS report.
6. UI shows the report as informational.
7. User may approve and attest the result if an attestation is required.

Expected result:

- No corrective action is required.
- The report records the rule-set version and evidence digest.
- Optional wallet attestation can prove the result at a specific time.

### Use case 2: GS1 serial profile fails

Flow:

1. Agent detects a format, prefix, or check-digit failure.
2. Agent creates a HIGH or CRITICAL finding.
3. Agent generates a specific improvement comment.
4. UI displays the failed field, rule ID, observed value, and recommendation.
5. User sends the result to the provider/client or creates an internal remediation task.
6. User cannot approve a compliant attestation while the critical finding remains unresolved.
7. After correction, the agent is run again.
8. The new report references the previous report and shows the corrected result.

Expected result:

- The original failed report remains immutable.
- The corrected report is a new version.
- The UI shows both the failure and the later pass.

### Use case 3: Duplicate serial number

Flow:

1. Collision agent finds the same serial assigned to two items.
2. Agent identifies the first assignment, later assignment, products, lots, timestamps, and actors.
3. Agent creates a DO NOT USE finding.
4. Backend creates a provider/client bug report.
5. UI blocks normal resolution until a user selects a remediation action.
6. User quarantines the conflicting item and adds a comment.
7. Backend records the resolution and marks the serial as restricted.
8. User approves the resolution attestation.
9. UI wallet signs the attestation.
10. Backend verifies it on HCS.

Expected result:

- Conflicted serial is unavailable for new operations.
- The report contains the conflict evidence and resolution history.
- The public HCS message contains only the report and evidence digests.

### Use case 4: Generated serial never used

Flow:

1. Audit agent finds a generation event with no later assignment or item event.
2. Agent checks the configured expiration window for unused numbers.
3. Agent classifies the item as unused, expired-unused, or suspicious.
4. UI shows the generator, location, time, and current serial status.
5. User chooses retain, void, quarantine, or investigate.
6. Backend stores the action and comment.
7. A later agent run confirms whether the serial was handled.

Expected result:

- The system distinguishes an unused number from an invalid number.
- The user receives a clear action recommendation.
- The original generation event remains auditable.

### Use case 5: Invalid serial usage attempt

Flow:

1. Audit agent finds an attempted use of a serial that does not exist.
2. Agent correlates actor, endpoint, IP/device metadata, location, and time.
3. Agent checks for repeated attempts or related successful events.
4. UI displays a suspicious-activity finding.
5. User can escalate, assign an investigation, or close as an authorized test.
6. Any closure requires a comment and user identity.

Expected result:

- Suspicious attempts are visible without modifying the original audit event.
- Repeated attempts can be grouped into one incident.

### Use case 6: Suspicious timing

Flow:

1. Timing agent finds serial generation at 10:00:00 and delivery at 10:00:02.
2. Agent applies the configured minimum workflow interval.
3. Agent checks whether both events came from the same trusted automated process.
4. If justified by an approved automation, result is REQUIRES_JUSTIFICATION.
5. Otherwise, result is SUSPICIOUS.
6. User adds a justification or opens an investigation.
7. The decision is recorded and can be attested.

Expected result:

- The agent does not declare fraud from timing alone.
- Context and justification are preserved.

### Use case 7: Expired lot

Flow:

1. Lot agent loads expiration, status, inventory, delivery, and recall data.
2. Agent identifies an expired lot that remains active or deliverable.
3. Agent creates a CRITICAL finding.
4. UI displays affected lot, product, site, item count, and deliveries after expiration.
5. User starts quarantine or corrective workflow.
6. Approval of a pass attestation is blocked until the finding is resolved or explicitly overridden.

Expected result:

- Expired inventory is clearly identified.
- The report distinguishes expired but unused from expired and delivered.

### Use case 8: Shortage hotspot

Flow:

1. Shortage agent loads shortage records for the requested period.
2. Agent groups shortages by site, warehouse, product, and region.
3. Agent calculates counts, repeat rate, average resolution time, and overdue rate.
4. UI displays the highest-frequency locations and unresolved cases.
5. User opens a location detail view and reviews comments and history.
6. A signed report can attest the analysis snapshot.

Expected result:

- The report identifies where shortages occur most frequently.
- It does not change inventory or shortage status automatically.

### Use case 9: Recall return verification

Flow:

1. Recall agent identifies a recalled product or lot.
2. Agent loads recall, item, delivery, return, verification, and signature records.
3. Agent compares recalled quantity with returned quantity.
4. Agent identifies missing site verification or missing digital signature.
5. UI shows each affected item and return state.
6. User requests return verification or digital signing.
7. Backend stores the verification action.
8. UI wallet signs the attestation when required.
9. Backend confirms the HCS attestation.

Expected result:

- Recall closure is blocked when required returns or signatures are missing.
- Repeated recall sites and products are reported for management review.

## Mutation boundaries

The agent may perform read operations during analysis. Write operations are separated into explicit, auditable actions:

| Operation | Initiator | Confirmation |
| --- | --- | --- |
| Create report | Agent/backend | Automatic after successful analysis |
| Add comment | User/UI | Backend authorization |
| Resolve finding | User/UI | Backend authorization and comment |
| Quarantine or restrict serial | Backend business API | Authorized user action |
| Approve report | User/UI | Permission and finding checks |
| Publish attestation | UI wallet | User wallet signature |
| Confirm HCS result | Backend | Mirror Node verification |

An agent must not directly approve its own report, mark a finding resolved without a user action, or publish an HCS message without an approval record.

## Retry and failure interactions

### MCP or authentication failure

~~~text
Agent → Keycloak/MCP: Request token or data
Keycloak/MCP → Agent: Error
Agent → Database: Store failed step and error
Agent → UI: ANALYSIS_FAILED
User → UI: Retry
~~~

Retry creates a new run linked to the previous run. It does not erase the failed run.

### Wallet rejection

~~~text
UI → Wallet: Request signature
User → Wallet: Reject
Wallet → UI: Rejected
UI → Backend: Record SIGNATURE_REJECTED
Backend → UI: Report remains APPROVED
~~~

The user can retry signing without rerunning analysis, provided the report version and transaction bytes remain valid.

### Unknown submission result

~~~text
Wallet → UI: Timeout or missing callback
UI → Backend: SUBMISSION_UNKNOWN
Backend → Mirror Node: Search by payer/topic/time/report digest
Mirror Node → Backend: Found or not found
Backend → UI: ATTESTED or safe-to-retry
~~~

The UI must not immediately submit a second transaction after losing the wallet callback.

### HCS verification failure

If the transaction exists but the report digest does not match, the report becomes VERIFICATION_FAILED. The backend must preserve the transaction and evidence for investigation and must not silently mark the report as attested.

## Diagram-ready summary

~~~text
ANALYZE
  User selects agent
      ↓
  Authenticate and read data
      ↓
  Apply rules and correlate events
      ↓
  Store report and findings

REVIEW
  User reviews evidence
      ↓
  Add comments or resolve findings
      ↓
  Approve or reject report

ATTEST
  Backend canonicalizes report
      ↓
  Backend prepares unsigned HCS bytes
      ↓
  UI wallet signs and submits
      ↓
  Backend verifies with Mirror Node
      ↓
  Report is ATTESTED
~~~


## Serial profile report and HCS proof plan

Every serial profile validation creates an immutable report, whether the result is PASS, FAIL, or REVIEW. Approval is not required to create the report. Approval is required only when policy requires a user decision, remediation, override, or final decision attestation.

### Serial profile interaction

~~~text
User or schedule selects serial profile
        ↓
Backend creates analysis run
        ↓
Agent authenticates and loads profile, product, lot, tenant, and rule data
        ↓
Agent validates the profile against the configured GS1-oriented rule set
        ↓
Agent creates PASS, FAIL, or REVIEW result
        ↓
Backend creates report ID and report version
        ↓
Backend calculates issue fingerprint
        ↓
Backend canonicalizes report and evidence
        ↓
Backend calculates reportDigest and evidenceDigest
        ↓
Backend stores report, findings, evidence manifest, and affected-record links
        ↓
Backend prepares COMPLIANCE_REPORT_CREATED HCS payload
        ↓
Configured signer submits the digest-only HCS message
        ↓
Backend stores transaction details
        ↓
Mirror Node verifies message and digests
        ↓
Report becomes HCS_RECEIPT_CONFIRMED
        ↓
If required, user reviews and records a decision
        ↓
UI wallet signs the decision attestation
~~~

### Report creation rules

A report is created for:

- A new profile validation
- A materially changed profile
- A changed GS1 rule-set version
- A user-requested validation
- A recurring validation due under policy
- A recurring or changed failure

A scheduled run must not create duplicate reports for an unchanged profile and unchanged evidence. It stores a scan checkpoint instead.

Each report must contain:

- report ID
- report version
- profile ID
- tenant ID
- agent type
- rule-set version
- source-data digest
- issue fingerprint
- report digest
- evidence digest
- result status
- severity
- findings
- affected-record links
- approval requirement
- HCS receipt status

### Issue fingerprint

The fingerprint identifies the same logical issue across repeated runs.

Build it from stable values:

~~~text
tenant ID
agent type
profile ID
rule ID
normalized subject identifiers
material observed values
rule-set version
~~~

Do not include:

- UI labels
- reminder timestamps
- mutable comments
- generated display text
- random report IDs

The database must prevent more than one active pending report for the same tenant, profile, rule, and fingerprint. If the evidence changes materially, create a new linked report version instead of overwriting the old report.

### PASS result

A PASS result still creates a report:

~~~json
{
  "status": "PASS",
  "requiresApproval": false,
  "reportId": "report-uuid",
  "reportVersion": 1,
  "issueFingerprint": "sha256:...",
  "reportDigest": "sha256:...",
  "evidenceDigest": "sha256:..."
}
~~~

The PASS report proves what was checked, which rule-set version was used, and which evidence snapshot produced the result. It may be published as a report-created HCS receipt even when no user approval is required.

### FAIL or REVIEW result

A failed or review result creates a report and findings:

~~~json
{
  "status": "FAIL",
  "severity": "HIGH",
  "requiresApproval": true,
  "reportId": "report-uuid",
  "reportVersion": 1,
  "findings": [
    {
      "ruleId": "GS1-CHECK-DIGIT",
      "status": "FAIL",
      "comment": "The check digit is invalid. Recalculate it before using this profile.",
      "recommendation": "Correct the profile and run validation again."
    }
  ]
}
~~~

The report is created and can be anchored even if the user does not approve it. HCS proves that the failed analysis existed; it does not approve the failed profile.

### Report-created HCS message

Use a compact digest-only message:

~~~json
{
  "schema": "pharmatrace.audit.attestation.v1",
  "type": "COMPLIANCE_REPORT_CREATED",
  "reportId": "opaque-report-id",
  "reportVersion": 1,
  "agentType": "SERIAL_PROFILE",
  "reportStatus": "PASS",
  "reportDigest": "sha256:...",
  "evidenceDigest": "sha256:...",
  "issueFingerprint": "sha256:...",
  "ruleSetVersion": "GS1-CONFIG-2026-01",
  "issuedAt": "2026-09-16T10:00:00Z",
  "nonce": "unique-nonce"
}
~~~

Do not publish the complete serial profile, private evidence, comments, user data, IP addresses, or operational metadata.

### HCS signer mode

The deployment must select one mode:

| Mode | Report-created message | Decision message |
| --- | --- | --- |
| Wallet-only | UI wallet signs and submits | UI wallet signs and submits |
| Mixed | Backend service signer submits | UI wallet signs and submits |
| Service | Backend service signer submits | Backend service signer or configured wallet policy |

In the current wallet-only deployment, no backend operator key should be required. The UI receives unsigned transaction bytes, the wallet signs and pays, and the backend verifies the result.

### Receipt persistence and verification

After submission, persist:

~~~text
report ID
report version
topic ID
transaction ID
sequence number
consensus timestamp
payer account ID
submission status
receipt status
Mirror Node lookup status
verification error
~~~

A transaction callback is not proof by itself. The backend changes the report to HCS_RECEIPT_CONFIRMED only when Mirror Node confirms:

- Transaction succeeded
- Topic matches
- Message type matches
- Report ID matches
- Report version matches
- Report digest matches
- Evidence digest matches
- Issue fingerprint matches when included
- Payer matches the configured signing policy

### Separate user decision attestation

If the result requires approval, the user decision is a separate HCS message:

~~~json
{
  "schema": "pharmatrace.audit.attestation.v1",
  "type": "COMPLIANCE_REPORT_DECISION",
  "reportId": "opaque-report-id",
  "reportVersion": 1,
  "reportDigest": "sha256:...",
  "evidenceDigest": "sha256:...",
  "decisionId": "opaque-decision-id",
  "decision": "APPROVED|APPROVED_WITH_OVERRIDE|REJECTED",
  "commentDigest": "sha256:...",
  "issuedAt": "2026-09-16T10:30:00Z",
  "nonce": "unique-nonce"
}
~~~

The report-created receipt and user decision must never be represented by the same status or transaction.

### Required missing implementation work

Add the following before implementing the compliance agents:

1. Report, report-version, finding, evidence-manifest, subject-link, decision, and attestation tables.
2. A unique active-report constraint using issue fingerprint.
3. Scan checkpoints and source-data digests.
4. Canonical report and evidence serialization.
5. SHA-256 digest generation with a stored canonicalization version.
6. Report-created receipt state and decision-attestation state.
7. Actual wallet transaction ID capture.
8. Mirror Node comparison of all public payload fields.
9. Stale approval invalidation when evidence or report version changes.
10. PASS reports that can be created and optionally attested without approval.
11. FAIL and REVIEW reports that remain visible even when never approved.
12. Separate UI labels for analysis, report receipt, approval, wallet submission, and confirmation.
13. Tests proving that a PASS report, FAIL report, duplicate fingerprint, changed evidence, lost callback, and digest mismatch follow the correct state transition.


## Serial profile data sources and GS1 checks

The compliance agent must identify the profile family before applying validation rules. The supplied PharmaTrace services expose four profile sources.

### Serial number profiles

Source:

~~~text
GET https://ser-snm.k8s.pharmatrace.io/getAllProfiles
~~~

Important fields:

- id
- name
- identifier
- product
- prepandData and appendData
- maxRequestSize
- padLength and padCharacter
- format
- lowerCaseAlphabet and upperCaseAlphabet
- numericValues and specialCase
- excluded characters
- minimumValue and maximumValue
- serialNumberLength
- serialNumChars
- remainingNumbers
- issuedNumbers
- commissionedNumbers
- decommissionedNumbers
- destroyedNumbers
- serialNumberIndex
- serialNumberUsedIndex
- active and isDelete
- createdOn and lastRequestTime

Checks:

- The configured character set matches the declared format.
- Lowercase, uppercase, numeric, and special-character flags agree with the allowed and excluded character lists.
- Prefix, padding, length, minimum, and maximum rules are internally consistent.
- The product relationship exists and belongs to the authenticated tenant.
- maxRequestSize is positive and does not exceed the remaining range.
- issued, commissioned, decommissioned, and destroyed counts are internally consistent.
- serialNumberUsedIndex does not exceed serialNumberIndex.
- remainingNumbers is consistent with the configured range and consumed values.
- An active profile is not expired, deleted, exhausted, or configured with an invalid range.
- The profile can generate values that satisfy the configured identifier and GS1 policy.

The agent must distinguish a profile-configuration problem from an already-generated serial collision. A profile can PASS configuration checks while individual generated serials still require collision analysis.

### GDTI profiles

Source:

~~~text
POST https://pt-snm-gdti.k8s.pharmatrace.io/graphql
~~~

Operation:

~~~graphql
query {
  allGdtiProfiles {
    id
    name
    incrementBy
    currentNumber
    startNumber
    numberRangeSize
    thresholdPercentage
    externalSystem
    status
    index
    remaining
    metadata
    companyPrefix
    epcFilterValue
    documentType
    gs1ApiKey
    epcApiKey
    isDelete
    realmName
    createdOn
  }
}
~~~

Checks:

- GDTI profile is active and not deleted.
- companyPrefix and documentType are present and valid for the configured GS1 policy.
- currentNumber is within the configured range.
- incrementBy is positive.
- numberRangeSize and remaining values are consistent.
- thresholdPercentage triggers a warning before exhaustion.
- The external system relationship is authorized and available.
- GS1 API keys are never included in reports, logs, prompts, or HCS.
- Metadata does not contain secrets or unapproved personal data.
- Profile status, index, and current number do not indicate concurrent or stale generation.

The agent should report an exhausted profile as a capacity or operational finding, not automatically as a GS1 format failure.

### SSCC profiles

Source:

~~~text
POST https://pt-snm-gdti.k8s.pharmatrace.io/graphql
~~~

Operation:

~~~graphql
query {
  allSsccProfiles {
    id
    ssccProfileName
    startNumber
    incrementBy
    numberRangeSize
    thresholdPercentage
    externalSystem
    status
    index
    companyPrefix
    metadata
    epcFilterValue
    extensionDigit
    remaining
    currentNumber
    createdOn
  }
}
~~~

Checks:

- SSCC profile is active and not deleted.
- companyPrefix and extensionDigit are present and valid.
- incrementBy, currentNumber, startNumber, and numberRangeSize are consistent.
- remaining and thresholdPercentage correctly identify exhaustion risk.
- The profile's number range and ownership scope are unique.
- Generated SSCC values are checked using the configured SSCC check-digit rule.
- EPC filter values are validated separately from the SSCC value.
- External system and tenant ownership are verified.

The report must distinguish:

- Invalid SSCC construction
- Exhausted SSCC range
- Duplicate SSCC
- Invalid extension digit
- Invalid EPC filter configuration

### Remote serial number profiles (deferred)

This profile family is deferred and is not currently exposed by the backend runner or included in the active profile list. The source query and checks below are retained as future design notes only.

Source:

~~~text
POST https://pt-snm-gdti.k8s.pharmatrace.io/graphql
~~~

Operation:

~~~graphql
query {
  allRemoteSerialNumberProfiles {
    id
    name
    identifier
    lowerThreshold
    upperThreshold
    maxRequestSize
    remoteSystem
    status
    index
    xsltDocument
    companyPrefix
    epcFilterValue
    indicatorDigit
    itemReferenceNumber
    product
    packLevelDescription
    gtin14
    currentNumber
    numberRangeAliases
    createdOn
    updatedOn
    metaData
    sgtinNumberRange
  }
}
~~~

Checks:

- lowerThreshold is less than or equal to upperThreshold.
- maxRequestSize is positive and within the available range.
- companyPrefix, indicatorDigit, itemReferenceNumber, and gtin14 are consistent.
- The product relationship exists and is authorized.
- The remote system is available and belongs to the expected tenant scope.
- xsltDocument is present only when the configured remote integration requires it.
- sgtinNumberRange and numberRangeAliases are parsed and validated when present.
- currentNumber is within the remote allocation range.
- Remote profile status, timestamps, and ownership are consistent.
- Remote-generated serials are checked against local uniqueness and lifecycle records.

### Source adapter requirements

Each source adapter must return the common profile shape:

~~~json
{
  "profileId": "uuid",
  "profileType": "SERIAL|GDTI|SSCC",
  "sourceSystem": "serial-number-service",
  "tenantId": "uuid",
  "productId": "uuid-or-null",
  "status": "ACTIVE",
  "ruleSetVersion": "configured-version",
  "sourceRecordDigest": "sha256:...",
  "observedAt": "timestamp",
  "rawDataReference": "private-database-reference"
}
~~~

The raw response remains private. The agent uses a normalized view for rule evaluation, while the evidence manifest stores field-level references and source digests.

### Profile report examples

A successful profile check creates an attested or attestable PASS report:

~~~text
SERIAL profile RS-ABRILADA-01
Result: PASS
Rule set: GS1-CONFIG-2026-01
Finding count: 0
Action: No correction required
~~~

An invalid configuration creates a FAIL report:

~~~text
SSCC profile SSCC-01
Result: FAIL
Finding: The configured range is exhausted or inconsistent with currentNumber.
Action: Stop new allocation and configure a new valid range.
~~~

A low-capacity range creates a REVIEW report:

~~~text
GDTI profile GDTI-01
Result: REVIEW
Finding: remaining is at or below thresholdPercentage.
Action: Create a replacement range before the current range is exhausted.
~~~

### Security requirements for profile sources

- Do not place gs1ApiKey, epcApiKey, Keycloak tokens, or remote credentials in the report, logs, prompt, or HCS.
- Authenticate each source before reading profiles.
- Propagate the authenticated tenant scope to every source where supported.
- Store source URL, operation, response status, and safe correlation ID in the tool-call audit record.
- Store only the source record digest and authorized field references in the evidence manifest.
- Treat missing source data as REVIEW or ANALYSIS_FAILED according to policy; never convert unavailable data into PASS.
