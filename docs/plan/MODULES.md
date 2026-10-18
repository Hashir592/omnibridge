# Modules: build order and requirement ownership

Owner: S1. Every ID in `requirements-index.md` has exactly one owning module here. Other modules may also touch an ID; for example, M18 must also respect HLT-3. The owner is the module whose S4 sign-off proves that ID.

Detailed tasks exist only for the next two modules (`docs/backlog.json`). Tasks for later modules are written two modules at a time.

## Build order and why

| # | Module | Session | Starts after |
|---|---|---|---|
| 1 | M01 Platform foundations (local) | S3 | none |
| 2 | M02 Identity, tenancy and audit | S3 | M01 APPROVED |
| 3 | M01b Ops stack (local) | S3 | M02 APPROVED |
| 4 | M06 Public site, legal and eBay deletion endpoint (built locally) | S3 (+S2 for page design) | M01b |
| 5 | M04 PII vault and deletion service | S3 | M06 |
| 6 | M05 Notifications, platform console and security alerts | S3 | M04 |
| 7 | M07 Integration framework and provider mocks | S3 | M05 |
| 8 | M08 Catalogue | S3 | M07 |
| 9 | M09 Inventory and stock engine | S3 | M08 |
| 10 | M10 Orders and sales VAT | S3 | M09 |
| 11 | M11 Website connector (JeezMart) | S3 | M10 |
| 12 | M12 Shipping desk, Evri and tracking loop | S3 | M11 |
| 13 | M13 DPD | S3 | M12 |
| 14 | M14 Reminders and Notes | S3 | M13 |
| 15 | M15 eBay (on mocks) | S3 | M14 |
| 16 | M16 Finance I | S3 | M15 |
| 17 | M17 Finance II | S3 | M16 |
| 18 | M18 Amazon SP-API (on mocks) | S3 | M17 |
| 19 | M19 Amazon Ads (on mocks) | S3 | M18 |
| 20 | M20 Profit, forecasting and Home | S3 | M19 |
| 21 | **M22 Deploy: staging and production (first VPS work)** | S3 | M20 APPROVED + Hashir's server prerequisites |
| 22 | M21 Hardening and go-live | S3 + S5 | M22 |
| ∥ | M03 Design system and app shell | S2 | T-0102 (contract) done |

**Why this order (local-first, ADR-029):**

1. **Design → develop → deploy.** Everything is built and tested on local Docker (localhost), with every provider replaced by mocks. No VPS is bought or used until M22. The VPS budget (ARCHITECTURE §7) still applies from day one: local containers run with the same memory and CPU limits, so we find out early if something does not fit.
2. **Foundations first.** M01 and M02 give the skeleton, the quality gate and the security core that everything else uses.
3. **Ops stack early, but locally.** M01b runs the observability, backup and restore tooling and the edge config in local Docker. M04 needs the restore and tombstone path for AT-8, and the budget alarms help during development.
4. **Features on mocks.** M04–M20 cover every feature, including eBay, Amazon and Ads, built against mocks written from the official specs.
5. **Deploy late.** M22 buys and hardens the servers, deploys staging and production, puts the public site live, subscribes the eBay deletion endpoint and sends the Amazon, Ads and eBay applications. It then runs every verify-live task as each approval arrives.
6. **Known cost of this order (accepted by Hashir):** the Amazon, Ads and eBay approvals can take weeks and only start in M22, so go-live waits on them. **Option:** at any point Hashir can ask for an early mini-deploy of only the public site and the eBay deletion endpoint (from M06) so the approvals run while the rest is still being built. It is small, about 0.3 GB of the production budget.
7. **Design runs in parallel.** M03 (S2) uses the shared contract and mock data, so it can run alongside S3 from T-0102 onwards.

**A module starts only when the previous one is APPROVED by S4**, with at most 2 fix rounds per checkpoint. M02 also needs an S5 audit of the auth task T-0203 with no open Blocker or Major findings.

## Modules

### M01 Platform foundations (local)

