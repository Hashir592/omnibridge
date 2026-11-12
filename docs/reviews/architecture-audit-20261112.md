# Architecture and plan audit, 12 Nov 2026

From: an independent audit session (Fable 5.2). For: S1, who rules on every finding. Reviewed: `main` at `12cd5a6`.

This audit is read-only. No code and no plan document was changed. Its aim is a build that is **simpler and faster without lowering the architecture bar**. Each finding is marked as one of: **Simplify** (less to build or run), **Specify** (a short rule written before the code, so it is built once), **Reorder** (same work, better order) or **Decide** (a choice for Hashir or S1).

## 1. Executive summary

1. **The architecture is sound and should stay.** Forced RLS with composite keys, the separate PII cluster behind a vault, envelope encryption, the PostgreSQL queue, integer pence and mock-only development are the right choices for this product. Nothing needs a redesign.
2. **The main risk is the plan order, not the design (FA-01, Critical).** The first deploy, every provider application and the first real API call all wait for M22, after about 18 more modules. Approvals take weeks, and 13 provider behaviours are still unverified (PRD §13.4).
3. **The owner gets no value until module 22 (FA-02, High).** I recommend three releases, with Release 1 as the operational core: orders, stock, labels and tracking.
4. **Two rules are missing and are needed before the integration modules.** The provider job contract (FA-03) and "no PII in queues or inboxes" (FA-04). Both are one page each and prevent rework in 12 modules.
5. **The shared server has an unstated trust boundary (FA-05, High).** Anyone who can run Docker on the box can read the PII master key. The simplest fix is a separate small VPS for JeezMart (about €14.50 a month).
6. **Several things can be made simpler:** the main-backup purge (FA-06), the Amazon governor store (FA-19), blue/green deploys (FA-20), tombstone handling (FA-21), and the ui-perf gate that blocks M03 (FA-18).
7. **Money and VAT design is correct in principle.** Three small rules are missing: penny allocation and a refund cap (FA-12), snapshots for late-mapped lines (FA-11), and the order state machine (FA-10).
8. **Operations need three cheap guards:** a tighter RPO (FA-07), staging as a rehearsed standby (FA-08), and a second key holder (FA-09).
9. **The five-session workflow works.** S4 found 7 real Majors that the builder's own review missed. The waste is in strict serial gates, local full-gate runs on a 7.9 GB machine, and hand-carried rulings for trivial dependency changes (§6).
10. **Scope:** eight features can move after Release 1 without touching the architecture (§5.3). The largest are public sign-up, the Ads rules engine and Reminders/Notes.
11. **Effort (rough estimate):** about 40 to 55 active build days to Release 1 on the recommended order, against 60 to 100 before any value on the current order (§5.4).
12. **Counts:** 1 Critical, 4 High, 13 Medium, 9 Low. Six need a ruling before more code is written (§2).

## 2. All findings at a glance

"When" says the latest point at which the ruling is still cheap.

| ID    | Severity | Type     | Finding                                                             | When                           |
| ----- | -------- | -------- | ------------------------------------------------------------------- | ------------------------------ |
| FA-01 | Critical | Reorder  | Deploy, approvals and first live contact come last                  | **Now**                        |
| FA-02 | High     | Reorder  | Big-bang release: no owner value until module 22                    | **Now** (before new task specs) |
| FA-03 | High     | Specify  | Provider job contract is not specified                              | Before M07                     |
| FA-04 | High     | Specify  | PII can reach db-main through queue payloads and inboxes            | Before M06 and M04             |
| FA-05 | High     | Decide   | Shared host: Docker and edge admin boundary not specified           | Before any server work         |
| FA-06 | Medium   | Simplify | Main-backup purge makes every tenant's history hostage              | Before the backup scripts      |
| FA-07 | Medium   | Specify  | RPO 24 h is weak for labels and stock; no post-restore steps        | Before the backup scripts      |
| FA-08 | Medium   | Specify  | Single host: no rehearsed standby; DNS not on the failover IP       | Before production              |
| FA-09 | Medium   | Decide   | One person holds every master key                                   | Before production              |
| FA-10 | Medium   | Specify  | Order ingest: state machine and cross-database write order          | Before M04 and M10             |
| FA-11 | Medium   | Specify  | Immutable snapshots against late mapping (CAT-6)                    | Before M08 and M10             |
| FA-12 | Medium   | Specify  | Penny allocation and refund cap are not defined                     | Before M10                     |
| FA-13 | Medium   | Specify  | No table says what is company-scoped and what is workspace-shared   | Before M07 and M08             |
| FA-14 | Medium   | Specify  | eBay deletion endpoint: volume and PII handling                     | Before M06                     |
| FA-15 | Medium   | Specify  | Label batches: where the merged file is built; vault memory         | Before M12                     |
| FA-16 | Medium   | Specify  | Cutover and backfill are not specified                              | Before M10                     |
| FA-17 | Medium   | Decide   | Fee VAT and the open accountant questions                           | Before M17                     |
| FA-18 | Medium   | Simplify | The ui-perf gate guards a case the product does not have            | **Now** (blocks M03)           |
| FA-19 | Low      | Simplify | Amazon governor state in PostgreSQL                                 | Before M18                     |
| FA-20 | Low      | Simplify | Blue/green deploys from day one                                     | Before production              |
| FA-21 | Low      | Simplify | Tombstones in three places                                          | Before M04                     |
| FA-22 | Low      | Specify  | Connection budget ignores deploy overlap                            | T-0207                         |
| FA-23 | Low      | Decide   | Load-test target is 100 times launch                                | Before M21                     |
| FA-24 | Low      | Simplify | Breached-password list has 358 entries                              | Any time                       |
| FA-25 | Low      | Specify  | Random UUIDs on high-volume tables                                  | Before M08                     |
| FA-26 | Low      | Specify  | Document drift                                                      | Any time                       |
| FA-27 | Low      | Specify  | Small PRD ambiguities (table in §4.4)                               | With each module               |

**Must be ruled before building further:** FA-01, FA-02, FA-03, FA-04, FA-05, FA-18.

## 3. What is good (keep as is)

