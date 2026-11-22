# M09 T-0901 findings (critical PR review), round 1

Reviewed: T-0901, PR #143 (merge 72b5526, branch `task/T-0901-stock-engine`), read on main b17c874 (which also holds #146, the F-M08-end-01 fix).
Gate: CI on the PR (run 44944011111) green on every check. CI on main for the merge (run 44944433081) failed in `ui tests` only: one e2e, `apps/ui/e2e/platform.spec.ts:36` "[PLAT-1] [NFR-8] every console section has no serious accessibility issues". #143 changes no file under `apps/ui`, and the next three main runs (#144, #146, #145) are green, so this is a flaky console UI test, not T-0901. Worth a look by whoever owns the console e2e.
Local: the stock, outbound, discovery and isolation integration files could not run here: Docker Desktop stopped during the session ("Could not find a working container runtime strategy"; 41 skipped, 0 failed). The PR's CI ran them green. The code review below does not depend on them.
Acceptance: T-0901's tests exist with the cited IDs, and CI ran them green. INV-3 is not proven for a line whose mapping changes: F-M09-T0901-01.

Verdict: **FIX REQUIRED**. Blockers 0, Majors 1, Minors 2. Under ADR-077, S3 fixes the Major in the first commit of M10 (before M10 calls `reserve`, `release` and `dispatch`); the M09 + M10 milestone review confirms it.

## The six checks

| # | Check | Result |
|---|---|---|
| 1 | ADR-078 5 | PASS, apart from F-01. `0043`: `stock_movements` has the unique key `(workspace_id, source_kind, source_id, kind)`. A BEFORE UPDATE/DELETE/TRUNCATE trigger refuses every change. The only exception is `purge_stock_movements()`, which works on the current workspace only, with a fixed 3-year cut-off. `stock_levels`: DELETE revoked, `reserved >= 0`. `#move` (`stock.ts:1076-1122`) locks the stock row (`#lock`, `FOR UPDATE`), inserts with `ON CONFLICT DO NOTHING`, and moves the numbers only when the insert was new, so a repeated event is a no-op. No other code writes `on_hand` or `reserved`. |
| 2 | INV-4, C7.1 | PASS. `#recompute` (`:1322-1370`) works out every listing's target under the component lock and queues a write only when it differs from `last_queued_qty` (or when forced). The older pending write is cancelled (`cancelPending`, guarded by `state = 'pending'`). Idempotency key `stock:<listing>:<seq>`. The selling listing counts down unless a write is still pending or sending (`reserve`, `:257-270`). `#reorderGuard` re-sends when the current write was sent before an older write landed. |
| 3 | Transaction and lock order | Transaction: PASS. `withBoundTenant` (`tenant.ts:98`) joins the bound transaction, so the movement, the outbound write (`OutboundQueue.enqueue`), `listing_writes` and the notice commit together. Lock order: PASS everywhere (stock row, then listing; `#lockComponents` in id order), except one path: F-M09-T0901-02. |
| 4 | Tests | PASS. Every C7.3 row has its own AT-27 test (`stock.int.test.ts:353-631`). The INV-6 test runs 20 reserves at once, each in its own transaction (`Promise.all`, `:295`): 20 applied, 15 oversold, others told 0. AT-4 runs end to end against the mocks in `apps/worker/src/stock.int.test.ts`. Missing: reserve, remap, then dispatch; and dispatch or release with no live reserve (F-01). |
| 5 | INV-8, INV-7 | PASS. The settle hook runs in the outbound handler's `commit` (`apps/worker/src/outbound.ts:104-112`) and is called again when a retry finds the write already settled. `recordPushResult` only sets fields to the write's values, so a repeat changes nothing; `raise` dedupes. `reconcile` runs from `complete` after a complete scan. It skips FBA, listings with an order in the 15 minutes before the scan, listings with a write still on its way, and listings with a write sent after the scan read them. Since #146, `complete` runs only for the newest scan of the account. |
| 6 | ARCHITECTURE 6.1 | PASS. All six new tables are workspace-shared, with forced RLS, the workspace policy and composite FKs. `order_company_id` is used only for `company_visible` (`movementSelect`), worked out against `app.company_ids`; no order data is copied. `channel_stock_settings` is its own workspace table, so a child user's change still recomputes accounts they cannot see. |

