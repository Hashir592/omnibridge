# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 22 Nov 2026 by S3 (M09 end; T-0901 in PR #143).

## Now

- **Phase:** B, local Docker only. Plan of 12 Nov 2026 (ADR-054), fast lane from M07 (ADR-077). Module order is in `docs/plan/MODULES.md`.
- **Closed:** M01 to M05 (S4 M05 end APPROVED, `docs/reviews/M05-end.md`). The M06 site pieces are merged; it waits on the client's legal details.
- **M07 built** (`docs/reviews/M07-end-report.md`): #131, #133, #134 (critical; S4 FIX REQUIRED, `docs/reviews/M07-T0702-findings.md`), #137, #138. The Major F-M07-T0702-01 is fixed in #141; the Minor goes to M15.
- **M08 built** (`docs/reviews/M08-end-report.md`): contract #139 and T-0801 #141, merged.
- **M09 built** (`docs/reviews/M09-end-report.md`): contract #142 merged; T-0901 #143 (critical, auto-merge, full gate in CI).
- **S4:** the milestone review of M07 + M08 (`docs/handoffs/20261122-0100-S3-to-S4.md`) and the critical review of T-0901 (`docs/handoffs/20261122-0300-S3-to-S4.md`). The next milestone is M09 + M10.
- **Next (S3):** M10, when Hashir pastes it.
- **S2:** T-0316 catalogue screens (M08 client); T-0317 stock screens (M09 client; note `docs/handoffs/20261122-0300-S3-to-S2.md`).

## M08 in short (what later modules use)

- **Catalogue repository:** `CatalogueRepository` (`packages/db/src/catalogue.ts`). Its lookups `cogsOn`, `vatTypeOn` and `vatRateOn` take a London day and are what M10's write-once snapshots read. A bundle follows its component.
- **Money:** `packages/core/src/money.ts` (`parsePounds`, `formatPounds`, `divHalfUp`). Pence are bigint inside and numbers on the wire.
- **CAT-6:** `catalogue.listing_mapped` (IDs only), sent in the changing transaction. Register a `ListingMappedListener` in the worker (`apps/worker/src/catalogue.ts`). A `ListingsEndedListener` hears listings that a complete scan no longer found.
- **Discovery:** `listings.discover` per account (daily and on an eBay connect) through `runListingScan`. Amazon joins in M18 (seller ID).

## M07 in short (what later modules use)

- **Provider calls:** only through `@omnibridge/provider-kit`'s `ProviderHttp`, called from the worker, except the OAuth code exchange in web (`apps/web/src/oauth-exchange.ts`).
  - Hosts are allowlisted by `PROVIDER_MODE`: mock reaches provider-mocks only, on the internal `ob_mocks` network.
- **Parsers:** `defineParser(provider, name, version, schema)`. A missing field raises `platform.report_failure` once per parser version and ends the job without a retry.
- **Sync:** `runIncrementalSync` with cursors (5-minute overlap, page-cap resume). Sinks must upsert by external ID (INT-8).
  - Stream `ebay.orders` is the reference; M10 adds the vault-first sink.
- **Origin tags:** tables with an `external_id` call `app.add_origin_columns` (INT-6).
- **Connections:** health and status on `channel_accounts`, in the order disconnected > needs_reauth > paused > error > active.
  - 3 auth failures in an hour, or a revocation, set `needs_reauth` and raise `channel.auth_lost`. The next success resolves it.
- **Credentials:** encrypted per account, tagged with their environment. `AccountCredentials.replace` keeps the old token for 7 days.
- **Outbound writes (invariant 20):** every automated write goes through `OutboundQueue.enqueue` in the caller's transaction.
  - Payloads hold IDs, SKUs and numbers only.
  - Register the operation in `apps/worker/src/outbound.ts`; M07 has `ebay.stock_push` and `website.stock_push`.