- **Purpose:** walking skeleton, contract pipeline, envelope crypto and secrets, job queue, files, scanning and email, basic logger. Runs fully on local Docker.
- **Owns:** NFR-1, NFR-2, NFR-3, NFR-4, NFR-5, NFR-6, NFR-7, OPS-7, OPS-8, OPS-9, OPS-10, OPS-11, SEC-2, SEC-4, SEC-5, SEC-6, SEC-16, MAIL-2
- **Depends on:** none.
- **External gate:** none. A GitHub repo is needed only to run the CI workflow; `scripts/verify.sh` runs locally.
- **Before the gate:** n/a.

### M02 Identity, tenancy and audit

- **Purpose:**
  - workspaces and companies
  - users with MFA
  - sessions
  - invites
  - Admin/Child roles with tab and company ticks
  - audit log
  - tenant isolation harness
- **Owns:** TEN-1, TEN-2, TEN-3, TEN-4, TEN-5, TEN-6, TEN-7, TEN-8, TEN-9, TEN-10, USR-1, USR-2, USR-3, USR-4, USR-5, USR-6, USR-7, USR-8, USR-9, PERM-1, PERM-2, PERM-3, PERM-4, PERM-5, PERM-6, PERM-7, AUD-1, AUD-2, AUD-3, AUD-4, SEC-1, SEC-3, AT-1, AT-2, AT-3
- **Depends on:** M01.
- **External gate:** none. The exit criteria include the S5 audit of T-0203.
- **Before the gate:** n/a. Email goes to Mailpit.

### M01b Ops stack (local)

- **Purpose** (all running in local Docker, no server):
  - full observability stack within the 500 MB budget, with the OPS-4 alert rules (alerts go to Mailpit locally)
  - backup and restore scripts. restic writes to a local repository that stands in for B2; the B2 settings (buckets, hide-only keys, lifecycle) are written as config, ready for M22.
  - restore drill script, with tombstone re-apply hook used by M04
  - the shared `edge` project config (Caddy + Coraza WAF + the single clamd), run locally
- **Owns:** OPS-4, SEC-11, CAP-10
- **Depends on:** M02.
- **External gate:** none.
- **Before the gate:** n/a.

### M06 Public site, legal and eBay deletion endpoint

- **Purpose:**
  - Astro public site with every PRD §10.2 page
  - privacy policy and terms drafts
  - Operator footer from platform settings
  - terms acceptance on first login
  - mailboxes
  - minimal compliant eBay account-deletion endpoint: challenge hash, signature check, 200 within 3 s, receipt with no identifiers. M04 wires in real deletion.
- **Owns:** WWW-1, WWW-2, WWW-3, WWW-4, WWW-5, WWW-6, WWW-7, MAIL-1, DP-1, DP-2, DP-3, EBAY-2
- **Depends on:** M01b, M02.
- **External gate:** none for building. Everything is tested on localhost.
  - Going live (HTTPS, eBay subscription, applications) happens in M22, or earlier only if Hashir asks for the early mini-deploy.
  - The signature check needs eBay's public-key API, which becomes a verify-live step once the keyset is active.
  - Operator legal details are placeholders until the client supplies them.
- **Before the gate:** challenge and signature handling are tested against the eBay mock with official sample payloads.

### M04 PII vault and deletion service

- **Purpose:**
  - pii-vault service with capability tokens
  - db-pii with field encryption and blind indexes
  - masking
  - access log
  - deletion service handling every DEL-1 trigger
  - tombstones in three places
  - erasure requests and subject access exports
  - completing the eBay deletion handler
  - canary records
- **Owns:** DP-4, DP-5, DP-6, DP-7, DP-8, DEL-1, DEL-2, DEL-3, DEL-4, DEL-5, AT-8, AT-9, AT-10
- **Depends on:** M02, M01b (restore drill), M06 (endpoint).
- **External gate:** none.
- **Before the gate:** n/a.

### M05 Notifications, platform console and security alerts

