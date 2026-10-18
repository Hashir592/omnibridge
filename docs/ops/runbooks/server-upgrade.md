# Runbook: production server upgrade (stub)

Owner: S1 until M01b, then the dev team. Source: P-007 and ADR-024. This stub fixes when we upgrade and which checks must happen. M01b fills in the exact commands.

## Current and target

| | Plan | Specs |
|---|---|---|
| Now | netcup VPS 2000 G12.5 | 8 shared vCores, 16 GB RAM, 256 GB SSD; shared with JeezMart |
| Upgrade | netcup VPS 4000 G12.5 | 12 vCores, 32 GB, 512 GB |

## Upgrade only when tuning is exhausted and at least one trigger holds

1. Host RAM use (excluding page cache) has been above 85% for 7 days in a row.
2. Swap is in use for more than 1 hour on any day of the last 7 days.
3. A §9.1 target was missed in the last 14 days, after tuning was tried and recorded. The targets are p95 page load under 1 s and 95% of stock pushes within 2 minutes.
4. Disk is above 85% even though every retention job is running.
5. Any OmniBridge container is OOM-killed twice in 7 days, and raising its limit would push the box past trigger 1.

"Tuning exhausted" means every one of these was checked and recorded in the incident log:

- slow queries and missing indexes
- worker concurrency
- PostgreSQL memory settings
- container limits
- heavy jobs moved to low-traffic hours
- VictoriaLogs retention

## Before the upgrade

- Confirm with netcup support, in writing, whether the main IPv4 survives the plan change. Carrier and website egress uses the **failover IPv4**, which can be moved between servers free of charge. Check that it is assigned and that the SNAT rule is in the host config.
- If the failover IP cannot be kept, follow the carrier re-allowlisting steps:
  - Evri: email IT.integration@evri.com and evriclientdesk@evri.com.
  - DPD: contact the account manager.
  - Allow up to 5 working days.
- Take a netcup snapshot and a fresh restic backup of both databases. Check that the latest snapshot is under 26 hours old.
- Rehearse the steps on staging.
- Tell the JeezMart developer, since the box is shared. Agree a window, and never use a Friday.

## After the upgrade

- Raise the container limits to the "design" column in ARCHITECTURE.md §7, and the PostgreSQL settings to match.
- Check `/healthz`, Gatus and the external uptime check, plus one test label on staging through the failover IP.
- Update `docs/ops/asset-inventory.md` and the network diagram (SEC-13).