- **Switches:**
  - kill switch: `PUT /connections/:id/kill-switch`;
  - maintenance: `PUT /platform/maintenance`.
  - Both are read just before each send. Held writes resume once.
- **Bulk writes (SAFE-1):** register a `BulkActionHandler` in web's `connections.bulk.actions`. The registry is empty until M09.
- **Governors:** the worker composes `createProviderGovernor`.
  - Amazon: buckets and backoff in `packages/governors/amazon`; operation limits in `AMAZON_OPERATION_LIMITS`.
  - eBay: the budget in `packages/governors/ebay`; caps in `EBAY_DAILY_CAPS`, which M15 reads from getRateLimits.
  - Carriers and website: a cap of 4.
  - Never import one governor from the other, and never share a retry helper (RL-3, dependency-cruiser).
- **Mocks:** `POST /_mock/scenarios {provider, account, scenario}` per account. Evri, DPD, website and Ads endpoints are provisional until their modules.

## M09 in short (what later modules use)

- **Stock engine:** `StockEngine` (`packages/db/src/stock.ts`) joins the caller's transaction. M10 calls `reserve` (which returns `oversold`), `release` and `dispatch` with the order line and listing; M12 calls `dispatch`; refunds call `returnToStock`.
- **Back-fill:** M10 implements `UnmappedDemand.openLines(listingId)` for CAT-6.
- **Pushes:** they go only through `OutboundQueue`, one write per listing, on a target change. eBay and website only; Amazon joins in M18.
- **Push results:** the worker's `outbound.send` settle hook records them (INV-8). Reconciliation runs after each complete listing scan (INV-7).

## Follow-ups noted (for S1 to place)

- **From M07** (details in the end report):
  - Connect-new-account and Disconnect routes;
  - the CS-6 buyer messages route (M18);
  - the carrier-cap timeout should be a governor wait;
  - Amazon 429 retries should be re-metered;
  - the token refresh race;
  - environment in the credentials unique index (M22).
- **From M08:** share one call-session helper between `runIncrementalSync` and `runListingScan`; the Disconnect route should end the account's listings (C7.3). **M15:** the eBay offer's listing ID as `external_id`; F-M07-T0702-02 (the eBay cap set by the caller). **M18:** Amazon discovery and `amazon.stock_push` with the seller ID.
- **ADR-068, for M08 and M10:** expiry changes journalled; no re-ingest after an eBay deletion (tombstone check); eBay username reuse matched by user ID first.
- **M07 and M08:** Amazon revocation and eBay termination call `requestDeletion` with the channel account. The eBay key fetch cap (5 a minute) is per web process.
- **M10:**
  - ingest is not idempotent per subject, so key buyer records by order;
  - call `requestDeletion` on cancellation;
  - set `delete_after` at dispatch or delivery plus pii_expiry_days (vault backstop 90 days).
- **M12:** the vault's `LabelFiles` hook deletes label files with their records.
- **M15:** the eBay endpoint's token and keyset move into the app secrets store. **M18:** LWA rotation reminders. **M21:** platform-audit read route.
- **PS-026 / picomatch:** the audit exception (GHSA-fc5q-39xc-vjpf) **expires 1 Dec 2026**. When a fix ships, bump it and delete the entry.
- **M22 (backups):**
  - apply `infra/backup/b2.md`;
  - schedule `backup.sh` nightly, plus `retention.sh`;
  - host timer for the 15-minute journal run;
  - pin the restic image by digest, on its own `ob_backup` network;
  - backup-age alert (OPS-4).

## Rules in force

- **Speed (ADR-056):** never wait for CI (auto-merge); one review per PR; browser only when it proves something.
- **Process (ADR-053, ADR-054, ADR-077):** sessions merge their own green PRs; CI is the only full gate.
- **Hashir's "go":** needed only for critical tasks, and comes with the module paste.
- **Hashir:** GitHub CLI on Hashir592. His dev machine is getting 16 GB.
