# Audit Lifecycle Anomaly Agent

## Purpose

Detect suspicious, incomplete, or impossible serial and item lifecycle activity without declaring intent or fraud automatically.

## Sources

Read audit events, serial generation, item creation, assignment, delivery, return, recall, status, actor, tenant, location, and request metadata.

## Checks

- Serial generated but never used within the configured window
- Attempt to use a serial that does not exist
- Repeated failed usage attempts
- Item creation without serial generation
- Delivery without item creation
- Status transition without a valid predecessor
- Actor, tenant, site, or location mismatch
- Backdated or delayed events
- Broken event-hash or lifecycle relationships

## Report output

Include the event timeline, source time and ingestion time, actor, location, related records, grouped incident ID, suspicion basis, severity, and investigation recommendation.

## User actions

A user may acknowledge, assign, investigate, classify as an authorized test, quarantine a target, close with justification, or escalate. The agent never resolves the incident automatically.

## Acceptance criteria

- Unknown serial usage is distinguishable from a missing-data condition.
- Repeated attempts are grouped into one incident.
- Authorized automation can be recorded as justification.
- Every closure requires a user, reason, and timestamp.
- Original events remain immutable.