- **Tenancy (ADR-006).** Forced RLS, composite `(workspace_id, id)` keys, `SET LOCAL` per transaction, a fail-closed policy shape (`nullif(current_setting(…, true), '')`, `0007_tenancy.sql`), the RLS coverage test and the route walker. This is the right depth. Know its limit: RLS on a setting that the same role can change guards against application bugs, not against SQL injection. Parameterised queries and the role split (ADR-051) stay the defence there.
- **Two clusters and pii-vault (ADR-007).** PRD NFR-2 and DP-4 require it, and it costs 352 MB. Keep it.
- **Envelope encryption with KEK rotation (T-0103).** The rotation path is tested, including the file keys (F-M01-end-03).
- **pg-boss in db-main (ADR-009).** No extra service, and jobs commit with the business change.
- **Contract pipeline (ADR-004).** One Zod schema drives validation, OpenAPI and the client, with a drift gate. It is the best speed tool in the repo.
- **Integer pence as `bigint` (ADR-022)** with a branded type (`packages/core/src/money.ts`).
- **Mock-only dev and CI with an egress allowlist (ADR-011).** Keep the rule. FA-01 adds a sandbox lane on staging only.
- **In-house auth (ADR-008).** It is built and the S4 review was thorough. With the S5 audit and the pen test it is acceptable. Do not replace it now.
- **Backups with hide-only keys and off-server prune (ADR-016).**
- **Observability stack (ADR-017).** Lean and inside its budget. Only its timing changes (§5.2).
- **The S4 reviewer.** M01 end found 4 Majors and M02 halfway found 3, all real defects (a lease leak, a process crash, data loss on key rotation, a reset token in logs, an unlimited password check, open auth definers).

## 4. Findings

Effort uses session time: **S** is half a day or less, **M** is 1 to 2 days, **L** is more.

### 4.1 Critical

#### FA-01 — Critical — Reorder — Deploy, approvals and first live contact come last

- **Where:** ADR-029; `MODULES.md` "Why this order" items 5 and 6; PRD §12.1 phase 8; PRD §13.4.
- **Problem:** Until M22 there is no server, no public HTTPS site, no provider application and no call to any real or sandbox API. M22 comes after about 18 more modules.
- **Why it matters here:**
  - Amazon and eBay will not review an application without a live public site (PRD §10, WWW-4). `MODULES.md` says the approvals "can take weeks". The Amazon restricted role for delivery addresses (AMZ-3) needs a security review as well. All of that waiting starts only after the product is finished.
  - PRD §13.4 lists 13 unverified provider behaviours. Several shape tables and parsers: fee VAT separation (FEE-2), Orders field names, the eBay batch size, whether the recipient name comes with the shipping role. The DPD adapter rests on third-party evidence (PRD §3.6). All of them will be found wrong or right at the very end, when 12 modules already depend on them.
  - The deploy path itself is unproven until the end: WAF rules against a JSON API and CSV paste boxes, the failover-IP egress, migrations against a previous app version, the secrets flow on a real host.
- **Recommendation:** Split M22 in two. ADR-029 already allows the first half "on request"; I recommend taking it and widening it a little.
  - **M22a "Staging and public face", straight after M06.** One VPS 1000 G12.5 as staging. CI deploys `main` to it on every merge. The public site and the minimal eBay deletion endpoint go live on HTTPS. The WAF starts in detection-only mode, so rules are tuned from real traffic before they block. The observability and edge work of M01b is built here, once, on a real host.
  - **Send every application as soon as the site is live:** Amazon developer profile and roles, the Ads application, the eBay keyset. Ask the DPD account manager for the official spec, and Evri IT for test access (EVRI-7).
  - **Add a third provider mode, `sandbox`, allowed on staging only.** It allows the eBay sandbox and the SP-API sandbox hosts. Each provider module ends with a "verify on sandbox" task. Dev and CI stay mock-only, so the CLAUDE.md rule does not change.
  - **M22b "Production" stays late**, before real data, as now.
- **Effort and plan impact:** No new work; about one module moves earlier. Staging costs €14.50 a month for the extra months (PLAN_REVIEW §3). Hashir's prerequisites move up: DNS, the VPS, Operator legal details, Zoho. Needs: an ADR that amends ADR-029, a `MODULES.md` change, and a PRD change entry for §12.1.

### 4.2 High

#### FA-02 — High — Reorder — Big-bang release: no owner value until module 22

- **Where:** `MODULES.md` build order; PRD §12.1 (marked as a Claude default, so S1 may change it).
- **Problem:** The owner can use nothing until every module is approved, including the Ads rules engine, forecasting, payroll records and Reminders/Notes. About 40 of 324 requirement IDs are proven today (12%).
- **Why it matters here:** The goals that pay back first are goals 1 and 2 of PRD §1.1: one stock number, and one order list with labels and tracking. They need about half of the modules. Real orders will also find defects that mocks cannot.
- **Recommendation:** Three releases, each going to production. The proposed order is in §5.2.
  - **Release 1, operational core:** tenancy and users, PII vault and deletion, integration framework, catalogue, inventory, orders with sales VAT, website connector, shipping desk with Evri, tracking loop, critical alerts, and the first approved marketplace.
  - **Release 2, finance:** the second marketplace as approved, DPD when the spec arrives, Finance I and II.
  - **Release 3, growth:** Ads (only after Amazon approves the app), profit, forecasting, Home, customer service, health screens, Reminders and Notes.
  - Stock push can be switched on per channel account with the existing kill switch (SAFE-2), so a channel can join later without a redesign.
- **Effort and plan impact:** No extra build work. `MODULES.md` and the PRD §12.1 order change. Release 1 needs a short hardening pass of its own (restore drill, pen test of the Release 1 surface, DP-9 paperwork).

#### FA-03 — High — Specify — The provider job contract is not specified

