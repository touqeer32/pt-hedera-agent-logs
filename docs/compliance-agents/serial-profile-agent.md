# Serial Profile Compliance Agent

## Backend implementation

The first deterministic implementation runs through:

```http
POST /api/v1/compliance/serial-profiles/run
```

It reads profiles from `SERIAL_PROFILE_API_URL` (`https://ser-snm.k8s.pharmatrace.io/getAllProfiles` by default), authenticates with the configured Keycloak credentials, matches each API profile against the latest `SERIAL_PROFILE` report using its source fingerprint, evaluates the configured GS1-oriented rules, and creates an idempotent report for every PASS, FAIL, or REVIEW result. The backend also exposes separate runners for SSCC and GDTI profiles, each with its own report family and source query. Remote serial-number profiles are intentionally excluded from the active list for now. The existing agent-created HCS attestation path records the first proof transaction.

For all three active profile families, the agent also calls `POST https://ser-snm.k8s.pharmatrace.io/downloadSerialNumbers` with `actionCode=C` and a demo size of two. It sends `idType=GTIN` with the serial profile identifier/name, `idType=GDTI` with the GDTI profile UUID, or `idType=SSCC` with the SSCC profile UUID. It records the returned values in the report and records generation errors or empty responses as findings. Serial profile values are additionally checked against the configured prefix, suffix, length, and character set.

For local testing, the request can provide a `profiles` array directly. This avoids requiring the source API while validating report generation and HCS behavior. Configure `SERIAL_PROFILE_RULE_SET_VERSION` and `AGENT_REPORT_CREATOR_PUBLIC_KEY`; never include private keys or GS1 API keys in the report payload.

## Purpose

Findings distinguish blocking errors, warnings, and informational recommendations. Each finding includes `phase`, `field`, `userCanFix`, and `suggestedAction`. Form-editable problems point to fields such as `name`, `identifier`, `product`, `prepandData`, `appendData`, `format`, `numericValues`, `maxRequestSize`, `padLength`, `padCharacter`, and `serialNumberLength`. Backend-only issues such as generation-service failures, derived character-set inconsistencies, stored capacity, counters, and metadata normalization are marked `userCanFix=false`.

Validate serial-number profiles against the configured GS1-oriented rule set and create a report for every PASS, FAIL, or REVIEW result.

## Sources

- GET https://ser-snm.k8s.pharmatrace.io/getAllProfiles
- POST https://pt-snm-gdti.k8s.pharmatrace.io/graphql
  - allGdtiProfiles
  - allSsccProfiles

## Profile families

### Serial number profile

Validate product relationship, prefix and append data, padding, format, case rules, numeric and special-character rules, minimum and maximum values, serial length, character set, request size, range consumption, issued/commissioned/decommissioned/destroyed counts, and active/deleted state.

### GDTI profile

Validate company prefix, document type, increment, current number, range size, remaining number, threshold percentage, external-system relationship, status, and deletion state.

### SSCC profile

Validate name, start/current number, increment, range capacity, company-prefix digits and capacity, remaining/index reconciliation, threshold percentage, EPC filter (`0`, `2`, or `6`), extension digit, remote-system reference, active/exhausted state, and generated output. Generated SSCC values must use AI `(00)`, contain exactly 18 numeric digits, and pass GS1 Mod-10 check-digit validation. AI `(253)` or values such as `[253 GS11]` are rejected.

## Report behavior

Every validation creates an immutable report with:

- profile ID and profile family
- rule-set version
- PASS, FAIL, or REVIEW status
- issue fingerprint
- source-data digest
- report digest
- evidence digest
- rule-level findings
- corrective comments
- affected product and tenant links

A PASS report is still stored and can receive a report-created HCS receipt. A FAIL report remains visible even if nobody approves it.

## Findings

Examples:

- Invalid check digit
- Invalid character or case configuration
- Inconsistent range counters
- Exhausted or nearly exhausted range
- Missing product or external-system relationship
- Deleted profile still marked active
- Invalid EPC filter or extension digit
- Profile data unavailable or stale

Missing source data must produce REVIEW or ANALYSIS_FAILED, never PASS.

## Acceptance criteria

- Rule-set version is stored with every report.
- The same unchanged issue fingerprint does not create duplicate pending reports.
- A changed profile creates a linked report version.
- API keys and remote credentials never appear in reports, prompts, logs, or HCS.
- Mirror Node verification can reproduce the report and evidence digests.
