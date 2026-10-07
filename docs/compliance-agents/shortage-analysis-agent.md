# Shortage Analysis Agent

## Purpose

Analyze shortages, resolution quality, recurring locations, and operational patterns without changing inventory or shortage status automatically.

## Sources

Read shortage records, comments, statuses, products, lots, inventory, deliveries, warehouses, sites, regions, actors, and resolution events.

## Checks

- Open, resolved, overdue, and reopened shortages
- Resolution comments and responsible actor
- Repeat shortages by product, lot, warehouse, site, and region
- Average and median resolution time
- Overdue and reopened rate
- Shortages without supporting inventory or delivery events
- Location and product hotspots

## Report output

Include analysis period, grouping dimensions, denominator, source freshness, hotspot ranking, repeat rate, unresolved cases, resolution metrics, and recommendations.

## User actions

Users may assign, comment, investigate, resolve, reopen, or create a corrective action. The agent must not change shortage or inventory status.

## Acceptance criteria

- Metrics state their period and denominator.
- Reopened cases are counted separately.
- A location with repeated shortages is ranked with supporting evidence.
- Missing source data is disclosed.
- A report can be reviewed and wallet-attested without exposing raw shortage records to HCS.