- **Where:** ARCHITECTURE invariants 3 and 19, §6.4; PS-017 (follow-up for M07); `packages/queue/src/runtime.ts:259`; `packages/queue/src/job.ts:107`.
- **Problem:** Four gaps, all in the layer that every integration module will copy.
  1. **One transaction per job.** Today a handler runs inside one tenant transaction (`runtime.ts:259`). A provider call inside it holds a connection and an open transaction through network waits and backoff (AMZ-9 allows 8 attempts of up to 60 s). The worker has 8 handler connections (`apps/worker/src/heartbeat.ts:19`) and db-main allows 40 in total. A 429 storm on a few accounts would stall every job, and long transactions stop vacuum on the queue tables. PS-017 notes this, but no rule exists yet.
  2. **No intent record for outbound writes.** If the worker dies after a carrier accepts a parcel and before the commit, the retry has no barcode. Evri then answers 400 for the duplicate `clientUID` (EVRI-3) and the paid label is lost. DPD has no idempotency key at all in the evidence we have (DPD-3). eBay `createShippingFulfillment` creates a second fulfilment on a blind retry.
  3. **Value-carrying payloads.** A stock job that carries a quantity depends on order. A job that carries only the listing ID and reads the current stock when it runs is correct in any order, merges duplicates for free, and gives the 60 s debounce of EBAY-9 with no extra code.
  4. **Strict FIFO blocks the whole account.** `serialPerAccount` maps to the pg-boss `key_strict_fifo` policy. The pg-boss 12.38.0 type notes say that a job which is active, "in retry, or failed only holds back successors with the same key". The tracking ladder of TRK-2 runs for 6 hours. One order that a channel keeps refusing would hold back every later tracking push for that account, and each would raise the 4-hour critical alert.
- **Recommendation:** One page in ARCHITECTURE §6.4, written before M07, with four rules:
  1. A provider job is: a short transaction to read and write an intent row, then the provider call with no transaction open, then a short transaction to store the result. Amend invariant 3 to say so.
  2. Every outbound write has an intent row with a stable key, written first. Add one table per provider that says how a repeat is detected and what happens when the result is unknown (for example: Evri duplicate with no stored barcode goes to the "labels to reconcile" list; it is never retried blindly).
  3. Outbound sync jobs carry IDs, not values, and compute the value when they run.
  4. Strict FIFO is used only where two jobs for one account truly must not overlap. A job with a long retry ladder does not retry inside the queue; it ends, and schedules a new job for the next step.
- **Effort and plan impact:** S for the page. It makes M07 smaller, and M09, M11, M12, M13, M15, M18 and M19 reuse it.

#### FA-04 — High — Specify — PII can reach db-main through queue payloads and inboxes

- **Where:** ARCHITECTURE invariant 7; WEB-5; EBAY-2; ADR-009; S4 follow-up in `M01-end-findings.md` ("`ob_app` can read every workspace's pg-boss job payloads").
- **Problem:** pg-boss lives in db-main, has no RLS, and is in the main backups for up to 6 months. Three flows would put PII there if built as the PRD words them:
  - WEB-5: inbound website orders are "processed asynchronously after a fast 2xx". The body holds the buyer's name, address, phone and email. Stored as a job payload, that is PII in db-main.
  - EBAY-2: the deletion notice "queues the deletion of that user's data". The notice holds the eBay username and user ID, which DP-5 lists as PII.
  - Job results: `app.job_records.result` is free JSON (F-M01-end-05). A handler that returns a provider response would store PII.
- **Why it matters here:** It would break invariant 7 and the 30-day rule by design, and the marker scan would catch it only if it reads the `pgboss` schema, which is a noted follow-up and not yet a rule.
- **Recommendation:**
  1. A new invariant: job payloads, job results, idempotency records and webhook inboxes hold IDs and `pii_ref` values only.
  2. Inbound PII goes from web to the vault in the request, before anything is queued. For website orders the simplest correct design is to process the order **synchronously** (validate, vault ingest, upsert, answer 201) and return 5xx on failure, so the website retries with the same idempotency key. That removes the inbox. It needs a PRD change entry for WEB-5.
  3. For the eBay notice, web asks the vault to match the user, and queues only the matching `pii_ref` list (see FA-14).
  4. The AT-9 marker scan covers the `pgboss` schema and `app.job_records`, and the queue rejects a payload or result that holds a `PIIMARK-` value in tests.
- **Effort and plan impact:** S for the rule; it removes work from M11. Must exist before the M06 endpoint and M04.

#### FA-05 — High — Decide — Shared host: the Docker and edge admin boundary is not specified

- **Where:** PRD §9.5 (OPS-7 to OPS-9), decision 24; ARCHITECTURE §7; ADR-015, ADR-021.
- **Problem:** Isolation is specified at the network and Linux-user level. It is not specified at the level that matters on one Docker engine:
  - Anyone who can run Docker commands on the host is root in effect. That person can read the tmpfs secrets of every container, including the PII master key and both database passwords. PRD §9.5 says another developer will move JeezMart onto the box.
  - TLS ends at the shared Caddy. A route file that names an OmniBridge hostname, or a bad global option, could take over OmniBridge traffic. Nothing says who may edit route files or how they are checked before a reload.
  - JeezMart's 3 GB and 2 cores are an assumption (ARCHITECTURE §7). Only OmniBridge containers are checked for limits. One JeezMart container without a limit can make the kernel kill db-main.
  - JeezMart is a public shop. A compromise there shares a kernel with the PII vault.
- **Why it matters here:** DP-7 and SEC-14 promise that only named, authorised people and services reach PII. On the shared box that promise depends on a person outside the project. It also couples upgrade windows and outages of two products.
- **Recommendation:** Ask the client to reconsider decision 24.
  - **Option A (recommended, simplest):** JeezMart gets its own VPS 1000 G12.5 at €14.50 a month. OmniBridge keeps its own box. This deletes work: the shared edge project, the shared clamd networks, per-app route files, "runs with or without JeezMart" tests, joint maintenance windows. OmniBridge alone needs about 5.7 GB (3.3 GB plus clamd and the host layer), so a smaller production box becomes possible too.
  - **Option B (if sharing stays):** write the controls into ARCHITECTURE §7 before any server work:
    - Only Hashir has Docker or root access. JeezMart deploys through a forced command that runs a root-owned script against a root-owned Compose file.
    - Each project runs under its own systemd slice with `MemoryMax` and `CPUQuota` (Compose `cgroup_parent`), so the kernel enforces the 3 GB cap.
    - A check before every Caddy reload proves that each route file names only its own hostnames.
    - The JeezMart developer signs the DP-9 confidentiality terms.
- **Effort and plan impact:** Option A removes about 2 to 3 days from the deploy module and costs about €175 a year. Option B adds about 2 days. Needs a PRD change entry for §9.5 either way.

### 4.3 Medium

#### FA-06 — Medium — Simplify — The main-backup purge makes every tenant's history hostage