- **Purpose:**
  - notification centre with deduplication and auto-resolve
  - email templates
  - per-type email preferences
  - platform console: workspaces, feature flags, jobs and dead-letter queue, usage, credential calendar
  - security alerts: unusual logins, mass exports, mass PII views, canary access
  - daily health digest
- **Owns:** NTF-1, NTF-2, NTF-3, NTF-4, NTF-5, PLAT-1, PLAT-2, PLAT-3, PLAT-4, SEC-12, OPS-6, MAIL-3
- **Depends on:** M04.
- **External gate:** none.
- **Before the gate:** n/a.

### M07 Integration framework and provider mocks

- **Purpose:**
  - adapter interfaces
  - versioned response parsers
  - sync cursors
  - origin tags
  - Connections page
  - kill switch, maintenance switch and bulk confirmation
  - carrier and website concurrency caps
  - usage dashboard
  - `provider-mocks` with scenario switches
  - egress allowlist
  - lint rule separating the governors
- **Owns:** INT-1, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8, RL-3, RL-4, RL-5, SAFE-1, SAFE-2, SAFE-3
- **Depends on:** M05.
- **External gate:** none.
- **Before the gate:** everything is built against mocks.

### M08 Catalogue

- **Purpose:**
  - Master SKUs
  - VAT types and rate table
  - single-SKU bundles
  - COGS history and CSV import
  - listing discovery and mapping, with the unmapped queue
  - the money type
- **Owns:** CAT-1, CAT-2, CAT-3, CAT-4, CAT-5, CAT-6, FIN-1, AT-5
- **Depends on:** M07.
- **External gate:** none.
- **Before the gate:** listing discovery runs against mocks.

### M09 Inventory and stock engine

- **Purpose:**
  - on hand, reserved and available
  - movements and change log
  - safety buffers
  - push queueing
  - oversold flags
  - nightly reconciliation
  - sync-failed state
- **Owns:** INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7, INV-8, INV-9, AT-4
- **Depends on:** M08.
- **External gate:** none.
- **Before the gate:** pushes go to mocks.

### M10 Orders and sales VAT

- **Purpose:**
  - unified order list and filters
  - normalised statuses
  - two-tier storage through the vault
  - masked lists and order detail
  - returns and refunds view
  - no-PII CSV export
  - VAT engine (test-first)
- **Owns:** ORD-1, ORD-2, ORD-3, ORD-4, ORD-5, ORD-6, ORD-7, ORD-8, VAT-1, VAT-2, VAT-3, VAT-4, VAT-5, VAT-6, VAT-7, AT-6, AT-15, AT-16
- **Depends on:** M09, M04.
- **External gate:** none.
- **Before the gate:** orders come from mock channels and the website mock.

### M11 Website connector (JeezMart)

- **Purpose:**
  - signed inbound and outbound contract
  - idempotency
  - asynchronous processing
  - retries up to 24 h, then the dead-letter queue
  - nightly reconciliation
  - published OpenAPI for the JeezMart developer
- **Owns:** WEB-1, WEB-2, WEB-3, WEB-4, WEB-5, WEB-6, OPS-12, AT-14
- **Depends on:** M10.
- **External gate:** the JeezMart side is built by the dev team in the JeezMart codebase.
- **Before the gate:** a website mock that implements both directions.

### M12 Shipping desk, Evri and tracking loop

- **Purpose:**
  - `ShippingProvider`
  - Evri adapter: address re-flow, INVALID parcel handling, labels, reprint, void reconcile
  - shipping rules
  - batch labels and merged print files
  - packing slips
  - label cost table
  - partial dispatch
  - tracking push loop with the 4-hour alert
- **Owns:** SHIP-1, SHIP-2, SHIP-3, SHIP-4, EVRI-1, EVRI-2, EVRI-3, EVRI-4, EVRI-5, EVRI-6, EVRI-7, SHP-1, SHP-2, SHP-3, SHP-4, SHP-5, SHP-6, SHP-7, SHP-8, TRK-1, TRK-2, TRK-3, AT-12, AT-13
- **Depends on:** M11.
- **External gate:** Evri credit account live and the failover IP allowlisted (a verify-live task).
- **Before the gate:** an Evri mock built from myHermes spec v1.4.

