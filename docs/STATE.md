# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 25 Nov 2026 by S3 (T-1003).

## Now

- **Phase:** B, local Docker only. Plan of 12 Nov 2026 (ADR-054), fast lane from M07 (ADR-077), halfway pause (ADR-080). Module order is in `docs/plan/MODULES.md`.
- **Closed:** M01 to M05 (S4 M05 end APPROVED). The M06 site pieces are merged; it waits on the client's legal details.
- **M07, M08, M09 built** (end reports in `docs/reviews/`). The M08 milestone fix (#146) and the T-0901 review fixes (#151) are merged, for the M09 + M10 milestone to verify.
- **M10 built** (`docs/reviews/M10-end-report.md`):
  - #156 T-1000, #157 contract, #158 T-1001 (critical), #159 T-1002: merged;
  - #160 T-1001 fixes (S5's critical check): merged;
  - #164 F-M10-end-01, S4's Blocker: merged and confirmed by S4;
  - T-1003 buyer data and F-M10-end-22 (critical, branch `task/T-1003-m10-fixes-1`): auto-merge on, CI running.
- **Waiting on reviews:**
  - S4 M09 + M10 milestone: BLOCKED (`docs/reviews/M10-end.md`) until S4 confirms T-1004 (T-1003 is confirmed);
  - S5 check of #158: no Blocker, every Major fixed in #160 and T-1003; its report is committed with T-1003. S5 confirms T-1003;
  - **Review (S4, 25 Nov 2026): T-1003 (#167) CONTINUE; M09 + M10 still BLOCKED**, open on main cb348b9: 0 Blockers, 6 Majors (F-05, F-07 to F-11, all in T-1004), 9 Minors (`docs/reviews/M10-end.md`, Update: #167). F-11 gains 3 required tests; new Minor F-24;
  - Fix rule: Blockers at once; Majors in the first commit of S3's next task.
- **Next (S3):** the halfway pause (ADR-080) after T-1003's PR, then T-1004 (critical) on Hashir's "continue"; M11 after it. T-1004 drops the unused `vault.deleted_buyers` and keeps F-22's race test.
- **S2:** T-0318 orders screens, on the #157 contract (handoff `docs/handoffs/20261122-1850-S3-to-S2.md`).

## M10 in short (what later modules use)

- **Ingest:** `OrderIngest.apply(ctx, account, orders)` (`packages/db/src/orders.ts`) runs in the sync transaction, after the vault-first `prepare` (`apps/worker/src/orders.ts`, `orderIngestStream`).
  - Streams: `ebay.orders` and `website.orders`, polled every 5 minutes (`orders.sync-sweep`).
  - M11's website push should reuse `orderIngestStream`'s vault-first step and `OrderIngest.apply`.
- **PII:**
  - one vault record per order, subject `<channel_account_id>:<external_order_id>` (`orders.pii_subject`);
  - a record is written only once the order is paid and has a delivery address;
  - expiry: dispatch or delivery + 25 days, never past placement + 90 (`piiExpiryDate`, at ingest and in `orders.pii_expiry`, journalled); `effectiveDispatch()` is the one dispatch date;
  - an address the channel corrects before dispatch replaces the record in place (`/v1/replace`, worker only);
  - cancellation calls `requestDeletion`;
  - the nightly `orders.orphan-sweep` expires orphan records older than a day;
  - eBay deletion entries are in `vault.ebay_deleted_buyers` (vault-wide, 180 days).
- **Status:** the FA-10 table is in `packages/core/src/order-status.ts`. M12's label and dispatch moves (label_created, the void back to awaiting_dispatch) go through `nextOrderStatus`.
- **VAT:**
  - `computeOrderVat` / `computeRefundVat` (`packages/core/src/vat.ts`);
  - append-only `app.vat_ledger` rows (sale, refund, adjustment) with `group_key`, `tax_point_date` and `period_date` (`vatPeriodDate()`, the hook for filed periods in the VAT quarters module).
- **Snapshots:** `order_lines` vat_type, vat_rate_bp, cogs_pence and master_sku_id are write-once (trigger). A provisional line counts at `provisional_rate_bp`.
- **Stock:** reserve, release and dispatch run with the order line id.
  - `stock_moves` is false for orders placed before the account was connected.
  - `stock_push_held_since` holds a new account's writes until a clean reconciliation; T-1101's Connect route passes `holdStockPush: true`.
- **Reads and groups:** `OrderReads` (`packages/db/src/order-reads.ts`) handles the list, detail, returns, export and groups.
  - `orders.group_recompute` asks `vault.match`, then calls `applyGroups`.
  - M12's Ship together locks the members of `order_groups` and re-checks them.

## M09 and M08 in short

- **Stock engine:** `StockEngine` (`packages/db/src/stock.ts`) joins the caller's transaction. Pushes go only through `OutboundQueue`, eBay and website only. Reconciliation runs after each complete listing scan (INV-7). Refunds call `returnToStock` (not yet wired: channel refunds carry no return-to-stock flag).
- **Catalogue:** `CatalogueRepository` (`packages/db/src/catalogue.ts`), with `cogsOn`, `vatTypeOn` and `vatRateOn` per London day. CAT-6 listeners `stock` and `orders` run in `catalogue.listing_mapped`.
- **Money:** `packages/core/src/money.ts`; the provider kit's `penceFromAmount` reads channel amounts by text.

## M07 in short

- **Provider calls:** only through `ProviderHttp` in the worker (the OAuth exchange in web excepted), with mock-only hosts by `PROVIDER_MODE`.
- **Parsers:** `defineParser(provider, name, version, schema)`. A failure raises `platform.report_failure` once per version.
- **Sync:** `runIncrementalSync` (5-minute overlap, page-cap resume). The optional `prepare` hook runs with no transaction open.
- **Outbound writes:** go through `OutboundQueue.enqueue` in the caller's transaction. The kill switch and maintenance are read before each send.
- **Governors:** Amazon buckets and the eBay budget are separate packages (RL-3). Carriers and the website have a cap of 4.

## Follow-ups noted (for S1 to place)

- **From M07 and M08:**
  - Connect-new-account and Disconnect routes (T-1101): hold stock pushes, end the account's listings;
  - the shared call-session helper (T-1101);
  - the carrier-cap wait (T-1201);
  - Amazon 429 metering and CS-6 (M18);
  - token refresh race, eBay stock-push batching, F-M07-T0702-02 (T-1501);
  - credentials environment index (M22).
- **From M10:**
  - the 21st same-buyer member notice (needs a notification type, M12);
  - a settings route for `group_midnight_grace_hours` (TEN-6);
  - a return-to-stock flag on refunds;
  - Amazon orders and the returns report (M18);
  - re-index vault match keys before M22 (dev records from before T-1002);
  - a visible order flag for a channel total that does not add up (today a platform notice).
- **M12:** the vault's `LabelFiles` hook deletes label files with their records.
- **M15:** the eBay endpoint's token and keyset move into app secrets. **M18:** LWA rotation reminders. **M21:** platform-audit read route.
- **PS-026 / picomatch:** the audit exception **expires 1 Dec 2026**. Bump the package when a fix ships and delete the entry.
- **M22 (backups):** apply `infra/backup/b2.md`; nightly `backup.sh` and `retention.sh`; the 15-minute journal timer (now also expiry lines); pin restic by digest on `ob_backup`; backup-age alert.

## Rules in force

- **Speed (ADR-056):** never wait for CI (auto-merge); one review per PR; browser only when it proves something.
- **Process (ADR-053, ADR-054, ADR-077, ADR-080):** sessions merge their own green PRs; CI is the only full gate; S3 takes a halfway pause per module.
- **Semgrep (ADR-079 0):** it is now a required gate job (#156).
- **Hashir's "go":** needed only for critical tasks, and comes with the module paste.
- **Hashir:** GitHub CLI on Hashir592. Docker Desktop must be running for integration tests.
