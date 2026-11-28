# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 28 Nov 2026 by S3 (T-1101).

## Now

- **Phase:** B, local Docker only. Plan of 12 Nov 2026 (ADR-054), fast lane from M07 (ADR-077), halfway pause (ADR-080). Module order is in `docs/plan/MODULES.md`.
- **Closed:** M01 to M05, M07 to M10 (M06 still waits on the client's legal details). M09 + M10 milestone APPROVED by S4 (`docs/reviews/M10-end.md`).
- **M11 built** (`docs/reviews/M11-end-report.md`): #175 contract merged; T-1101 (risk high) on `task/T-1101-website-connector`, PR with auto-merge. It closes F-M10-end-14, -17, -25, -26, -27 and S5-20261124-07, and PS-037 (2), (3) as ADR-086 rules them.
- **Review:** S4 reviews M11 with M12 (S1's M11 paste); no S4 block for T-1101 alone.
- **Open for S1:** PS-038 (`packages/order-ingest` in ARCHITECTURE), PS-039 (website listings by push; where a website may be called).
- **Fault runs (ADR-085):** S3 proves tests by red-first commits and plants a fault by hand only for a guard, on that test alone; task-wide runs are S4's.
- **Next (S3):** M12 on S1's M12 paste. Not before.
- **S2:** T-0318 orders screens; T-0319 website screens on the #175 contract.

## M11 in short (what later modules use)

- **Website routes:** setup and Disconnect are session routes (Connections tab, admins); the website's own calls are signed routes under `/api/v1/website/{connectionId}` (`apps/web/src/website.ts`). Every one is behind the `website_connector` module (404 when off).
- **Inbound:** `once()` gives a call its Idempotency-Key handling (`app.website_idempotency`); the push runs `orderIngestStream`'s prepare with no transaction open, then `OrderIngest.apply`. Cancel and refund use `OrderIngest.asStored` and `apply`. Products upsert listings and reconcile them (FA-16 hold released on a clean first run).
- **Outbound:** `website.stock_push` and `website.shipment` (worker `outbound.ts`), signed by `@omnibridge/provider-website`. **M12 queues `website.shipment`** when a website order ships. Website writes retry 1 minute to 24 hours (13 attempts), then fail with one `website.delivery_failed` alert.
- **Credential:** `AccountCredentials.read(ctx, id, 'website')` gives `{ apiKey, signingSecret, baseUrl }` as one secret. `ProviderHttp.site(baseUrl)` allows HTTPS to a dotted public name only.
- **Reads:** website orders are read nightly from 02:00 London; a website has no listing scan (its products come by push).
- **Disconnect:** archive, end listings (C7.3), delete credentials, audit once; history stays.
- **Kit:** `callSession` is the one place for token, governor, usage and health code of a run of reads.

## M10 in short (what later modules use)

- **Ingest:** `OrderIngest.apply(ctx, account, orders)` (`packages/db/src/orders.ts`) runs in the sync transaction, after the vault-first `prepare` (`apps/worker/src/orders.ts`, `orderIngestStream`).
  - Streams: `ebay.orders` every 5 minutes, `website.orders` nightly (`orders.sync-sweep`).
- **PII:**
  - one vault record per order, subject `<channel_account_id>:<external_order_id>` (`orders.pii_subject`);
  - a record is written only once the order is paid and has a delivery address;
  - expiry: dispatch or delivery + 25 days, never past placement + 90 (`piiExpiryDate`, at ingest and in `orders.pii_expiry`, journalled); `effectiveDispatch()` is the one dispatch date;
  - an address the channel corrects before dispatch replaces the record in place (`/v1/replace`, worker only), and so does a newer block met by a repeat ingest; masks never overwrite;
  - a stand-in dispatch date is marked `dispatch_estimated`; the first real date replaces it once and the deletion date is worked out again;
  - cancellation calls `requestDeletion`;
  - the nightly `orders.orphan-sweep` expires orphan records older than a day;
  - eBay deletion entries are in `vault.ebay_deleted_buyers` (vault-wide, 180 days).
- **Status:** the FA-10 table is in `packages/core/src/order-status.ts`. M12's label and dispatch moves (label_created, the void back to awaiting_dispatch) go through `nextOrderStatus`.
- **VAT:**
  - `computeOrderVat` / `computeRefundVat` (`packages/core/src/vat.ts`);
  - append-only `app.vat_ledger` rows (sale, refund, adjustment) with `group_key`, `tax_point_date` and `period_date` (`vatPeriodDate()`, the hook for filed periods in the VAT quarters module).
- **Snapshots:** `order_lines` vat_type, vat_rate_bp, cogs_pence and master_sku_id are write-once (trigger). A provisional line counts at `provisional_rate_bp`.
- **Amounts (ADR-081 1 to 3):** until payment, a newer update replaces amounts and line prices, and a changed line is closed (`removed_at`) and a new one added; after payment nothing changes (0056 triggers) and `orders.amounts_differ` marks a late change, a channel total that differs or a refund above the order. Every read leaves closed lines out.
- **Sync:** `runIncrementalSync` stores 25 orders a transaction. Lock order everywhere: orders by id, then stock rows by component id (`StockEngine.lockFor`), then the rest; listings `FOR NO KEY UPDATE`.
- **Stock:** reserve, release and dispatch run with the order line id.
  - `stock_moves` is false for orders placed before the account was connected.
  - `stock_push_held_since` holds a new account's writes until a clean reconciliation.
- **Reads and groups:** `OrderReads` (`packages/db/src/order-reads.ts`) handles the list, detail, returns, export and groups.
  - `orders.group_recompute` makes one batched `vault.match` call, then calls `applyGroups`; it is queued once a minute per account at most, and only when an order joins or leaves the ones that can group;
  - the list pages through `orders_placed`; search is by prefix on the `search_*` columns (0059, 0060);
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
  - the carrier-cap wait (T-1201);
  - Amazon 429 metering and CS-6 (M18);
  - token refresh race, eBay stock-push batching, F-M07-T0702-02 (T-1501);
  - credentials environment index (M22).
- **From M10:**
  - the 21st same-buyer member notice (needs a notification type, M12);
  - a settings route for `group_midnight_grace_hours` (TEN-6);
  - a return-to-stock flag on refunds;
  - Amazon orders and the returns report (M18);
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