### M13 DPD

- **Purpose:** DPD adapter covering session login, network codes, shipments and label formats, with DPD UK and DPD Local as variants.
- **Owns:** DPD-1, DPD-2, DPD-3, DPD-4, DPD-5
- **Depends on:** M12.
- **External gate:** the official DPD spec and account from the DPD account manager (verify-live).
- **Before the gate:** a DPD mock built from third-party evidence, marked [Third-party source].

### M14 Reminders and Notes

- **Purpose:**
  - reminders with recurrence, assignee and snooze
  - notes, private or shared
  - a warning check for PII-like text
- **Owns:** TOOL-1, TOOL-2, TOOL-3
- **Depends on:** M05.
- **External gate:** none.
- **Before the gate:** n/a.

### M15 eBay

- **Purpose:**
  - OAuth connect
  - listings and mapping
  - orders
  - stock push with revision guard
  - tracking
  - messages inbox
  - seller feedback
  - health screen
  - finances
  - daily call governor
  - restriction guards
- **Owns:** EBAY-1, EBAY-3, EBAY-4, EBAY-5, EBAY-6, EBAY-7, EBAY-8, EBAY-9, EBAY-10, EBAY-11, RL-2, CS-1, CS-2, CS-3, HLT-2, HLT-3, HLT-4, HLT-5, AT-7
- **Depends on:** M12, M10.
- **External gate:** none for building (mocks). Live checks wait for M22: deletion endpoint subscribed, keyset activated, Growth Check applied for.
- **Before the gate:** an eBay mock built from the official OpenAPI contracts and the Trading XSD. Cap and revision scenarios are simulated.

### M16 Finance I

- **Purpose:**
  - expenses with VAT inc/exc
  - suppliers
  - attachments
  - CSV and paste import with preview checks
  - recurring templates
  - employees and payroll records
  - finance audit
- **Owns:** EXP-1, EXP-2, EXP-3, EXP-4, EXP-5, EXP-6, EXP-7, REC-1, REC-2, REC-3, IMP-1, IMP-2, IMP-3, IMP-4, PAY-1, PAY-2, PAY-3, PAY-4, PAY-5, PAY-6, USR-10, FIN-3, FIN-4, AT-19, AT-20
- **Depends on:** M05, M08 (money type).
- **External gate:** none.
- **Before the gate:** n/a.

### M17 Finance II

- **Purpose:**
  - fees and fee VAT mapping
  - reverse charge
  - payouts
  - intercompany transfers with PDF records
  - VAT periods, locking and settlement
  - P&L
  - six exports and Xero journals
  - drill-down
  - marketplace VAT setting
- **Owns:** FEE-1, FEE-2, FEE-3, FEE-4, ICT-1, ICT-2, ICT-3, ICT-4, ICT-5, VQ-1, VQ-2, VQ-3, VQ-4, PL-1, PL-2, PL-3, PL-4, XP-1, XP-2, XP-3, FIN-2, FIN-5, AT-17, AT-18, AT-21
- **Depends on:** M16, M10.
- **External gate:** accountant answers (§13.3). These change settings only.
- **Before the gate:** fee data comes from mocks.

### M18 Amazon SP-API

- **Purpose:**
  - OAuth connect with state rules
  - listings and mapping
  - orders
  - stock
  - shipment confirmation
  - finances and fees
  - health screen
  - returns report
  - feedback
  - review requests
  - keepalive
  - revocation handling and deletion at day 21 (P-006)
  - reactive governor
- **Owns:** AMZ-1, AMZ-2, AMZ-3, AMZ-4, AMZ-5, AMZ-6, AMZ-7, AMZ-8, AMZ-9, AMZ-10, AMZ-11, AMZ-12, AMZ-13, AMZ-14, RL-1, HLT-1, CS-4, CS-5, AT-11, AT-22
- **Depends on:** M17, M15.
- **External gate:** none for building (mocks). Live checks wait for M22: developer profile and roles approved (architecture review).
- **Before the gate:** an Amazon mock built from the official selling-partner-api-models. Each [Verify in testing] item becomes a verify-live task.

