# M07 + M08 milestone findings, round 1

Reviewed: M07 (#131, #133, #134, #137, #138) and M08 (contract #139, T-0801 #141, merge a29d3e3), on main 72b5526. Earlier findings: `docs/reviews/M07-T0702-findings.md`.
Gate: CI on main for the #141 merge (run 44939370947) green; #133 and #134 merged green (M07 end report, T-0702 findings).
Local: `verify.sh --quick` PASS (216 s). Integration re-run: db `catalogue.int.test`, web `catalogue.int.test`, worker `discovery.int.test`, web `isolation.int.test`, db `definers.int.test`: 25/25 PASS (5 files, 64 s). `req-coverage`: 335 IDs, 0 unmapped.
Acceptance re-run: 3/3 PASS (T-0801). M07 acceptance was re-run at the T-0702 review (4/4) and is unchanged.

Verdict: **BLOCKED**. Blockers 0, Majors 1, Minors 2. The one open Major is F-M08-end-01. Every earlier Major (F-M07-T0702-01) is resolved and verified.

## The six checks

| # | Check | Result |
|---|---|---|
| 1 | F-M07-T0702-01 | PASS, resolved. `kit/src/carrier.ts:84-97`: a Retry-After over `CARRIER_MAX_WAIT_MS` (10 s) rethrows at once and a computed wait is capped at the same value. `withCarrierSlot` releases in its `finally` (`:51-55`). `runOutboundSend` defers with `max(retryAfterMs, retryDelayMs)` (`outbound.ts:306-318`). The bound (3 × 15 s + 2 × 10 s = 65 s) holds: the client timeout is 15 s (`http.ts:54`) and the worker calls `carrierBackoff(fn)` with the defaults (`apps/worker/src/governor.ts:78`). Test `carrier.test.ts:92` asserts one call, no sleep, and the same error back. See F-M08-end-03 for the deferral length. |
| 2 | ADR-078 1 (M05 Minors) | PASS. `0041`: `platform_notice_open_records_before` has a fixed `search_path`, revoked from PUBLIC, granted to `ob_worker` only. `ebay_budget_reserve` now clears `app.platform_console` on entry. `security.ts` resolves workspace (unusual login, lock) and platform (console login, lock, canary) event notices 7 days after the event; every event window is far shorter, so none is raised again. The definers test works, but checks one role only: F-M08-end-02. |
| 3 | 0042 catalogue | PASS. All five tables: forced RLS, workspace policy only (matches the 6.1 workspace-shared row), composite FKs. `master_skus`: unique code, bundle CHECK (both or neither, not itself), a trigger that refuses a bundle component and any change of code or make-up (CAT-3); a plain SKU can never become a bundle, so the insert-time check has no race. Histories: `sku_vat_types` and `cogs_history` keyed by date, DELETE revoked; `vat_rates` UPDATE and DELETE revoked. `cogsOn` / `vatTypeOn` / `vatRateOn` (`packages/db/src/catalogue.ts:263-307`) take a London day, follow the component for a bundle, multiply in bigint in SQL. The first VAT type holds from 1973 (`:426`), so an order dated before the SKU still finds one. The VAT-rate trigger runs in the creating transaction; the one creation path (`WorkspaceRepository.create`) binds the new id. Expand only, no squawk waiver. |
| 4 | CSV imports, export, CAT-6 | PASS. Both imports validate every row first and apply only when `!dry_run && errors = 0`, inside the request transaction, so a failure mid-apply rolls all back. `parsePounds` refuses negatives, 3 decimals and exponents. The mapping import remaps as unmap then map under the row lock and sends one event per real change. The export goes through `toCsv`'s `safe()` (`= + - @ \t \r` get a quote) and refuses above 100,000 rows. `mappingChanged` uses `queue.send`, whose `createAndEnqueue` runs in the bound tenant transaction; the payload holds IDs only. |
| 5 | Discovery | Short transactions and the governor: PASS. Every page and the token call go through `governed()` before the call (eBay budget reserved first), and each page is stored in its own transaction. Auto-match on first insert only (`xmax = 0`): PASS. Ending only after a complete, non-empty scan: PASS for one scan, FAIL with two overlapping scans: F-M08-end-01. |
| 6 | Isolation walk | PASS. B's SKU (with COGS) and a mapped listing of B's account are seeded (`isolation.int.test.ts:249-284`) and in B's snapshot; all 15 catalogue routes are walked with B's IDs, including the mapping import with B's listing. Route metadata: 14 routes on `stock-catalogue`, `createVatRate` on `settings` with `adminOnly`. |

M07 milestone: #137 and #138 are the completeness checklist and the spec follow-up (docs plus the mock-storm test); nothing new to raise. F-M07-T0702-02 is carried to M15, as ruled. Squawk waivers in M07 (0037 line 24, 0039 lines 92 and 95): each is the contract step, with the replacing NOT VALID constraint added just above, a `-- waiver:` line, and validation in 0038 / 0040. They meet ADR-045.

## F-M08-end-01 — Major — Overlapping discovery scans can end live listings, which clears their manual stock settings
Area: Correctness, Interference  IDs: CAT-5, INT-8 (and INV-10 through M09)

Evidence:
- `packages/db/src/catalogue.ts:831`: the upsert sets `last_seen_at = seenAt` unconditionally, and `seenAt` is the scan's `startedAt`, not the page time (`scan.ts`, `sinkPage(..., startedAt)`).
- `endUnseen` (`catalogue.ts`, after `upsertDiscovered`) ends every listing with `last_seen_at < scanStartedAt`.
- Two scans of one account can run at once: `listings.discover` has `expireInSeconds: 1_800` (`packages/queue/src/registry.ts:210`) and the runtime does not stop a handler at expiry, so a scan longer than 30 minutes (up to 500 pages, `scan.ts:15`, each with a 15 s timeout and governor waits) is retried while the first still runs. `key_strict_fifo` only orders active jobs; it cannot see the abandoned handler.
- M09 acts on the result: `onListingsEnded` → `#clearListing` (`packages/db/src/stock.ts:1233-1252`) sets `stock_mode = 'auto'`, drops `manual_qty` and cancels the pending write.

Failure: scan A starts at t0 and runs past 30 minutes; the retry B starts at t1. B stores listing L with `last_seen_at = t1`. A's later page then writes L back to `t0`. B completes and ends L, because `t0 < t1`. M09 clears L's manual quantity and stock mode. The next scan un-ends L, but L is now on auto and gets the full available quantity pushed, where the seller had capped it. The manual settings are gone.

Required fix:
- The upsert never moves `last_seen_at` back: `last_seen_at = greatest(app.listings.last_seen_at, excluded.last_seen_at)`.
- A scan concludes only if no newer scan of the account has started. For example, record the scan start per account (or check `max(last_seen_at) <= startedAt` for the account under a lock in `complete`), and skip `endUnseen` when a newer one exists. Also stop a scan without concluding once it nears the job's expiry, so a retry never overlaps it.
- Test, citing `[CAT-5]`: two overlapping scans where the older one's last page lands after the newer one's; the newer scan's completion ends no listing either scan saw.

Resolution: fixed on branch `task/M08-end-fixes` (S3, 22 Nov 2026).
- The upsert never moves `last_seen_at` back, never replaces a newer quantity, and never revives a listing that a newer scan ended (DO UPDATE ... WHERE `last_seen_at <= seenAt` AND (`ended_at IS NULL OR ended_at < seenAt`)).
- Each scan records its start as the account's `listings.discover` cursor, which only moves forward (`beginScan`). `concludeScan` locks that row and concludes only when no newer scan has started; an older scan ends and reconciles nothing, and reports `concluded: false`.
- A scan stops reading after 25 minutes without concluding (`DISCOVERY_MAX_RUN_MS`, inside the 30-minute job expiry), so a retry never runs beside it.
- Tests:
  - `packages/db/src/catalogue.int.test.ts`, "[CAT-5] overlapping scans: an older page never moves last_seen back, and only the newest scan concludes";
  - `apps/worker/src/discovery.int.test.ts`, "[CAT-5] a scan that reaches its deadline stops without concluding: nothing is ended".
- Follow-up: an account whose scan always needs more than 25 minutes never concludes, so it should resume across runs.

## F-M08-end-02 — Minor — The F-M05e-02 definers test checks only the definers `ob_app` can call
Area: Tenancy  IDs: TEN-1, PLAT-3

Evidence: `packages/db/src/definers.int.test.ts:51` selects definers with `has_function_privilege('ob_app', …)`. `ob_worker` and `ob_ops` are separate logins that can also preset a transaction setting (`infra/compose/db-main/10-roles.sh`). 17 definers are granted to them only, for example `security_locks`, `security_login_failures` and `user_terms_delete`, which read `app.memberships`, a setting-gated table. Today each filters explicitly (checked by hand), so nothing leaks; a new worker-only definer would not be caught.

Required fix: run the same check for each of `ob_app`, `ob_worker` and `ob_ops` (or for any role with LOGIN and without BYPASSRLS).

Resolution: fixed in the same branch. The check now covers every definer that `ob_app`, `ob_worker` or `ob_ops` can call. It found one more definer, `workspace_set_module` (ob_ops only), which scopes by its own key (`w.id = p_workspace`). The test now accepts that on `app.workspaces` only.

## F-M08-end-03 — Minor — A provider's Retry-After defers an outbound write for as long as it asks
Area: Rate limits  IDs: RL-4, INV-8

Evidence: `kit/src/respond.ts:5-12` accepts any Retry-After (seconds or date); `kit/src/outbound.ts:306-308` defers by `max(retryAfterMs, retryDelayMs(...))` with no upper bound. Since F-M07-T0702-01, every long Retry-After takes this path.

Failure: a website answers 429 with `Retry-After: 604800` (or a far date). The stock write waits a week, with no error badge, because a deferral is not a failure. A large enough number gives an Invalid Date at `new Date(...)`.

Required fix: cap the deferral at the retry ceiling (`min(retryAfterMs, 60 minutes)`, the same as `retryDelayMs`'s cap), and a test citing `[RL-4]`.

Resolution: fixed in the same branch. A Retry-After deferral is capped at `MAX_DEFER_MS` (60 minutes), the same ceiling as `retryDelayMs`. Test: `packages/providers/kit/src/outbound.test.ts`, "[RL-4] a Retry-After of a week defers the write by the 60-minute ceiling, not a week".

## Acceptance (T-0801)

| Item | Result |
|---|---|
| Tests first, citing AT-5, CAT-4, CAT-2, CAT-5, FIN-1 | PASS. `packages/db/src/catalogue.int.test.ts:106-436` (CAT-2 ×2, CAT-4, CAT-3/AT-5 ×2, CAT-5 ×5); `tests/arch/architecture.test.ts:272` [FIN-1]; all pass locally |
| Route walker and RLS coverage with the new tables against the 6.1 list | PASS. Isolation walk passes with B's catalogue seeded; the five new tables have forced RLS and the workspace policy only; CI's schema and RLS checks green |
| CI full gate green at merge | PASS. Run 44939370947 |
