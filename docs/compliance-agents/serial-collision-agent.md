# Serial Generation and Collision Agent

## Purpose

Detect duplicate generation, unsafe reuse, conflicting ownership, and serial numbers that must not be used.

## Sources

Read serial-generation, assignment, item, lot, product, delivery, recall, void, quarantine, and audit events through authorized APIs.

## Checks

- Duplicate serial generation within the configured uniqueness scope
- Cross-product, cross-lot, tenant, or environment reuse
- Reuse after void, recall, retirement, destruction, or quarantine
- Concurrent-generation collisions
- Multiple assignment
- Sequence gaps and request replay
- Database versus ledger conflicts
- Provider/client ownership conflicts
- Generated serials never assigned or used

Distinguish a supported idempotent request replay from a real collision.

## Report output

Include first and later claims, ownership history, request IDs, affected objects, downstream exposure, provider/client bug reference, severity, and a DO NOT USE list.

## User actions

The agent only recommends containment. An authorized user may quarantine, restrict, void, replace, reassign, open an investigation, or accept an exception. Every action requires a comment, actor, idempotency key, before/after status, and domain transaction reference.

## Acceptance criteria

- Conflicted serials are visibly marked DO NOT USE.
- No new operation can use a restricted serial.
- Duplicate active reports are suppressed by issue fingerprint.
- Resolution creates a linked report version.
- A recurrence creates a new report linked to the previous report.
- The final resolution can be wallet-attested through the common HCS flow.