- **Where:** ADR-016; ARCHITECTURE §8; SEC-11; AMZ-13; P-006.
- **Problem:** Any account-level deletion run (an Amazon disconnect, a workspace closure) purges **all** older main snapshots for **all** workspaces about 2 days later. With one tenant this is rare. With several, the "7 daily + 4 weekly + 6 monthly" history resets whenever any tenant disconnects an account, so a slow data corruption found three weeks later cannot be recovered. The purge also needs markers, an off-server "fresh snapshot then forget everything" job, and tests for both.
- **Recommendation:** Replace the event-driven purge with a fixed, bounded retention.
  - Delete the live data earlier and keep fewer snapshots, so the sum stays under 30 days. For example: live deletion on day 10 (warnings on days 1, 5 and 9), and 14 daily main snapshots. Every copy is gone by about day 25, with no purge logic at all.
  - Protect the statutory records another way: once Finance II exists, archive the six no-PII exports per company each month to a separate bucket, kept 6 years.
  - eBay termination (10 days, PRD §7.3) is a once-ever platform event. A manual purge runbook is enough for it.
  - S1 should first check the exact Amazon wording. db-main holds no PII by design, so the clause may bind less than P-006 assumed. I could not verify the clause text.
- **Effort and plan impact:** Removes the purge marker, the special admin job and part of AT-11. Needs a PRD change entry (AMZ-13 day, SEC-11 schedule, AT-11). Decide before the backup scripts are written.

#### FA-07 — Medium — Specify — RPO 24 h is weak for labels and stock, and nothing says what to do after a restore

- **Where:** CAP-10; ARCHITECTURE §8 (nightly `pg_dump`).
- **Problem:** After a restore from last night's dump, up to a day of work is missing. Orders come back by themselves, because the sync cursors are restored too and upserts are idempotent. Three things do not:
  - Shipments. Labels made after the dump are unknown, so those orders show "Awaiting dispatch" again and could be shipped twice.
  - Manual stock-ins, adjustments and stock takes.
  - Finance entries typed by staff.
- **Recommendation:**
  - Dump db-main every 6 hours, or hourly, and keep those for 48 hours. The database is small and the tooling is the same. No new component.
  - Add a "after a restore" section to the restore runbook: re-pull each channel from 48 hours back; flag every order that the channel shows as shipped but OmniBridge shows as awaiting; re-run the PII expiry and apply the deletion journal (FA-21); tell staff the restore time so they re-enter manual work.
- **Effort and plan impact:** S, inside the backup task. A PRD change entry may tighten CAP-10.

#### FA-08 — Medium — Specify — Single host: no rehearsed standby, and DNS is not on the movable IP

- **Where:** CAP-9, CAP-10; OPS-2; WWW-1; ARCHITECTURE §7.
- **Problem:** One VPS on shared cores, with an 8-hour recovery target. For a warehouse that prints a few hundred labels a day, 8 hours is a lost dispatch day and a mark on the Amazon and eBay shipping metrics. Also, one 8-hour outage gives 98.9% for that month, which misses the 99.5% of CAP-9. WWW-1 says DNS points at "the fixed IP" but does not say which one; if it is the server's main IP, a replacement server needs a DNS change as well.
- **Recommendation:**
  - Use the staging VPS as the standby. OmniBridge today needs about 3.3 GB, so the 8 GB box can run production alone in an emergency. Write the steps (move the failover IP, restore the latest dumps, start with staging limits) and rehearse them once in hardening. Target: 2 hours.
  - Point `app` and the apex at the **failover IP**, so inbound and carrier egress move together with one switch. Confirm with netcup whether a failover IP can move between locations.
  - For the egress address, check whether the Docker bridge option `com.docker.network.host_ipv4` does the job on the worker's network. If the Docker docs confirm it for this version, it replaces the hand-written SNAT rule of ADR-015.
  - Add one paragraph for staff: during an outage, labels can still be printed from the carrier portals.
- **Effort and plan impact:** M, in hardening. No new servers.

#### FA-09 — Medium — Decide — One person holds every master key

- **Where:** `docs/ops/secrets-register.md` (owner "Hashir" for `secrets_kek`, `pii_kek` and the rest); PLAN_REVIEW §4 ("an offline escrow copy held by Hashir").
- **Problem:** If the production age key and the restic passwords are lost with one person or one laptop, then every provider token, all PII, six years of invoice attachments (statutory records, EXP-6) and every backup are unreadable for good.
- **Recommendation:** Name a second holder before production, for example a director of the Operator, with a sealed offline copy of the age key and the two restic passwords. Add one line to the restore drill: the drill is done once from the second copy.
- **Effort and plan impact:** S. A decision for Hashir and the client.

#### FA-10 — Medium — Specify — Order ingest: state machine and cross-database write order

- **Where:** ORD-3, ORD-4; INV-3; INT-8; ARCHITECTURE §6.2. Not specified anywhere.
- **Problem:** Every channel poll re-reads changed orders with a 5-minute overlap. The design does not yet say:
  - how an order moves between statuses when updates arrive late, twice or out of order;
  - what is stored for an order that has no prices or address yet (a pending marketplace order), and when its VAT snapshot is taken;
  - how a stock movement is made exactly once (a unique key such as order line plus movement kind);
  - the write order between the two databases. If PII is written to the vault and the db-main insert then fails, a PII record exists that no order points to, and no expiry date will ever be set for it.
- **Recommendation:** One page before M04 and M10:
  1. A status table with the allowed moves; an update never moves an order backwards unless the table says so.
  2. Stock movements carry a unique key and are derived from line state changes, never from "an event arrived".
  3. Vault first, with a provisional `delete_after` (placement plus the 90-day hard limit of PRD §7.3), then db-main, both keyed by channel account and external order ID. Delivery or dispatch later shortens the date.
  4. A nightly sweep that compares vault references with db-main references, by ID only, and deletes orphans.
- **Effort and plan impact:** S for the page. Avoids rework in M10, M11, M15 and M18.

#### FA-11 — Medium — Specify — Immutable snapshots against late mapping

