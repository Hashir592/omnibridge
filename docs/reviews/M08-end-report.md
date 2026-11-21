# M08 end report (S3, 22 Nov 2026)

M08, the catalogue, ran under the ADR-077 fast lane: the contract PR, then one task (T-0801, high). M07 + M08 is one S4 milestone, so the milestone review starts now (handoff saved next to this report). The S4 Major on T-0702 (F-M07-T0702-01) is fixed in the same PR, ahead of that review.

## Tasks

| Task | Tier | PR | Status |
|---|---|---|---|
| Contract (all 15 M08 routes) | light | #139 | merged |
| T-0801 catalogue | high | #141, branch `task/T-0801-catalogue` | auto-merge on, CI runs the full gate |

## How it was built

**Contract (#139).** `packages/contract/src/routes/catalogue.ts` holds the routes for SKUs and bundles, manufacturers, VAT rates, COGS, listings, and the mapping import and export. All are on the Stock & Catalogue tab and workspace-shared; `createVatRate` is admin-only on the Settings tab. Money is integer pence and rates are basis points. S2 builds T-0316 on it.

**T-0801.**
- **First commit, the two M05 Minors (ADR-078 1):**
  - event security notices resolve 7 days after their event (`0041`, `apps/worker/src/security.ts`);
  - a catalog test checks that every app-callable definer that reads a setting-gated table filters its scope explicitly (`definers.int.test.ts`).
- **Money (FIN-1):** in `packages/core/src/money.ts`: `parsePounds`, `formatPounds`, `divHalfUp` (half-up in integers, used only where the PRD says), `timesPack` and `bundleAvailable`. A source scan in `tests/arch` and a schema rule (every `*_pence` column is `bigint`) keep floats out.
- **db-main `0042_catalogue.sql`:** every table is workspace-shared under ARCHITECTURE 6.1, with forced RLS and composite FKs.
  - `master_skus` (CAT-1): unique code per workspace. A bundle is one component plus a pack size; a trigger refuses a bundle as a component and any change to a bundle's make-up (CAT-3).
  - `sku_vat_types`: the VAT-type history (ADR-078 4). A bundle has no rows and follows its component.
  - `vat_rates` (CAT-2): every workspace starts with the four UK rates, through a trigger on workspace creation plus a back-fill. Zero-rated and No VAT are both 0% and stay separate types.
  - `cogs_history` (CAT-4): ex-VAT pence from a date; setting the same date replaces the value.
  - `listings` (CAT-5): origin-tagged (INT-6), unique by account and external SKU, with `provider` stored on the row so a child user's view loses nothing.
- **Lookups for M10's write-once snapshots:** `cogsOn`, `vatTypeOn` and `vatRateOn` in `CatalogueRepository` (`packages/db/src/catalogue.ts`). A bundle's COGS is the component's times the pack, and its VAT type is the component's.
- **Web (`apps/web/src/catalogue.ts`):** the 15 routes, each audited.
  - The COGS and mapping CSV imports apply all rows or none, have a dry run, and report errors by line, code and column.
  - A mapping import row sets the mapping it names.
  - The export uses formula-safe cells and refuses rather than truncate.
- **CAT-6:** every map, remap or unmap, whether by a user, a CSV or discovery, sends `catalogue.listing_mapped` (IDs only) in the same transaction. The worker runs its registered listeners; the list is empty until M09 and M10 add theirs.
- **Discovery (CAT-5):**
  - each channel adapter has a `listListings` reader with a versioned parser, and the mock endpoints are provisional;
  - `runListingScan` (provider-kit) reads every page through the governor in short transactions;
  - `listings.discover` upserts each page, auto-maps exact codes on first sight only (so a person's unmap sticks), and ends listings that a non-empty complete scan no longer finds;
  - it runs daily (03:15 platform sweep, then one job per workspace, then one per eBay or website account) and when an eBay account connects through OAuth.
- **Isolation walk:** it seeds B's SKU and listing and snapshots B's catalogue. A's own SKU is the positive control.

## Decisions made (also in the PR)

- Auto-match applies only to a listing's first discovery. A complete scan that found listings ends the ones it did not see; an empty scan ends nothing.
- eBay discovery reads the Inventory API items, so `external_id` is the SKU for now. M15 adds the offer's listing ID when it checks against eBay's spec.
- Amazon discovery and stock pushes join in M18, because both need the seller ID. The adapter reader and the mock exist already.
- Over-long titles are cut to 500 characters. Over-long codes (more than 200) are skipped and counted.
- The VAT rates of a new workspace come from a trigger, so every creation path gets them.
- A missing VAT type on a plain SKU is a 400 field error; catalogue rule refusals are 409; another workspace's IDs are 404.
- "Who may edit the catalogue" means the Stock & Catalogue tab; VAT rates are admin-only.

## Risks

- **Mock endpoints are provisional:** eBay `inventory_item`, Amazon `searchListingsItems` and website `products`. The official-spec checks stay with M12, M15 and M18 as S1 ruled.
- **Duplicated plumbing:** `runListingScan` repeats the token, governor and usage code of `runIncrementalSync` (review finding, skipped). A later fix to one must reach both. Follow-up: share one call-session helper.
- **Ended listings:** a disconnected account's listings are not ended until a Disconnect route exists (M07 follow-up). M09 clears manual settings through the ended hook.

## Test evidence

- **Tests first** (`packages/db/src/catalogue.int.test.ts`, 12 tests):
  - [CAT-1] unique code per workspace;
  - [CAT-2] the default rates, and `vatTypeOn` following the history and the component;
  - [CAT-4] `cogsOn` by date, where a later change leaves an earlier lookup unchanged;
  - [CAT-3] [AT-5] bundle COGS × pack, floor(available / pack), and the refusals;
  - [CAT-5] exact match only, queue, unmap kept, one SKU per listing, ended listings, long titles and codes;
  - [TEN-6] isolation.
- **Web** (`apps/web/src/catalogue.int.test.ts`, 4 tests): create, bundles, 400/409; VAT rates; the all-or-nothing COGS import; map, 409, CSV remap, export and the event.
- **Worker** (`apps/worker/src/discovery.int.test.ts`, 4 tests): eBay and website scans against the mocks, the daily fan-out, and the mapped listeners.
- **Also run locally:** isolation walk 4/4; db tenancy, schema rules, definers and migrate; worker sync, outbound and security (53/53); `verify.sh --quick` green; dependency-cruiser, contract tests and req-coverage clean.
- **[RL-4]** `carrier.test.ts`: a long Retry-After is not slept (F-M07-T0702-01).
- **Review:** `/code-review` at high effort. 10 findings: 9 fixed with regression tests, 1 skipped (the duplicated plumbing, a follow-up).

## Follow-ups

- Share one call-session helper between `runIncrementalSync` and `runListingScan`.
- M15: the eBay offer's listing ID for `external_id`; F-M07-T0702-02 (the eBay cap set by the caller).
- M18: Amazon discovery and `amazon.stock_push` with the seller ID.
