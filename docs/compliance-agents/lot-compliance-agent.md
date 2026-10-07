# Lot Compliance Agent

## Purpose

Identify expired, unsafe, incomplete, or inconsistent pharmaceutical lots.

## Sources

Read lots, products, drugs, manufacturing sites, items, inventory, deliveries, recalls, Merkle roots, Fabric anchors, and Hedera anchor records.

## Checks

- Expired or soon-to-expire lot
- Insufficient shelf life at creation or delivery
- Invalid manufacture and expiration ordering
- Missing product, drug, manufacturer, or site
- Item-count mismatch
- Pending or undelivered items
- Delivery after expiration or recall
- Missing or mismatched anchor
- Duplicate lot key or Merkle root
- Active inventory after expiry

## Report output

Group findings by lot, product, manufacturer, site, severity, exposure, and recommended action. Include affected item count and post-expiration or post-recall delivery evidence.

## User actions

The user may quarantine inventory, block delivery, open a corrective action, or approve an authorized exception. Business APIs perform the mutation and return an auditable transaction reference.

## Acceptance criteria

- Near-expiry and expired states are separate.
- Expired but unused inventory is distinguished from expired and delivered inventory.
- Critical findings block PASS approval unless policy permits an override.
- Lot evidence includes source freshness and rule-set version.