- **Where:** invariant 14; VAT-2, VAT-7; CAT-4; CAT-6; PRD §11.1 (MasterSku).
- **Problem:** Invariant 14 says the VAT rate, VAT type and COGS on a line never change after the order is placed. CAT-6 says an order with an unmapped listing gets its stock movement when the listing is mapped later, so its line has no Master SKU, no VAT type and no COGS at order time. Two more gaps follow: COGS has a history (`CogsHistory`), but the VAT type of a SKU does not, so "the type at order time" cannot be found later (VAT-7); and the VAT period of that order may already be filed (VQ-3).
- **Recommendation:**
  - Snapshots are **write-once**: null to a value, once.
  - An unmapped line counts at the workspace default VAT rate (TEN-6) and is marked provisional (PRF-5), so VAT is never under-reported.
  - Mapping fills the snapshot with the values in effect on the order date. Keep a small VAT-type history per SKU for this.
  - Filing a period warns when it still holds provisional lines; a correction after filing goes to the next open period (the VQ-3 rule).
- **Effort and plan impact:** S. Needs a PRD change entry that words invariant 14 and CAT-6 together.

#### FA-12 — Medium — Specify — Penny allocation and the refund cap are not defined

- **Where:** VAT-3 steps 2 and 3; VAT-5; PRD §11.1 (`OrderLine.vat_amount`); AT-15, AT-16.
- **Problem:** Splitting a discount or shipping across rate groups, and splitting a group's VAT across its lines, both leave odd pence. No rule says where they go, so two honest implementations give different line figures. Refund VAT has no cap either. Example: a £14.00 standard-rated group has VAT of 233p. Two refunds of £7.00 give 117p each, 234p in total, which is 1p more VAT refunded than was ever charged.
- **Recommendation:** Three rules in ARCHITECTURE under invariant 12, each with a property test written first:
  1. Allocation uses the largest-remainder method, with ties broken by line order. The parts always sum to the whole.
  2. Line VAT is an allocation of the group VAT. It is never rounded per line.
  3. The total VAT refunded on a group never exceeds the VAT charged on it; the last refund takes the remainder.
- **Effort and plan impact:** S. Before M10.

#### FA-13 — Medium — Specify — No table says what is company-scoped and what is workspace-shared

- **Where:** ARCHITECTURE §6.1; PERM-3; SHIP-1; `0007_tenancy.sql:116` (`channel_accounts_scope` is RESTRICTIVE on `company_id`).
- **Problem:** The design says tables with `company_id` get a second, restrictive policy. That is right for orders and expenses, and wrong for some others:
  - A carrier account belongs to one company and ships for all (SHIP-1). Under a restrictive company policy, a packer ticked for another company cannot use it, and label creation fails.
  - Master SKUs and stock are workspace-wide, but the stock change log names orders of every company (INV-5).
  - An intercompany transfer has two companies. Must the user hold one or both?
  - A notification stores its recipients (PRD §11.1). If they are stored when it is created, a later permission change does not take effect at once (USR-8).
- **Recommendation:** One table in ARCHITECTURE §6.1 that lists every entity of PRD §11.1 as company-scoped, workspace-shared or user-private, with the rule for the few mixed cases. Notification visibility is computed from the current ticks when read. The RLS coverage test then checks each table against that list.
- **Effort and plan impact:** S. Before M07 and M08, because every later migration follows it.

#### FA-14 — Medium — Specify — eBay deletion endpoint: volume and PII handling

- **Where:** EBAY-2; M06 in `MODULES.md`; invariant 15; AT-10.
- **Problem:**
  - As far as I know, eBay sends account-deletion notices for its users in general, not only for buyers this system has seen (to verify on staging). The PRD gives no volume. One queued job per notice would fill the queue with jobs that do nothing.
  - The notice holds a username and a user ID. It must not be logged, and must not be a job payload (FA-04).
  - Checking the signature needs eBay's public key, which is a provider call from a web handler. Invariant 15 allows that only for OAuth exchanges.
  - The WAF must not slow or block these POSTs; eBay expects 200 within 3 s.
- **Recommendation:** Verify the signature with a cached public key, fetched by a worker job and refreshed hourly. Ask the vault for a blind-index match in the request. Queue a deletion only on a match, with `pii_ref` values only; otherwise count the notice and answer 200. Add the endpoint path to the WAF tuning list. Measure the real volume on staging.
- **Effort and plan impact:** S. Before the M06 endpoint.

#### FA-15 — Medium — Specify — Label batches: where the merged file is built, and vault memory

- **Where:** SHP-2 (up to 200 labels, one merged file); NFR-4 (label batches run in workers); invariant 11 (merged files are streamed and never stored); `infra/compose/compose.yaml:323` (`pii-vault` at 96 MB).
- **Problem:** A batch runs for minutes in a worker, so its result must wait somewhere for the user. But the merged file may not be stored, and labels may live only in the vault. The design does not say which process merges. If the vault merges 200 PDFs, 96 MB is far too small; a Node process with a database pool already uses most of that.
- **Recommendation:** The worker creates the labels and the vault stores each one. The merge happens on download: web asks the vault to stream the merged file. Give the vault 256 MB now (the budget has room: 3.3 GB against a 5 GB target). Printer-language labels (DPD-3) are joined as text. Add a test with 200 labels at the memory limit.
- **Effort and plan impact:** S. Before M12.

#### FA-16 — Medium — Specify — Cutover and backfill are not specified

- **Where:** AMZ-6 step 6 ("start the initial sync jobs"); PRD §13.5 (seed data only). Not specified.
- **Problem:** Nothing says how the business moves onto OmniBridge: the first stock take, which open orders are imported on day one, how far back orders are read (forecasting wants 90 days, FC-1), that old orders are imported **without** PII when they are past the retention window, and whether the current tool runs in parallel for a while.
- **Recommendation:** A one-page cutover plan before M10: a backfill depth setting per stream; a rule that orders older than the PII window are stored with no vault record; stock push starts "off" per account and is switched on after the first reconciliation shows no drift; a parallel-run period.
- **Effort and plan impact:** S for the plan; small settings in M10, M15 and M18.

#### FA-17 — Medium — Decide — Fee VAT and the open accountant questions

- **Where:** FEE-2, FEE-3; XP-3; PL-2; VQ-1; VAT-1; PRD §13.3.
- **Problem:** The accountant questions have been open since 17 Oct and are marked "not blocking". Three of them change how much of Finance II is built:
  - If A2X or Link My Books stays in use, the payout report and much of the fee VAT logic are not needed (XP-3 says so).
  - Fee VAT taken from a mapping table is an estimate. The figure the accountant reclaims comes from the marketplace VAT invoices. The design should label mapped fee VAT as Derived and let an admin enter the invoice total per month to reconcile.
  - Tax point. The accountant chose the order date (VAT-1). Where a marketplace takes payment at dispatch, the dates differ at quarter ends. Keep the rule in one function and ask the accountant to confirm it for Amazon.
