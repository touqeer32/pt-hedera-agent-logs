# Timing and Workflow Compliance Agent

## Purpose

Detect implausible timing and invalid workflow order while preserving context for approved automation and clock differences.

## Sources

Read generation, assignment, item creation, commissioning, delivery, recall, return, shortage, and status events with both event time and ingestion time.

## Checks

- Generation-to-delivery interval below policy minimum
- Delivery before item creation
- Recall before activation
- Return before delivery
- Multiple actions at the same time from different locations
- Backfill and ingestion delay
- Trusted automation identity
- Clock skew and timezone normalization

## Classifications

- EXPECTED
- REQUIRES_JUSTIFICATION
- SUSPICIOUS
- INVALID_SEQUENCE

A short interval alone must never be classified as fraud.

## Report output

Include compared events, measured interval, configured policy, source timestamps, ingestion timestamps, actor and location context, automation identity, and justification state.

## Acceptance criteria

- Timing rules are configurable by workflow and event type.
- Timestamps are normalized to UTC.
- Manual and approved automated flows can have different limits.
- A justification is attributable and cannot overwrite the original finding.
- A changed event creates a new report version.

