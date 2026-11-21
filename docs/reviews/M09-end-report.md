# M09 end report (S3, 22 Nov 2026)

M09, the stock engine, ran under the ADR-077 fast lane: a contract PR, then T-0901 (critical; Hashir's go came with the 21 Nov paste). T-0901 gets its own S4 review after merge (handoff saved next to this report). The next S4 milestone is M09 + M10.

## Tasks

| Task | Tier | PR | Status |
|---|---|---|---|
| Contract (12 stock routes) | light | #142 | merged |
| T-0901 stock engine | critical | #143, branch `task/T-0901-stock-engine` | auto-merge on, CI runs the full gate |

## How it was built

**Contract (#142).** The routes live in `packages/contract/src/routes/stock.ts`:
- stock list and detail, with each listing's target, capped-by-stock flag, last push and sync state;
- the change log and its CSV export;
- stock-in, adjustments and the stock-take import;
- buffers;
- the version-checked allocation save, and Back to Auto.

A new error code, `version_conflict`, means "review again" (C7.2). S2 builds T-0317 on this contract.

**T-0901.**
- **db-main `0043_stock_engine.sql` and `0044` (validates the new rule):**
  - `stock_levels`: on hand, reserved and a version, one row per plain SKU;
  - `stock_movements`: append-only (a trigger refuses UPDATE and DELETE), with the unique key (source kind, source id, kind) and a 3-year purge definer;
  - `listing_writes` and `movement_pushes`, which link each movement to the writes it caused;
  - `channel_stock_settings`, holding the buffers (workspace-shared, so a child user's save sees every account);
  - `stock_reconciliations`;
  - new columns on `listings` for the mode, the manual allocation, the buffer override, the last quantity queued and sent, and the sync and drift state.
- **Target maths:** `packages/core/src/stock-targets.ts`, pure and integer-only.
  - Auto: max(0, floor((available − buffer) / pack)).
  - Manual: the lower of what is left of the allocation and that stock figure, with the capped flag.
- **Engine (`packages/db/src/stock.ts`).** One rule for every change:
  1. lock the component's stock row;
  2. insert the movement under its unique key;
  3. only if it was new, move the numbers;
  4. recompute every affected listing's target: the SKU's own and its bundles', MFN only, not ended, on the eBay and website channels;
  5. queue a write through the M07 `OutboundQueue` only where the target changed, cancelling the older write still waiting.

  Further detail:
  - **Transactions:** the engine runs in its caller's transaction with a bound context, so the movement, the write and the notice commit together.
  - **The selling listing:** it is taken to have counted down on its own (C7.1), unless a write is still on its way to it; then that write is replaced.
  - **Late deliveries:** an older write that lands after a newer one triggers a corrective write.
  - **API for M10 and M12:** `reserve` (returns `oversold` and raises the Oversold notice), `release`, `dispatch` and `returnToStock`.
  - **By hand:** `stockIn`, `adjust` (`other` needs text) and `stockTake`, keyed by the form's `client_ref` or by the import.
- **Manual allocation (C7):**
  - the save checks the SKU's version in the same transaction;
  - every change goes to the change log (kind `allocation`) and the audit log;
  - an info notice fires when an allocation is used up;
  - Back to Auto sends one write per listing at once;
  - a remap resets the listing to Auto with a notice;
  - an ended listing loses its settings;
  - FBA is refused (INV-9).
- **Push results (INV-8):** `outbound.send` calls the settle hook, which records `last_sent_qty`, or sets Sync failed and raises the notice on a final failure or a refused SKU. A retried commit settles again.
- **Reconciliation (INV-7):** after every complete listing scan (the daily 03:15 one included), each listing's channel quantity is compared with its target. Drift is corrected and logged. A listing with an order in the 15 minutes before the scan, or a write on its way or sent since the read, is skipped. Two drifts in a row raise the notice.
- **CAT-6:** the worker's mapped listener back-fills the movements of orders taken while the listing was unmapped, once, through the `UnmappedDemand` port (M10 implements it; it is empty until then).
- **SAFE-1:** the `stock_push` bulk action sends every listing of the confirmed accounts its target.
- **Retention:** the housekeeping sweep sends `stock.retention` daily (3 years).
- **Web (`apps/web/src/stock.ts`):** all 12 routes, audited, with workspace-shared reads. A movement's order reference stays hidden from a user without that company.

## Decisions made (also in the PR)

- Writes go to eBay and the website. Amazon MFN shows its target but is pushed from M18, which brings its seller ID and stock-push operation.
- One write per listing (one SKU per payload), so the per-listing collapse and the result are simple. eBay batching is a follow-up if the budget gets tight.
- A single version per SKU (the stock row's) covers both stock and allocation changes for the C7.2 check.
- An allocation change is a change-log row with no stock change, and the audit log has one row per listing.
- The movement's order company lives in `order_company_id`, used only to hide the order reference (6.1). The table stays workspace-shared.
- `include_bundles` is gone from the allocation save. The client names the bundle listings the product switch covers; Back to Auto keeps the flag.
- "Who may allocate" means the Stock & Catalogue tab.

## Risks

- **Pushes per listing:** a SKU with many listings costs one call each. The eBay budget is counted before each send, as in M07.
- **Order references in the change log:** they arrive with M10's orders. Until then an order row shows "order" or "another company".
- **eBay revision holds (EBAY-9):** they stay with M15. M09 already sends only when a target changes.

## Test evidence

- **Tests first** (`packages/db/src/stock.int.test.ts`, 26 tests):
  - [INV-1] [INV-3] each movement kind, and a repeated event is a no-op;
  - [INV-6] 20 parallel orders on 5 units give 15 Oversold;
  - [AT-4] [INV-4] [INV-9] the other listings get the lower quantity, while FBA and the seller get none;
  - one write per listing, with a stale waiting write replaced;
  - [INV-2] buffers;
  - [AT-27] the four steps, plus one test per C7.3 row;
  - [INV-10] used up, and an older order's cancellation;
  - [INV-8], [INV-7], [INV-5] (pushes by result, append-only, the 3-year purge);
  - [CAT-6] back-fill once; lock order under concurrency; [TEN-6].
- **Worker end to end** (`apps/worker/src/stock.int.test.ts`): [AT-4] one eBay sale reaches the website mock as 9 within the measured 2-minute budget; [INV-8] Sync failed on the last retry, cleared by the next good push.
- **Web** (`apps/web/src/stock.int.test.ts`, 3 tests); the isolation walk (111 routes); `[INV-2] [INV-10]` unit tests for the target maths.
- **Local runs:** `verify.sh --quick` green; dependency-cruiser and req-coverage clean.
- **Review:** `/code-review` at high effort. 8 findings (4 important, 4 nits), all fixed with regression tests.

## Follow-ups

- **M10:** implement `UnmappedDemand`; call `reserve`, `release` and `dispatch` with the order line; store the Oversold flag on the line; supply order references to the change log.
- **M12:** call `dispatch` on dispatch events.
- **M15:** eBay revision counter and hold (EBAY-9); batching stock pushes if the budget needs it.
- **M18:** `amazon.stock_push` with the seller ID; Amazon listings join the pushed providers.
