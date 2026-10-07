# Recall and Return Compliance Agent

## Purpose

Verify recall scope, return-to-site activity, quantity reconciliation, verification, digital signatures, and closure readiness.

## Sources

Read recalls, products, lots, items, deliveries, return records, receiving sites, verification records, signatures, exceptions, manufacturers, and locations.

## Checks

- Recalled products and lots
- Deliveries after recall activation
- Recalled quantity versus returned quantity
- Partial returns and missing items
- Required return site
- Return verification identity and time
- Digital-signature requirement and completion
- Recall closure without complete evidence
- Repeated recalls by product, manufacturer, production site, receiving site, or location

## Report output

Separate:

- Recall identified
- Return required
- Return received
- Return verified
- Digital signature required
- Digital signature completed
- Recall resolved

Include item-level states, quantity differences, closure blockers, exceptions, and repeated-pattern analysis.

## User actions

A user may request return, verify receipt, record an exception, request a signature, approve closure, or reject closure. Each action requires authorization, a comment where policy requires it, and an auditable domain transaction.

## Acceptance criteria

- Recall closure is blocked when required returns or signatures are missing.
- Partial-return rules are configurable.
- Signature policy and approved exceptions are recorded.
- Deliveries after recall are reported separately from older deliveries.
- Repeated recall patterns are grouped by product, manufacturer, site, and location.
- Final closure or exception can be wallet-attested.