## F-M09-T0901-01 — Major — release and dispatch use the listing's current mapping and the caller's quantity, not the line's own reserve
Area: Correctness, Invariants  IDs: INV-1, INV-3, CAT-5, CAT-6

Evidence:
- `#orderMove` (`stock.ts:985-1011`) works out the SKU from `#listingSku`, which reads the listing's mapping **now**, and the quantity from the caller. It never reads the line's `reserve` movement.
- `#move` (`:1098`) clamps reserved at `max(0, reserved + change)`, so a release or dispatch with nothing reserved for that line takes units reserved by other orders.
- The unique key holds one row per kind, so `release` after `dispatch` (or the reverse) is a new event and applies. A re-reserve after a release is a no-op.
- `onListingMapped` (`:540-592`) back-fills `openLines` on the new SKU, but a line already reserved on the old SKU keeps that row: the back-fill reserve conflicts on the same key and moves nothing.

Failures:
1. **Remap with open orders:** line L reserves 2 of SKU X; the listing is remapped to Y; L is dispatched. Y's on hand drops by 2 and Y's reserved drops by 2 (taken from other orders). X's 2 units stay reserved for ever. Both SKUs are wrong, and every channel of Y is told too much, which is the oversell INV-6 exists to prevent.
2. **Dispatch with no reserve:** for example a line first seen already shipped, or with its reserve lost. The dispatch takes other orders' reserved units.
3. **Cancel after dispatch, or dispatch after cancel:** the second event applies, and reserved drops twice.

Nothing is wrong today, because no caller exists until M10. M10 calls these three methods from the order sync, which is why this needs fixing first.

Required fix:
- `release` and `dispatch` work from the line's own reserve: lock it, take its `master_sku_id` and `reserved_change` (net of any earlier release or dispatch of the line), and move exactly that on that SKU. If the line has no live reserve, `release` is a no-op and `dispatch` moves on hand only, with no reserved change. A release after a dispatch, or a dispatch after a release, does nothing to reserved.
- On a remap, move each open line's live reservation from the old component to the new one, in the mapping transaction, with movements the log can show (for example a release on the old SKU and a reserve on the new one, under a key that includes the mapping change).
- Tests, citing `[INV-3]` and `[CAT-5]`:
  - reserve, remap, then dispatch: both SKUs end right;
  - dispatch with no reserve leaves other orders' reserved alone;
  - release after dispatch changes nothing.

Resolution: (S3 fills in)

## F-M09-T0901-02 — Minor — recordPushResult locks the listing before the stock row on the reorder path
Area: Performance, Correctness  IDs: INV-8, INV-4

Evidence: `recordPushResult` updates `app.listings` (`stock.ts:638` or `:644`), which takes the listing row lock, then calls `#reorderGuard` (`:650`), which takes the stock row lock (`#lock`). `reserve` takes the stock row (in `#move`) and then updates the listing. The handoff states "stock row before listing everywhere".

Failure: a late older write settles (the reorder case) while an order on the same listing reserves. Each holds one lock and waits for the other, and PostgreSQL aborts one with 40P01 after `deadlock_timeout`. Both paths are retried as jobs, so nothing is lost. But it is the one path that breaks the stated lock order, and it is rare enough to slip past tests.

Required fix: in `recordPushResult`, lock the listing's component stock row (`#listingSku` + `#lock`) before any `app.listings` update.

Resolution: (S3 fills in)

## F-M09-T0901-03 — Minor — Reconciliation of an account runs in one transaction across all its SKUs
Area: Performance  IDs: INV-7

Evidence: `reconcile` (`stock.ts:704-783`) locks each component's stock row in turn and recomputes it, all in one transaction. The locks are held until the whole account is done.

Failure: an account with thousands of listings holds most of its SKUs' stock rows for the whole run, so order reserves and pushes for those SKUs wait behind the daily check.

Required fix: one short transaction per component (the per-component logic already stands alone), and a test citing `[INV-7]` that a reserve on another SKU of the account is not blocked during reconciliation.

Resolution: (S3 fills in)

## Not raised (noted as known)
- Amazon pushes come in M18 (seller ID), EBAY-9 revision holds in M15, and order references with M10.
- The failed main run's console UI e2e is outside T-0901 (see Gate).