- **Recommendation:** Hashir sends the accountant one message now with five questions (§7, question 5). S1 writes the Finance II tasks only after the answers.
- **Effort and plan impact:** Could remove several days from M17.

#### FA-18 — Medium — Simplify — The ui-perf gate guards a case the product does not have

- **Where:** ADR-046 (four rulings on this test); T-0302 acceptance; ADR-040; F-M03-end-01.
- **Problem:** The gate requires a 10,000-row table to scroll under 16 ms per frame. ADR-040 then fixed list pages at 20, 50 or 100 rows, so no screen ever holds 10,000 rows. NFR-8 does not ask for it. So far the test has cost four rulings, two tasks (T-0303, T-0304), one fix PR (#32) and one module-end Blocker, and CI results still sit at the limit (13.17 to 16.20 ms against 16).
- **Recommendation:** Remove it from the blocking gate. Keep it as a local benchmark that prints its numbers. Replace it with a cheap check that fits the product: a 100-row page renders within a fixed number of component renders, measured in a unit test. That unblocks M03.
- **Effort and plan impact:** S. Needs an ADR that amends ADR-046 and the T-0303 acceptance line.

### 4.4 Low

#### FA-19 — Low — Simplify — Amazon governor state in PostgreSQL

- **Where:** ARCHITECTURE §6.4; RL-1; ADR-010.
- **Problem and recommendation:** RL-1 asks for a reactive governor: back off on 429. Storing token buckets in PostgreSQL adds a table and a write per call. Keep the buckets in worker memory. They reset on restart, and the 429 path corrects any overshoot. The eBay governor must stay in PostgreSQL, because RL-2 is a hard budget counted before sending.
- **Effort:** Saves about half a day in M18.

#### FA-20 — Low — Simplify — Blue/green deploys from day one

- **Where:** ADR-015; ARCHITECTURE §7; OPS-3 ("zero downtime where possible").
- **Problem and recommendation:** Two web colours, a health-gated switch and a drain step are a lot of deploy script for about ten users. Start with one web container restarted in place, and let Caddy hold and retry requests for the few seconds it takes (`lb_try_duration`). Inbound webhooks and website calls retry by contract. Move to blue/green only if measured downtime becomes a problem.
- **Effort:** Saves about a day in the deploy module, and removes the doubled connections during overlap (FA-22).

#### FA-21 — Low — Simplify — Tombstones in three places

- **Where:** invariant 10; DEL-2; AT-8, AT-24.
- **Problem and recommendation:** After a PII restore, two things bring the data back to the right state: re-running the expiry job (the restored rows carry their own `delete_after`), and applying the deletions that were triggered by events after the last backup. Only an off-site record can know the second set. So the off-site journal is the part that matters; say so in the restore runbook, and upload the journal as part of each event-triggered deletion run, not later. Add one test to AT-24: a deletion made after the last backup stays deleted after a restore.
- **Effort:** S.

#### FA-22 — Low — Specify — The connection budget ignores deploy overlap

- **Where:** ARCHITECTURE §7 (pools); `infra/compose/db-main/10-roles.sh:22-27` (role caps 30, 20 and 4); `compose.yaml:58` (`max_connections=40`); T-0207.
- **Problem and recommendation:** The role caps already add up to 54 against 40 (S4 confirmed; T-0207 will fix the caps). At design capacity the sum is also over: two web processes at 10, the same again during a deploy overlap, and two workers at about 11 each, against 60. Write one rule into T-0207: the sum of every pool, including overlap, backup and exporter connections, is at most `max_connections` minus 5.
- **Effort:** Inside T-0207.

#### FA-23 — Low — Decide — The load-test target is 100 times launch

- **Where:** CAP-3; AT-25.
- **Problem and recommendation:** Launch is 1 workspace and about 10 channel accounts. CAP-3 asks for 100 workspaces and 1,000 channel accounts on a shared 16 GB box, and AT-25 says to prove it. At 1,000 accounts, order polling alone is up to 8 provider calls a second all day. Keep the schema ready for it, and set the tested target at 10 times launch (10 workspaces, 100 accounts, 20,000 orders a week). Treat 100 and 1,000 as a paper plan with the upgrade runbook.
- **Effort:** Saves days of test building in M21. Needs a PRD change entry.

#### FA-24 — Low — Simplify — The breached-password list has 358 entries

- **Where:** ADR-008; `apps/web/data/common-passwords.txt`; USR-3.
- **Problem and recommendation:** It meets the letter of USR-3 only. A public list of the 100,000 most common passwords is about 1 MB, loads into memory once, and still needs no outside service.
- **Effort:** S.

#### FA-25 — Low — Specify — Random UUIDs on high-volume tables

- **Where:** PRD §11 ("`id` (UUID)"); `packages/db/migrations`.
- **Problem and recommendation:** Random IDs scatter inserts across the index of large append-only tables (order lines, stock movements, audit events, ads performance). PostgreSQL 18 has `uuidv7()`, which is time-ordered. Use it for those tables from M08. Keep random IDs for `pii_ref` and for tokens, so they reveal nothing.
- **Effort:** None if decided before the tables exist.

#### FA-26 — Low — Specify — Document drift

- ARCHITECTURE invariant 24 and PLAN_REVIEW still say Hashir approves merges; ADR-053 changed that.
- SEC-16 asks for review "by a second developer". ADR-053 needs a matching PRD change entry: before production the review is the tier checks plus S4; the human gate is the production deploy approval (ARCHITECTURE §7).
- The DECISIONS header says PLAN_REVIEW is "to be written"; PLAN_REVIEW §5 shows the order from before ADR-029.
- CLAUDE.md lists 15 invariants and ARCHITECTURE lists 24 with other numbers. Code comments cite ARCHITECTURE numbers (`money.ts` cites "invariant 12" for money; in CLAUDE.md number 12 is the job envelope). Use one numbering.
- ADR-017 names ten observability components; the 488 MB table has nine (Gatus is missing).
- `STATE.md` was last updated on 21 Oct and its "Next step" still says Hashir merges.

#### FA-27 — Low — Specify — Small PRD ambiguities

Each is one sentence to settle when its module's tasks are written.

| IDs               | Ambiguity                                                                                                         | Suggested rule                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| SHP-5, TRK-1      | "Void" returns the order to Awaiting dispatch, but tracking may already be confirmed on the channel               | After a confirmed push, void needs an admin and a warning; stock is put back                 |
| SHP-8             | Partial dispatch is a SHOULD, but `Shipment` has no lines                                                         | Defer SHP-8 (§5.3), or add shipment lines                                                    |
| PRF-2, PL-1       | Is "output VAT" net of refund VAT? Is COGS reversed when a refund returns stock?                                   | Yes to both                                                                                  |
| ORD-1, INV-9      | Do FBA orders count in VAT and profit? Is their PII needed?                                                       | They count; no stock movement; no PII is ingested for them                                   |
| NFR-5             | Labels are "regenerated from the carrier on demand", also after PII deletion?                                     | No reprint after the order's PII is deleted                                                  |
| DEL-5, DP-8       | The access-request export is a file with PII, but exports never hold PII                                          | The vault streams it; it is never stored                                                     |
| TEN-6, P-010      | Retention is "fixed, read-only", yet P-010 calls it a setting                                                     | A platform setting with a maximum of 25 days                                                 |
| EBAY-9, INV-6     | At 240 revisions all writes are held, so a decrease cannot go out and the listing can oversell                    | From 200 on, send only decreases; hold increases                                             |
| CAP-9, CAP-10     | 99.5% a month and an 8-hour recovery cannot both hold in a month with one outage                                  | State that CAP-9 excludes one recovery a year, or adopt FA-08                                |
| USR-6             | A 30-minute idle logout with TOTP at a packing desk                                                               | Ask the client; it is a Claude default                                                       |
| AD-5              | The Ads warehouse grows without limit while connected                                                             | Roll search-term rows older than 13 months up to monthly                                     |
| PAY-1, EXP-3      | Staff and supplier personal data has no access or erasure path (DEL-4 and DEL-5 cover buyers)                     | One runbook line: handled by hand by an admin                                                |
| INV-4             | Push goes to "every other channel"; the selling channel is assumed right                                          | Push the computed quantity to every mapped listing and skip writes that change nothing       |

## 5. Plan recommendations

### 5.1 What is over-built, under-specified and missing

| Over-built for now (simplify)                    | Under-specified (one page each)              | Missing (add to the plan)                         |
| ------------------------------------------------ | -------------------------------------------- | ------------------------------------------------- |
| Event-driven backup purge (FA-06)                | Provider job contract (FA-03)                | Early staging and applications (FA-01)            |
| Shared-host isolation work (FA-05)               | No PII in queues (FA-04)                     | Sandbox lane and a verify task per provider       |
| Blue/green deploys (FA-20)                       | Order state machine (FA-10)                  | Cutover and backfill plan (FA-16)                 |
| Amazon buckets in PostgreSQL (FA-19)             | Penny rules (FA-12), snapshots (FA-11)       | Standby and key escrow (FA-08, FA-09)             |
| ui-perf gate (FA-18)                             | Company scoping table (FA-13)                | A rework reserve after each live check            |
| Public sign-up and wizard before launch (§5.3)   | Label merge and vault memory (FA-15)         | Post-restore steps (FA-07)                        |

### 5.2 Proposed order (for S1 to rule)

The work is the same. Only the order and the release cuts change.

| Step | Work                                                                                                             | Note                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | Finish M02: halfway fixes, T-0204, T-0207, S5 audit                                                              | T-0205 moves out (§5.3)                                                        |
| 2    | M06: public site and minimal eBay endpoint                                                                       | With FA-04 and FA-14                                                           |
| 3    | **M22a: staging and public face**; send every application                                                        | FA-01. Observability and edge are built here, once                             |
| 4    | M04 core: vault, deletion engine, expiry, journal, backup and restore scripts                                    | The part of M01b that M04 needs. Access-request export and canaries move later |
| 5    | M07: integration framework and mocks                                                                             | With FA-03 and FA-13                                                           |
| 6    | M08 → M09 → M10 → M11 → M12 (Evri)                                                                               | With FA-10, FA-11, FA-12, FA-15, FA-16                                         |
| 7    | The first approved marketplace, core only: connect, listings, orders, stock, tracking                            | eBay is likely first; Amazon if its approval lands sooner                      |
| 8    | Release 1 hardening, **M22b production**, real data once DP-9 is signed                                          | Restore drill, pen test of this surface                                        |
| 9    | **Release 2:** second marketplace, DPD, Finance I and II                                                         | After the accountant answers (FA-17)                                           |
| 10   | **Release 3:** Ads (only if approved), profit, forecasting, Home, customer service, health, Reminders and Notes | Then the full M21                                                              |

M05 splits along the same line: the notification centre and critical email alerts are in Release 1; each platform console view is built with the module that produces its data (dead-letter view with M07, usage with the governors); the security alerts of SEC-12 go to hardening.

### 5.3 What can move after Release 1

None of these changes the architecture. Each needs the client's yes and a PRD change entry.

| Item                                             | IDs                 | Why it can wait                                                                                |
| ------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------- |
| Public sign-up and first-run wizard (T-0205)     | TEN-8, TEN-9        | Off at launch; one workspace, made by a platform admin. It is a high-risk task with public surface |
| Quarterly access review task                     | USR-9               | First due 90 days after go-live                                                                |
| Ads rules engine, negative finder, campaign wizard | AD-2, AD-3, AD-4    | Depends on Amazon approving the app; it changes live spend. Reporting and ADS-5 come first     |
| Reminders and Notes                              | TOOL-1 to TOOL-3    | Generic; not on the path to stock, orders or VAT                                               |
| Xero journal format                              | XP-2                | Optional and off by default                                                                    |
| Stock recharge suggestion                        | ICT-5               | A convenience on top of intercompany transfers                                                 |
| Partial dispatch                                 | SHP-8               | A SHOULD, and the data model has no place for it                                               |
| eBay inbox and feedback replies                  | CS-1 to CS-3        | Useful, but Release 3 is early enough                                                          |

### 5.4 Realistic effort

These are estimates from the repo history, not promises. Recalibrate after M07.

- **Measured so far:** 123 commits and 36 pull requests on 6 calendar days. 9 backend and 4 UI tasks in 4 active build days (18 to 21 Oct). About 21,300 lines of source, 9,900 of tests, 1,250 of SQL. 40 of 324 requirement IDs proven (12%).
- **The pace is not the limit.** Between 21 Oct and 12 Nov there was one working day. The limits are Hashir's time and the strict serial gates.
- **The integration modules are larger than M01.** M12 owns 24 IDs, M15 19, M17 25 and M18 20, against 18 for M01.

| Path               | Active build days to first real value | External waits                                         | Total active days |
| ------------------ | ------------------------------------- | ------------------------------------------------------ | ----------------- |
| Current plan       | about 60 to 100 (everything first)    | Approvals start **after** all of that, and take weeks  | 60 to 100         |
| Recommended (§5.2) | about 40 to 55 (Release 1)            | Approvals run **during** the build, from step 3        | 60 to 100         |

Assumptions: 2 to 3 tasks per active day, 4 to 7 tasks per module for the 19 modules left, half a day per checkpoint, and a reserve of 10 to 15 days for fixes after live checks. The total work is the same on both paths; what changes is when value arrives and when the waiting happens. At four active days a week, Release 1 is about three months away. At the rate of the last four weeks it is far longer, which is why §6 matters.

## 6. Process recommendations

The five-session split is sound. S1 as the only editor of the plan, S3 as builder and S4 as an independent reviewer that runs the code have already paid for themselves. The changes below remove waiting, not checks.

1. **Reviews do not block the next module.** A module-end review may run while S3 starts the next module. APPROVED is required before the next module's own end checkpoint and before any production deploy. Nothing is live, so a late finding costs a fix, not an incident. (Amends ADR-044.)
2. **Halfway checkpoints only where the risk is.** Keep them for modules with high-risk tasks: M02, M04, M10, M12, M17 and M18. Small modules get an end checkpoint only, and two small modules may share one.
3. **CI is the only full gate.** On the 7.9 GB machine, S4's full local runs took 766 to 1,006 s, and three different timing flakes cost review time (R2-01, F-M02h-09, ui-perf). CI runs the same gate in about 6 minutes on a clean machine. High-tier tasks run `--quick` plus their own integration tests locally, then CI. S4 reads the CI run of the same commit as gate evidence and spends its time on probes. (Amends ADR-043.)
4. **Pre-approved dependency classes.** Six of the 19 session proposals were type packages, required peers, or patch step-downs forced by the 7-day rule (PS-001, 006, 008, 009, 013, 014). Each cost a hand-carried round trip. Let the builder add the DECISIONS line itself for: `@types/*` packages; required peers of an approved package; patch and minor moves inside an approved major that meet ADR-033. S1 checks them at the checkpoint.
5. **ADRs name the package, the major version, the licence and the reason.** The lockfile is the record of exact versions. This ends the amendments of ADR-002, 003 and 020 for patch numbers.
6. **Contract first for screens.** `apps/ui/src` is 42% of all source and most of it runs on mock shapes that S3 must later match (ADR-042). From now on, the route is written in `packages/contract` first (by S1 in the task, or S3), and S2 builds against the generated client with mock handlers typed from the same schema. Shapes cannot drift, and no screen is wired twice.
7. **A flaky test is fixed or quarantined the day it is seen,** with a one-line note in STATE.md. It is never left to cost the next reviewer a run.
8. **One hardware change.** Raising the dev machine to 16 GB, or a `.wslconfig` memory setting (STATE.md lists none), removes most of the "one session at a time" limit and the load flakes. It is the cheapest speed gain in the project.
9. **Keep:** the tiers, batch PRs, self-merge on green (ADR-053), Hashir's "go" on high-risk tasks, the S5 audit of auth, and handoff files.

## 7. Open questions for Hashir

1. **Early staging (FA-01):** will you provide a VPS 1000, the DNS records, the Operator's legal details and the mailboxes now, so the public site goes live and the applications are sent?
2. **Shared server (FA-05):** can JeezMart have its own small VPS? If not, who besides you will have Docker or root access to the box?
3. **Release 1 (FA-02):** which channels and which carrier must it cover to be useful to the business? Which tool handles stock, orders and labels today, and can it run in parallel for a few weeks (FA-16)?
4. **FBA:** do any of the three companies use it?
5. **Accountant (FA-17), one message:** is A2X or Link My Books in use? One Xero organisation per company? Is the COGS basis right for the P&L? Is the order date the tax point for Amazon too? What is each company's real VAT stagger?
6. **Scope (§5.3):** may the eight items move after Release 1? The client must agree.
7. **Second key holder (FA-09):** who?
8. **Paperwork with long lead times (PRD §13.3, DP-9):** can the Pakistan company registration, the IDTA and risk assessment, the DPAs and Raja's identity check for Amazon start now?
9. **Carriers:** has anyone asked DPD for the official spec, and Evri for test access?
10. **Amazon deletion day (FA-06):** is day 10 with 14 daily main backups acceptable in place of day 21 with a purge?
11. **Packing desk (USR-6):** is a 30-minute idle logout with TOTP workable for packers?
12. **Dev machine:** can it go to 16 GB?

## 8. How this audit was done

- **Read in full:** CLAUDE.md, STATE.md, PRD v1.3, ARCHITECTURE.md, DECISIONS.md (ADR-001 to 053, P-001 to P-012, PS-001 to PS-019), MODULES.md, PLAN_REVIEW.md, backlog.json, the S3 and S4 rule files, and the M01 end, M02 halfway and M03 end findings.
- **Checked in code (claims only, no style review):** RLS policy shapes (`0007_tenancy.sql`), tenant transactions (`packages/db/src/tenant.ts`), the job runtime and queue policies (`packages/queue/src`), role caps and container limits (`infra/compose`), the money type, the gate steps and CI jobs, the secrets register, and the pg-boss 12.38.0 policy notes.
- **Not done:** `scripts/verify.sh` was not run; I relied on S4's gate evidence and CI on `main`. No provider documentation was fetched, so every statement about Amazon, eBay, Evri, DPD or netcup behaviour comes from the PRD or is marked as something to verify. The Amazon policy wording behind P-006 and the Docker `host_ipv4` option are not verified.