### M19 Amazon Ads

- **Purpose:**
  - OAuth connect and profile choice
  - warehouse with backfill and the provisional window
  - campaign manager and edits
  - rules engine with dry run
  - negative keyword finder
  - ad spend per SKU
  - CSV fallback
- **Owns:** ADS-1, ADS-2, ADS-3, ADS-4, ADS-5, ADS-6, AD-1, AD-2, AD-3, AD-4, AD-5, AD-6
- **Depends on:** M18.
- **External gate:** none for building (mocks). Live checks wait for M22: the Ads app approved. If it is refused, ship ADS-5 only.
- **Before the gate:** an Ads mock built from the official Ads API specs.

### M20 Profit, forecasting and Home

- **Purpose:**
  - Sales & Profit dashboard
  - forecasting and low-stock list
  - Home tiles
- **Owns:** PRF-1, PRF-2, PRF-3, PRF-4, PRF-5, FC-1, FC-2, FC-3, HOME-1, HOME-2
- **Depends on:** M19 (or M18 if Ads is refused), M17.
- **External gate:** none.
- **Before the gate:** n/a.

### M22 Deploy: staging and production (first VPS work)

- **Purpose:**
  - buy and set up the servers: production netcup VPS 2000 G12.5 + failover IPv4, staging VPS 1000 G12.5
  - host bootstrap and hardening (WireGuard, SSH key + TOTP, nftables, auditd, AIDE, fail2ban, auto-updates)
  - shared `edge` project live with TLS and WAF; failover-IP egress for carriers and websites
  - CI deploys: staging automatically, production blue/green on Hashir's approval
  - backups switched from the local restic repository to B2 EU Central (hide-only keys, off-server prune)
  - public site live on HTTPS (AT-23); eBay deletion endpoint subscribed; Amazon, Ads and eBay applications sent
  - verify-live tasks for every provider, run as each approval arrives (PRD §13.4)
  - network diagram and asset inventory
- **Owns:** OPS-1, OPS-2, OPS-3, SEC-7, SEC-8, SEC-9, SEC-10, SEC-13, CAP-9, AT-23
- **Depends on:** M20 (all features built and APPROVED locally), M01b.
- **External gate (Hashir):**
  - both netcup servers + failover IPv4
  - DNS records at GoDaddy
  - Backblaze B2 account (EU Central), Scaleway TEM account, UptimeRobot free account (P-011)
  - Zoho Mail Lite mailboxes, if not already set up for M06
- **Before the gate:** every script and config was already run in local Docker (M01b). Host scripts are tested in a local Debian 13 container first.

### M21 Hardening and go-live

- **Purpose:**
  - load test and first restore drill, on the production box before real data
  - pen test
  - runbooks
  - written policies
  - incident plan
  - people controls
  - DP-9 gate
  - go-live checklist (§13.5)
- **Owns:** SEC-14, SEC-15, SEC-17, SEC-18, OPS-5, DP-9, DP-10, DP-11, CAP-1, CAP-2, CAP-3, CAP-4, CAP-5, CAP-6, CAP-7, CAP-8, AT-24, AT-25
- **Depends on:** M22.
- **External gate (to real data):** every DP-9 agreement signed and the pen test passed.
- **Before the gate:** synthetic data only.

### M03 Design system and app shell (parallel, S2)

- **Purpose:**
  - design tokens and theme
  - shadcn/ui component set
  - app shell: top bar with company switcher, navigation by tabs
  - dense table, filter, form and chart patterns
  - auth screens
  - reference screenshots used by e2e tests
  - WCAG 2.1 AA
  - UK formats
- **Owns:** NFR-8, NFR-9
- **Depends on:** T-0102.
- **External gate:** the client chooses from mock-ups (NFR-8).
- **Before the gate:** S2 works from the contract with mock data.

Unmapped IDs: none
