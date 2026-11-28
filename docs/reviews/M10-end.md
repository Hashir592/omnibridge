# M09 + M10 milestone findings, round 1

Reviewed: M09 (#142, #143, fixes #151) and M10 (T-1000 #156, contract #157, T-1001 #158, T-1002 #159), on main 35746f5. The critical review of #158 is folded in here. Also re-checked: #141, #146 and #151.
Gate: CI green on main 35746f5 (run 45429202845), on 55d558b, and on every PR in scope, except Semgrep red on #151 (the ADR-079 0 gap, closed by #153 and #156).
Local: `verify.sh --quick` PASS (333 s; a first run had one 5 s unit timeout, `webhooks/ebay.test.ts`, while other suites loaded the machine). Integration re-run: 15 files, 142/142 PASS (db orders, stock, catalogue, definers, migrate; worker orders, stock, discovery, outbound; web orders, isolation, stock, privacy; vault, restore), plus db `tenancy` 16/16.
Probes: about 20 ad-hoc tests on bd1741d; the later commit 0f3c393 changes only the testkit and the end report. Tests-can-fail check: 123 planted faults on 0f3c393. None of it is committed.
Acceptance re-run: 22/24 PASS (table at the end).

Verdict: **APPROVED** (27 Nov 2026, on main cba5199; see Update: #173). Found: Blockers 3, Majors 9, Minors 15. **Open: Blockers 0, Majors 0, Minors 7 (F-14, F-16, F-17, F-23, F-25 to F-27 as follow-ups).** Fixed by #173: F-05, F-07 to F-13, F-15, F-20, F-21, F-24. Fixed by #160: F-02, F-03, F-04, F-16. Fixed by #164: F-01. Fixed by #167: F-06, F-18, F-19, F-22. Every earlier Major is resolved and verified. M09 has no open finding of its own; the one M09 gap (Oversold on back-fill) is inside F-M10-end-01.

As S3 asked on 24 Nov, its halfway check and its two `/code-review` runs are not counted as independent looks at T-1001.

## Update: #160 (main ecb1834, CI green, run 45446699363)

#160 merged 16 seconds after this file. Everything below describes 35746f5; I re-ran the probes on ecb1834:

| Finding | On ecb1834 |
|---|---|
| F-01 | **Open.** Same result: `filled: 0`, no movement, £2.00 VAT kept; `oversold` false at 50 reserved of 10. |
| F-02 | Fixed. £15.00 refund with £12.00 of lines: ledger nets to 0 / 0. |
| F-03 | Fixed. 7 lines: `rate:2000` 0, `zero:zero` £84.00. Keys are a digest; a different entry under a taken key is an error. |
| F-04 | Fixed. Nothing is stored before payment and an address; the full record is stored at the second poll. An address that changes after the record is written is still not updated (eBay does not change it after payment, T-1501 to confirm). |
| F-05 | **Open, and harder.** Still £18.00 / £3.00 for £13.80 / £2.30. Db-main 0052 (#160) now refuses any change of goods, discount, shipping or gross, so the fix needs a rule from S1 first. The new total check raises a notice for new orders. |
| F-06 | **Open.** With a real address: still placement + 113 days (the adapter still gives `lastModifiedDate` as the dispatch time of a first-seen FULFILLED order, and no bound by placement). |
| F-07 | **Open.** Both actions still regroup. |
| F-08 | **Open.** 301 calls and 301 log rows for 301 orders. |
| F-09 | **Open.** `order-reads.ts` is unchanged. |
| F-10 | **Open.** 10 deadlocks in 10 runs; `sync.ts` is unchanged. Timings not re-measured. |
| F-11 | **Open.** 36 of the 37 required faults still survive; O10 (the 25-day window at ingest) is now caught. |
| F-12 to F-21 | F-16 fixed (deliveryDiscount read, totals compared). F-12, F-13, F-14, F-15 and F-17 reproduced again. F-18 to F-21 not re-run. |

I checked #160 only against these findings. It is not an independent review of the rest of #160 (its own review was by the session that wrote it); S5 checks it.

## Update: #164, F-01 only (main 32c8f7a, CI green, run 45609666835)

Own probes on real PostgreSQL, each store and each event in its own transaction as the worker runs them (both listeners in one). `verify.sh --quick` PASS (302 s). 7 integration files, 109/109 PASS (db orders, stock, catalogue, migrate; worker orders, discovery, stock).

**F-01 is resolved.**

| Check | Result |
|---|---|
| My probe: order, discovery, manual mapping, event, dispatch | PASS. `filled: 1`, reserved 2, then on hand 8 and reserved 0. Ledger `rate:2000` £0.00, `zero:zero` £12.00. |
| Automatic mapping | PASS |
| Dispatched before discovery or mapping | PASS for a line with no listing yet. A line whose listing is already known: **F-22**. |
| Oversold on back-fill (50 on a stock of 10) | PASS. Line and order flagged, one notice after two events. |
| Two lines of one code on a mixed order, refunded before mapping | PASS. `rate:2000` £13.20 / £2.20, `zero:zero` £13.80. |
| Three events of one listing at once, 8 runs | PASS. No deadlock, nothing moved twice. |
| Race: order stored while its listing is matched | PASS |
| Race: dispatch stored while its listing is mapped | PASS for a line with no listing; fails for a linked line dispatched after the mapping commits and before its event (F-22). S3's test sets `listing_id` to NULL first. |
| 40 random runs (store, dispatch, cancel against map and event), 240 lines | No listing before: 120 of 120 right. Listing known: 7 of 120 wrong, all F-22. |
| Lock order, stock before the listing on the mapping side | PASS |
| Lock order, a page of several orders | FAIL, see F-10. Retried, nothing lost. |
| Time at 100,000 lines, 20,000 provisional | PASS. Each new query under 100 ms. |
| 0053 | Expand only, concurrent, no waiver. |
| 13 planted faults of my own | 12 caught. Removing the lock on linked lines (the first branch of `lockOrders`) passes unnoticed: F-22. |

## Update: #167, T-1003 (head a6b43fa, main cb348b9; CI green, runs 45626895360 and 45628150182)

**Verdict for #167: CONTINUE.** No new Blocker or Major. F-06 and F-22 are resolved, and so are the Minors F-18 and F-19. M10 stays BLOCKED on T-1004.

Local: `verify.sh --quick` PASS (232 s). Integration on a6b43fa: 8 files, 162/162 PASS (vault, restore, pii-db, db orders and stock, worker orders). Own probes on real PostgreSQL clusters. I wrote the probes and faults before I read S5's confirmation (#169).

| Acceptance (T-1003) | Result |
|---|---|
| Every probe and finding has a test, committed failing first | PASS. I ran the four test commits before their fixes: 27 + 1 + 1 + 2 = 31 failures, the number S3 reports. The one slip S3 names (three checks in 936325f) is as described; my faults on those checks are caught. |
| Marker scan, RLS coverage and restore tests | PASS (restore, the worker's marker scans and db-pii's policies run locally; the rest in CI) |
| S4 reviews, S5 confirms | Done (S5: #169) |
| CI full gate, Semgrep included | PASS |
| F-22 probe and random runs give 0 wrong lines | PASS: 0 of 240 lines wrong (it was 7). Removing the first branch of `lockOrders` now fails the race test. |

| Check | Result |
|---|---|
| F-22: dispatch between mapping and event, event run twice | PASS. On hand 8, reserved 0, both times. The F-01 probes still hold (VAT, Oversold, three events at once). |
| F-06 through the parsers: first seen shipped, edited late | PASS. eBay at 89 days, website at 80 and 88 days: no record. eBay at 10 days: placement + 25. |
| F-06, stored waiting, first shown FULFILLED on day 5, 60, 64, 66, 80, 89 | PASS. Placement + 30, 85, 89, 90, 90, 90, after the expiry job. |
| F-06, 200,000 random orders through `piiDeleteAfter` | PASS. None past placement + 90; none first seen shipped later than its stand-in allows. |
| Notice race: 40 rounds at random times, each with 5 first ingests (3 in new workspaces), 2 corrections, a deletion and an expiry change | PASS. 0 buyers stored and not found, 0 stored after a finished notice, no deadlock. |
| Notice lock | 503 after 2.0 s. While it waits, other buyer writes wait too, at most those 2 s, website ones included. Accepted: ingests are short. |
| `/v1/replace` | PASS: refusals, lock order and canary by S3's tests and my faults on them; no dead tuple after a correction by my probe. |
| Restore, 180-day cut, newest date, two key versions | PASS (S3's tests pass, and fail under my faults on them, V13 apart). |
| 0011 | Expand only, no waiver, safe with the previous vault running. |
| The three changed older tests | Right. The website and db ones follow S1's stand-in rule. The closing-workspace one guarded a write that no longer exists. |

**83 planted faults of my own: 70 caught, 13 survived.** The code is right in all 13 places today.
- **Required, added to F-11's list** (Major, open, T-1004): V04, W11 and W12, described there.
- Ride along as Minors: V18 (a username with no placed date is refused), V24 (`replace` without its row lock), V32 and V33 (bullet and town in the mask check; with S5-20261124-12), V34 (no VACUUM; S5's hardening 1), A02 (`VaultBusy` answered 503 by the vault itself).
- Prove nothing: V13 (one key version until M22), V21 (same update, same values), V44 (no other kind is asked for), O06 (the vault refuses too).

**S5-20261124-11:** my probe found the same before I read S5's report. After a failed first store the corrected address is dropped, and the sync never brings that update again. I agree with Minor and with "before T-1201", because no label exists yet. By reading, it lasts longer than it looks: polls run every 5 minutes and the deletion run every hour, so a stale record the sweep has expired is nearly always stored again (T-1003's new rule) instead of being deleted and rebuilt. T-1004's first commit is the right place.

**New Minor: F-M10-end-24** (below, with the Minors).

## Update: #173, T-1004 (head 2e833d6, merged as cba5199, CI green)

**Verdict for #173: CONTINUE.** No new Blocker or Major. F-05, F-07, F-08, F-09, F-10 and F-11 are resolved, with F-20, F-21, F-24 and the Minors F-12, F-13 and F-15. S1's two extra checks (no S5 session) pass: S5-20261124-11 to -13, S5's T-1003 hardening 1 and 2, and PS-036 (a). Three new Minors: F-25 to F-27.

Local: `verify.sh --quick` PASS (342 s). Integration on cba5199: db orders and groups 87/87. Every red commit below was run at its own commit. Own probes and planted faults ran in a separate worktree. None of it is committed.

| Red commit (ADR-084) | S3's count | Mine |
|---|---|---|
| 224a661: S5 -11 and -12, F-24, VACUUM, notice date | 9 | 9 (vault, deletion, worker 8; ebay webhook 1) |
| 24228a3: PS-036 (a), S5 -13 | 5 | 5 |
| 83f480d: F-05 | 13 | 13 |
| 651210f: F-10, F-20 | 13 | 12. "A mapping event and a page never deadlock: shipped orders that were never priced" passed at its red commit: a guard, not red first (F-27). |

| Acceptance (T-1004) | Result |
|---|---|
| ADR-084 (1): the S5 part red first | PASS (9 of 9) |
| Tests first for F-05, F-07, F-08, F-09, F-10 | PASS, with the one F-10 test above |
| F-10: S4's three deadlock rows through the real `apply`, no 40P01 | PASS. They fail at 651210f and pass on cba5199. Removing `#lockStock` is caught. |
| [DEL-1] an estimated order that gets its real date | PASS (5 red first; the planted faults on it are caught) |
| F-09 p95 under 1 s at 100,000 orders | PASS: `order-list.int.test.ts` 6/6, twice on a quiet machine. A first run, while other suites loaded the machine, measured the wide search at 1,105 ms p95. That margin is thin: watch it in AT-25 on the server. |
| S4 reviews right after merge | This update |
| CI full gate green at merge, Semgrep included | PASS |

**Planted faults: 76 on cba5199** (68, then 8 follow-ups on the survivors), and one probe. Covered: the 36 required F-11 guards that S3's run did not reach, F-05 (15), F-07 and F-08 (6) and F-10 (11).
- **The 36 unreached F-11 guards:** 35 caught. G14 needs a test (F-27). T04's master SKU is caught; its `external_sku` part is not (F-27).
- **F-05: 14 of 15 caught.** These cover the stale and repeated update, the stock of closed and added lines, the order-date snapshot, repricing, the three marks and the notice, and the three 0056 triggers. F05k (`late_change` cleared in the open branch) survives: F-27.
- **F-07 and F-08: caught.** Dismiss and remove without the account lock fail 3 tests; so do a regroup on every page, a regroup without the correction, and a key without the slot. Two survive and prove nothing: the advisory lock (G7c) and the open-group re-check (G7b). In both cases the account's order rows, locked `FOR NO KEY UPDATE`, already make the actions wait for each other. Keep them as belt and braces.
- **F-10: caught.** These cover `#lockStock` gone, `FOR UPDATE` on the listings of a stock movement, the 25-order chunk (worker and kit), the 4-minute read, the 8-minute stop and the failed part. Two survive:
  - L2, `lockFor` in falling order, proves nothing: both sides of every case go through `lockFor`, so the order is still the same on both.
  - `FOR UPDATE` at `stock.ts:1492` alone is not caught: F-27.
- **Other survivors that prove nothing:** O13a, O13b and O13c (the `pii_ref` term of `settled` guards it; removing that is caught, O13d).

| Focus point (S3's list) | Result |
|---|---|
| F-05: amounts and lines follow the channel until `vat_recorded_at`, then freeze | PASS. My probe of F-05 (£13.80 / £2.30) and the 0056 triggers hold. 0057 is built concurrently. 0058 drops the old constraint with ADR-045's waiver, in its exact form. Safe with the previous app version, which never closes a line. An update with no lines: F-25. |
| F-10 lock order, listings `FOR NO KEY UPDATE` | PASS. The F-22 race test still passes. |
| F-09 at 100,000 orders | PASS (see acceptance). Plans: no sequential scan of orders. 0059's backfill turns off FORCE RLS on three tables inside one transaction. Those tables are under an ACCESS EXCLUSIVE lock, so no other session sees them without it, and there is no deployed data (ADR-029). Accepted. `master_skus.sku` never changes (0042), so an insert trigger is enough. |
| Sync: 25 a transaction, reading stops at 4 minutes and storing at 8; a first poll keeps its start | PASS. Each run stores at least one chunk, so it always makes progress. |
| `vault.deleted_buyers` retired | PASS. 0012 revokes everything from PUBLIC, `vault_app` and `vault_owner`. The test checks every role and every file outside the migrations. |
| Changed older tests | Right. `normalise.test.ts` follows C3.1 (F-15). The retired vault test read the retired table as its owner; the pii-db test covers more. |
| S5 -11 (`#applyNewer`, one method for both) | PASS. One method with the same checks, in the caller's transaction, under the record's row lock. A record that a deletion run held and deleted meanwhile is stored new. |
| S5 -12 (masks) | PASS. A mask in a delivery field refuses the block. A masked email, phone or ID is left out. ADR-086 (2) now treats masked instructions like email and phone (T-1101). |
| F-24 (expiry `FOR UPDATE`, journal inside) | PASS (red first). |
| VACUUM (SKIP_LOCKED), failure logged by name, caller never fails | PASS (V34 red under its fault). |
| Notice date: strict ISO with a zone, else now | PASS (red first). |
| PS-036 (a) | PASS. The first real date replaces the stand-in once and clears the flag. The deletion date is worked out again through `piiExpiryDate` (`:real` job key). Stock and VAT move once. A deleted record stays deleted. The order page says "(estimated)", in plain text. |
| UI | Marks are plain inline icon and text, with no tinted box. |

## Earlier fixes

| Finding | Result |
|---|---|
| F-M07-T0702-01 (#141) | RESOLVED. `kit/src/carrier.ts`: a longer Retry-After is rethrown, not slept. |
| F-M08-end-01 (#146) | RESOLVED. The upsert only writes when `last_seen_at <= seenAt` and never revives a listing a newer scan ended; `concludeScan` locks the cursor and refuses an older scan; 25-minute stop. |
| F-M08-end-02, -03 (#146) | RESOLVED. The definers test covers ob_app, ob_worker and ob_ops; `MAX_DEFER_MS` is 60 minutes. |
| F-M09-T0901-01 (#151) | RESOLVED. `release` and `dispatch` work from the line's own live reservation, and a remap moves it. The three named tests pass. |
| F-M09-T0901-02, -03 (#151) | RESOLVED. The stock row is locked before the listing; reconciliation runs one transaction per SKU. |

Squawk waivers: one, in 0045 (`ban-drop-constraint`). The wider rule is added just above it and validated in 0046. Meets ADR-045.

## Focus list

| Item | Result |
|---|---|
| Vault first, no PII in db-main, jobs or logs | PASS. Marker scans clean. Removing the buyer strip is caught (O09). |
| One buyer record per order | PASS (0009 unique index; V15 caught), but see F-04. |
| FA-10 table and replay | PASS (I02, I03, I04, I08 caught). |
| VAT engine and ledger | FAIL: F-02, F-03, F-05. |
| FA-11 trigger and late mapping | The trigger is right; late mapping FAILS for lines with no listing (F-01). |
| FA-16 cutover | Stock hold PASS; F-01 and F-06 hit the backfill. |
| DEL-1 | PASS apart from F-06. Journal replay PASS. |
| Company scoping on the 9 order routes | PASS. I ran a child of company X against company Y's order, refund and group on all 9 routes: 404 or absent on each, nothing changed. Gaps in the tests: F-11. |
| Route walker | PASS. Aimed at B's real orders and group, re-run as a child with no ticks. All 9 routes: `session`, tab `orders`, company-scoped. |
| Masked values never stored | PASS. None in `app.orders`, `app.audit_events` or the logs after a list. |
| Every full view logged | PASS. Vault access_log with the user, and audit `order.customer_viewed` (R01, R02 caught). |
| CSV export | PASS. IDs, dates and figures only; marker scan clean. |
| Same-buyer groups | Rules PASS (London day or grace, transitive, cap 20, never through a third order). "Never regroup" FAILS under concurrency: F-07. |
| linkedOrders | PASS (R14 caught). |
| T-1000 | PASS. |
| 0049 to 0051, 0f3c393 | Expand only, NOT VALID then validated, index concurrent. The testkit wait hides no leaked session (its own test proves it). |

## F-M10-end-01 — Blocker — An order line stored before its listing is discovered is never linked to it
Area: Correctness, Invariants  IDs: CAT-6, VAT-2, INV-3, INV-6, FA-11

Evidence:
- `OrderIngest.#create` (`packages/db/src/orders.ts`) writes `listing_id` null when `app.listings` has no row for the SKU. No other code ever sets `order_lines.listing_id`.
- `openLines` and `fillSnapshots` both find lines by `listing_id`.
- Probe: an order for `LATE-ITEM`, then discovery, mapping to a zero-rated SKU, `onListingMapped`, `fillSnapshots`, then a dispatch update. Result: `filled: 0`, no stock movement, on hand still 10, ledger still `rate:2000` £12.00 with £2.00 VAT, order still Unmapped.

Failure: discovery runs daily and orders poll every 5 minutes, so a new product that sells before the next scan never moves stock (an oversell) and pays 20% VAT for ever, even if zero-rated. If a new account's first order poll runs before its first scan, all 90 days of backfilled lines stay provisional for ever.

Required fix:
- Give late lines a path: match open and provisional lines by (channel account, external SKU) as well as `listing_id`, or set `listing_id` when discovery or mapping creates the listing. Cover auto-matched listings too. Index the lookup.
- A line reserved by the back-fill that takes available below 0 sets the line and order Oversold flags and raises the notice (INV-6). Probe: 50 units back-filled on a stock of 10 left reserved 50, `oversold` false. `onListingMapped` calls `#move` directly and checks nothing.
- Tests citing `[CAT-6]`: order first, discovery after, manual and auto mapping, dispatched before mapping, and oversold on back-fill.

Resolution: fixed in the F-01 PR (branch `task/T-1001-late-lines`). Mapping links the provisional lines of its channel account and external SKU (index 0053) and back-fills and fills them; the orders are locked before stock, so a dispatch being stored at that moment is not lost. A line that missed its event (stored while the event ran) has it sent again by the account's next page and by the nightly scan. A back-fill below 0 flags the line and the order and raises Oversold; an order already shipped is not flagged. Tests in `orders.int.test.ts` (db and worker) and `discovery.int.test.ts`, seen red first except the guards; 24 planted faults, all caught on the final code. **Confirmed by S4 on main 32c8f7a (see Update: #164).**

## F-M10-end-02 — Blocker — A refund with line detail gives VAT back only on the line amounts
Area: Correctness  IDs: VAT-5, FIN-1

Evidence: `computeRefundVat` (`packages/core/src/vat.ts`) uses only `refund.lines` when there are any. The rest of `refund.amount`, and any part above a group's remaining gross, is dropped.
- £12 line + £3 shipping, refund of £15.00 whose lines add up to £12.00: ledger −£12.00 / −£2.00, where £15.00 / £2.50 is right. `app.refunds.amount_pence` is 1500, the order reads Refunded, and the ledger still holds £3.00 of sale and £0.50 of VAT.
- £12 standard + £6 zero, £6 discount, £12 refund on the standard line: £8.00 is booked and £4.00 vanishes.
- Line amounts of 0 with a £15 refund: no ledger row at all.
- The property test only generates refunds without lines.

The website parser returns `amount` and `lines` separately, so this path is live.

Required fix: book the whole refund amount, always. Line amounts take their lines' groups; the rest splits pro-rata over the groups' remaining gross; an excess over one group goes to the others. Parts sum to the refund, up to what is left on the order. A refund beyond that is stored and flagged, never silently cut. Apply the same rule in `#rebaseRefunds`. Extend the property test to refunds with lines, and check that the parts sum to the refund.

Resolution: fixed by #160; re-run by S4 on ecb1834 (see Update).

## F-M10-end-03 — Blocker — A truncated adjustment key drops a ledger row
Area: Correctness, Invariants  IDs: VAT-2, VAT-4, FA-11

Evidence: `fillSnapshots` and `#rebaseRefunds` build `entry_key` from every line id and then `.slice(0, 300)`. With 7 lines the key is exactly 300 characters before the group key, so both rows share one key and `ON CONFLICT DO NOTHING` drops the second.
Probe (7 lines of one unmapped listing, £84.00, mapped to a zero-rated SKU): the ledger ends at `rate:2000` 0 / 0 with no `zero:zero` row. The £84.00 sale is gone from the ledger. With 6 lines it is right.

Required fix: use a fixed-length key (for example a hash of the line ids plus the group key), never a truncated one, and treat a conflict on an adjustment row as an error unless the stored row is identical. Test with 7 and 50 lines.

Resolution: fixed by #160; re-run by S4 on ecb1834 (see Update).

## F-M10-end-04 — Major — A username-only buyer record counts as settled, so the delivery address is never stored
Area: Correctness  IDs: ORD-4, ORD-5

Evidence: `ebayBuyer` returns a block whenever any field is present, and `piiState` treats any `pii_ref` as settled. Probe through the eBay parser: a pending order with a username only, then the paid update with name and address. The second poll answers `unchanged`, the order is Awaiting dispatch, and the vault record holds `channel_username` only. The existing test covers `buyer: null`.

Failure: an order in that state has no delivery address and cannot be shipped. Whether eBay sends one is not proven (mocks only, T-1501), but the code accepts it.

Required fix: while the order is pending payment or its record lacks name, line 1 or postcode, it is not settled: an update with more details updates the same vault record (fields and blind indexes, including the match key). Keep the rule that a deleted record is never brought back. Test the case above, and an address that changes before payment.

Resolution: fixed by #160; re-run by S4 on ecb1834 (see Update).

## F-M10-end-05 — Major — Discount and shipping are fixed at first sight, even before payment
Area: Correctness  IDs: VAT-3, VAT-6

Evidence: `#update` never reads `o.discount` or `o.shipping`, and `#settle` uses the stored values. Probe: pending at £12 + £6 shipping; paid at £12 + £3 shipping − £1.20 discount. Stored and booked: £18.00 / £3.00 VAT, where £13.80 / £2.30 is right. FA-10 asks what happens to an order that has no final prices yet.

Required fix: until `vat_recorded_at` is set, an update newer than the stored one refreshes discount, shipping, gross, VAT and the line shares. Line prices are trigger-fixed, so a pending order whose lines or prices change needs a rule: S3 proposes one to S1 (for example, lines are written when payment is captured). After payment, a changed total raises a notice and is never silently ignored.

Resolution: fixed in T-1004 (ADR-081 1 to 3). Until `vat_recorded_at` is set and while the order is not cancelled, a newer update that has lines replaces discount, shipping, gross, the channel total and the line prices in place. A line whose SKU or quantity changed, or that was dropped, is closed (`order_lines.removed_at`, its stock released) and a new one is added with its own reservation and a snapshot of the order date; closed lines leave totals, VAT, open lines, late mapping, the list and the detail. Line uniqueness is a partial index over open lines (0057, built concurrently; the old constraint dropped in 0058 with ADR-045's waiver). The capturing update applies, books VAT, then freezes: the triggers of 0056 refuse amounts, prices and new or closed lines after payment or cancellation. After that a changed total or line sets the `late_change` mark (cleared when a newer update agrees again), a channel total that differs sets `channel_total`, and a refund above what is left keeps its full amount, books VAT up to what is left and sets `refund_above`. The marks are `money.amounts_differ` in the contract and one plain line each on the order page. My rule, for S1 (PS-037): the lines of an unpaid order that has already shipped are not replaced, only marked. Tests: 13 red first and 2 guards (the cancelling update with other lines; an update that carries no lines, added when the fault run found that gap) in `orders.int.test.ts` (db), S4's probe among them (£13.80 / £2.30). **Confirmed by S4 on #173.**

## F-M10-end-06 — Major — A backfilled shipped order can keep customer details far past the retention window
Area: PII  IDs: DEL-1, ORD-4, FA-16

Evidence: the eBay adapter uses `lastModifiedDate` as the dispatch time of a FULFILLED order, and `piiDeleteAfter` adds 25 days with no bound by placement. Probe: placed 89 days ago, FULFILLED, edited yesterday (a refund or feedback does that). The buyer is stored, and the expiry is placement + 113 days. PRD 7.3: 25 days after dispatch, every copy gone by day 30.

Required fix: bound the expiry by placement + 90 days always. For an order first seen already shipped with no real dispatch time, do not treat a later edit as the dispatch: use the earliest defensible date (ship-by or placement), and store no vault record when that is past the window.

Resolution: fixed in T-1003 (with S5-20261124-10): one expiry sum for ingest and the expiry job, capped at placement + 90 days; a first-seen shipped order uses the earlier of ship-by and the update, or placement; eBay gives no dispatch time for FULFILLED. Red first, through the parsers. **Confirmed by S4 on #167.**

## F-M10-end-07 — Major — A dismissed or removed pair is regrouped when a recompute is in flight
Area: Correctness  IDs: ORD-9

Evidence: `applyGroups` takes the account's advisory lock; `dismissGroup` and `removeMember` do not. Probe with two connections, the recompute held just after it has read the exclusions:
- dismiss: all three orders end in a new open group, with the 3 exclusion rows present;
- remove: the removed order is back in its open group.

It stays so until the next page that stores an order for that account, and Ship together (M12) would offer one label for orders a user has said are not the same buyer.

Required fix: dismiss and remove take the same advisory lock first, then lock the group and read its members. `applyGroups` links only to a group it has re-checked as open under that lock. Test with two connections, both actions.

Resolution: fixed in T-1004. `dismissGroup` and `removeMember` take the account's advisory lock first (`#lockAccount`), then lock the group and read its members; `applyGroups` links only to a group it has re-checked as open (`FOR UPDATE`) under that lock. Tests in `order-groups.int.test.ts` on two connections, red first (3): dismiss and remove against a recompute held after it read the exclusions, and a recompute against an open dismissal. G02, G09 and G10 ride along. **Confirmed by S4 on #173.**

## F-M10-end-08 — Major — A group recompute makes one vault call and one 6-year log row per waiting order
Area: Performance, PII  IDs: ORD-9, CAP-2

Evidence: `ordersGroupRecomputeHandler.prepare` calls `vault.match` for each candidate that is not already in a class. Probe with 301 waiting orders: 301 calls, 301 `access_log` rows, 80 KB, 6.6 s. An update that changed no status still queues a recompute (confirmed). The job has a random idempotency key, so nothing collapses repeats.
At 300 waiting orders and a recompute each poll, that is about 86,000 rows (23 MB) a day per account, kept 6 years. db-pii's disk budget is 3 GB (ARCHITECTURE 7). C3.2 specified one call: `(workspace, channel_account, order_ids)`.

Required fix: one `match` call per recompute (batched refs in, subject groups out, one access-log row with the count). Queue a recompute only when an order is new or enters or leaves Awaiting dispatch, with a key that collapses repeats. Test the call count.

Resolution: fixed in T-1004. One batched `match` per recompute (`POST /v1/match`: refs in, groups of refs out, same workspace, kind and channel-account conditions, at most 5,000 newest refs), with one access-log row that holds the count. A recompute is queued only when an order enters or leaves the ones that can group (Awaiting dispatch, not FBA, no cancel request, record held), or its buyer was corrected; its key is the account and a one-minute slot, and it starts 30 s after the slot ends, so a change inside the slot is never missed. Tests red first (4): the call count and one log row (vault), the collapsing key and when one is asked for (worker and db). **Confirmed by S4 on #173.**

## F-M10-end-09 — Major — The orders list reads the whole workspace on every page
Area: Performance  IDs: CAP-7, ORD-1, ORD-2

Evidence: `filtered` applies a window count, then a full group-by and sort, and the list runs it twice (page and count). One workspace, one company, container with ARCHITECTURE 7's work_mem and planner settings (shared_buffers at its default), median of 6 runs (3 for search):

| Orders | No filter | Last 7 days | Search by order ref |
|---|---|---|---|
| 100,000 (a year today) | 0.96 s (max 8.9 s) | 0.17 s | 5.3 s |
| 500,000 | 6.6 s | 0.22 s | 6.8 s |
| 1,000,000 (a year at design) | 9.0 s | 0.37 s | 12.0 s |

CAP-7 is p95 under 1 s. Plan at 500,000: Parallel Seq Scan on orders, external merge sorts, WindowAgg spilling 68 MB, 28,089 temp blocks written. `orders_placed` is not used. The machine was shared, so treat the numbers as indicative; the plan is the finding.

Required fix: page on the index first (newest units through `orders_placed`, then bring in the group members of that page only), count hidden members for the page's groups only, and make the count stop at its cap. Give the reference and SKU search an index (prefix or trigram; a trigram extension needs an ADR line). Prove it with a plan-shape test at 100,000 rows.

Resolution: fixed in T-1004 (ADR-081 6). The list finds its page through `orders_placed` first, brings in the group members of that page only, counts hidden members for the page's groups only, and stops the count at its cap; one statement gives the page and the total, with JIT off. Search is by prefix on lower-case columns (0059: filled by insert triggers and a backfill; 0060: indexes built concurrently, COLLATE "C" so the range is an index condition under RLS), by order reference, channel SKU or master SKU; no extension. `order-list.int.test.ts` loads 100,000 orders and checks the plans (no sequential scan of orders) and p95 on this machine: first page 48 ms, a deep page 277 ms, a wide search 659 ms, a reference search 16 ms (it was about 1 s and 5.3 s). Red first: prefix search, and the plans and times; the list's own rules are a guard. **Confirmed by S4 on #173.**

## F-M10-end-10 — Major — One poll run is stored in one transaction, which deadlocks and blocks stock
Area: Correctness, Performance  IDs: INV-4, CAP-5, NFR-3, invariant 3

Evidence:
- `runIncrementalSync` reads up to 50 pages (10,000 eBay orders) and sinks them in one transaction. Stock and listing rows are locked in arrival order and held to the end.
- Deadlock: two accounts selling the same two SKUs in opposite order, 10 runs: 10 × 40P01. Each is retried as a job, so nothing is lost, but it recurs whenever accounts are busy.
- Blocking: one run against a stock-in of the same SKU from another session:

| Orders in the run | Live orders | The stock-in took | Backfill (no stock moves) | The stock-in took |
|---|---|---|---|---|
| 50 | 3.1 s | 2.7 s | 1.4 s | 1.1 s |
| 200 | 15.9 s | 15.6 s | 5.9 s | 5.6 s |
| 400 | 32.6 s | 32.5 s | 27.3 s | 27.8 s |
| 2,000 | 246 s | | 111 s | |

- A backfill blocks too although it moves no stock. From reading: the new `order_lines` rows hold a key-share lock on their listings, and the stock engine locks listings `FOR UPDATE`, which conflicts.
- `sync.poll` expires at 600 s and the runtime does not stop the handler. At the 2,000-order rate (123 ms an order, on a loaded machine) that is about 4,900 live orders.

Required fix: store a run in short transactions (for example 25 to 50 orders), with the cursor moved only after the last. Within one, lock the stock rows in component id order first. Use `FOR NO KEY UPDATE` on listings if the reading above is right. Stop before the job expiry and resume. Tests: the opposite-order case, and that a stock movement on a SKU waits only for one chunk.

Added 25 Nov 2026 (#164, main 32c8f7a). `lockOrders` takes all of a listing's open orders before the stock rows, while a page takes order, stock, order, stock. Deadlocks (40P01) in 12 runs each, every one retried after 20 to 80 ms:

| Mapping event against one page | ecb1834 | 32c8f7a |
|---|---|---|
| 4 open orders updated in falling id order | 2 | 24 |
| A new sale of the SKU, then 4 open orders in rising id order | 2 | 12 |
| 5 new sales of the SKU | 5 | 4 |

- The second row shows that sorting the orders is not enough: the page must not hold a stock row when it asks for an order.
- The third row fits the key-share reading above, now checked: while a page that stored a line is open, its listing is `55P03` for `FOR UPDATE NOWAIT` and free for `FOR NO KEY UPDATE NOWAIT`. S3's test for it plays the sale by taking the stock row first; a real sale inserts its line (key share) first.

Required as well: in each chunk, lock the existing orders in id order, then the stock rows in component id order, then store. Listings `FOR NO KEY UPDATE`. Tests: the three rows above through the real `apply`, with no 40P01. F-20 closes with this.

Resolution: fixed in T-1004, with F-20. `runIncrementalSync` stores 25 orders a transaction, each prepared just before it; the cursor, health and usage go with the last. Reading stops at 4 minutes and storing at 8, before `sync.poll` expires at 10; a run that stops, or fails part way, saves what it stored (and, on a first poll, its start), and the next run goes on without storing anything twice. A failed part is no success of the stream. In each transaction: the stored orders in id order (`FOR UPDATE`), then the stock rows in component id order (`StockEngine.lockFor`), then the rest. Mapping locks the same way (its orders first, `lockOrders` also takes orders with lines not yet priced), listings are locked `FOR NO KEY UPDATE` on both sides, and group actions lock the account's open orders in id order after their advisory lock. Tests red first (13, and 1 more found by T-1004's own review): S4's three deadlock rows through the real `apply` against a mapping event, with no 40P01 (the sale inserts its line first); two accounts in opposite order; a page that moves no stock never blocks one; a stock-in waits for one small transaction of a long poll (`orders.int.test.ts`, worker); the parts, stop, failure and slow pages (`sync.test.ts`). The F-22 race test still passes. One guard was added after the deliberate-break run: a group action locks the account's open orders before it changes any. **Confirmed by S4 on #173.**

## F-M10-end-11 — Major — Tests for money, snapshots, deletion and scoping that do not fail when the code is broken
Area: Requirement coverage, Invariants  IDs: VAT-1, VAT-2, VAT-5, VAT-6, VAT-7, ORD-4, ORD-9, DEL-1, TEN-5, PERM-3

S3 reported that these tests were not written first and asked whether they can fail. I planted 123 faults, one at a time, and ran the suites that should catch each. Caught: 62. Survived: 61, of which 5 prove nothing (G06, G11 and G12 are blocked by a second check; O14 is also stopped by the state check and by the vault; R19 was a weak fault of mine). **56 real gaps.** The code is right in each of these places today, apart from the findings above.

| Area | Caught | Survived |
|---|---|---|
| Order ingest | 17 | 13 |
| 0048 triggers and grants | 2 | 7 |
| Company scoping | 5 | 5 |
| Vault deletion | 13 | 2 |
| PII expiry, orphan sweep, vault first | 6 | 9 |
| Reads and routes | 9 | 11 |
| Grouping | 10 | 14 |

Required fix: a failing test for each of the following, shown red against the fault before it goes green (say so in the PR). These 37 are required.
- **VAT and dates:** tax point on the London day, not the UTC day, at sale and at refund (BST, 23:30Z) (I06, I07). Snapshot at ingest and at late mapping uses the order date when COGS or VAT type has since changed (I15, I16). Line VAT shares after late mapping (I17). Workspace default rate other than 20% (I30). A first-seen payment date is kept (I25). A discount above the goods (I22).
- **Write-once and append-only:** VAT type, SKU, quantity and prices, provisional rate (T01, T04, T05, T09). Order tax point and placed time (T06). UPDATE and DELETE refused on `vat_ledger` and `refunds` (T07, T08).
- **Stock:** back-fill skips history and cancelled orders (I18, I19). A first-seen cancelled order reserves nothing (I27). Oversold stored on the line and the order (I23, I24).
- **Company scoping:** behaviour of `refunds`, `refund_lines`, `order_groups` and `order_group_exclusions` (C03, C04, C07, C08; the coverage test checks that a policy mentions the setting, not that it limits rows). A company filter the user cannot see (C10).
- **Deletion and retention:** delivery wins over dispatch, at ingest and in the expiry job (O04, O05). The 25-day window is used at ingest (O10). The sweep's one-day grace and second page (O01, O03). The expiry job ignores cancelled orders (O15) and never sends a past date (O06). A record already stored and then erased is not re-created by a later poll (O13). ~~Closure removes the deleted-buyer marks (V10)~~ (withdrawn: ADR-083 keeps them). The newest journal line wins on restore (V12).
- **Grouping:** an order that is cancelled or dispatched leaves its group and a group of one closes (G13, G14).

- **Added 25 Nov (#167), 3 more required:**
  - V04: an ingest must take the notice lock before it checks the deleted buyers. Proved: an ingest sent while a notice holds the lock (its journal write paused) is `buyer_deleted` today; with the two lines swapped it is **stored, and the notice does not find it**. The existing tests pause only at the record's INSERT. Test that order, and the same for `replace`.
  - W12: a correction the vault refuses as `buyer_deleted` must leave the order `unchanged`. With the catch removed the refusal fails the whole poll, and no test notices.
  - W11: the channel must be sent with a correction. Without it, a website customer's corrected address is dropped when their ID equals a deleted eBay one.

The other 19 (R03, R04, R06 to R11, R15, R17, G02, G09, G10, G17 to G19, G21, G22, G24) ride along as Minors; G02, G09 and G10 belong with F-07.

Resolution: fixed in T-1004. All 39 required tests are written (the 37, with V04, W11 and W12; V10 withdrawn), and so are the other 19 survivors, G02, G09 and G10 with F-07. The code was right in each place, so each is a guard that could not be red first. S3's fault run on the final code was stopped by S1 after 49 faults (ADR-085); of these 39 it reached V04, W11 and W12, all caught. The other 36 wait for S4's planted faults in its review, as ADR-085 places task-wide fault runs. Tests are in `orders.int.test.ts` (db and worker), `order-groups.int.test.ts`, `vault.int.test.ts`, `deletion.int.test.ts`, `restore.int.test.ts` and `orders.int.test.ts` (web). F-21 closes with this, as S1 placed it. **Confirmed by S4 on #173.**

## F-M10-end-22 — Major — A dispatch between a mapping and its event leaves stock reserved for ever
Area: Correctness, Invariants  IDs: INV-3, INV-1, CAT-6

Found while checking #164. It was there before (same result on ecb1834); my earlier reviews missed it.

Evidence:
- `onListingMapped` (`packages/db/src/stock.ts`) reserves every open line, then calls `dispatch` for a line already shipped. If that line's dispatch movement already exists, the reserve still applies and the dispatch is a repeat that does nothing.
- Probe: order of 2 on a known, unmapped listing; map it; store the dispatch before the event runs; run the event. Result: on hand 8, **reserved 2**; right is 8 and 0. A second event changes nothing, and no hand movement can lower `reserved`.
- 40 random runs with at most 60 ms between mapping and event: 7 of 120 lines on a known listing.

Failure: available stays too low for ever, so every listing of the SKU is pushed too few units. Never an oversell, so Major. The window is the time from the mapping's commit to its event: short for one mapping, longer when a first scan maps many listings at once or the queue is behind. By reading, it is also open for a line that missed its event, until the event is sent again.

Required fix: the back-fill reserves only lines still to ship; a shipped line takes `dispatch` alone, which already moves on hand only when nothing is reserved. (Tried in my copy: the probes and the random runs give 0 wrong, and db orders and stock pass 66/66.)
Tests citing `[INV-3][CAT-6]`, red first:
- a linked line dispatched between the mapping and its event, with the event run twice;
- the existing "dispatch stored while the listing is being mapped" test for a linked line, with the sync transaction storing the dispatch before the mapping commits. It must fail when the first branch of `lockOrders` is removed.

Resolution: fixed in T-1003: on back-fill a line already shipped takes its dispatch alone. Tests: the linked line dispatched between its mapping and the event (red first, event run twice), and the dispatch of a linked line stored while its listing is mapped (a guard, which fails when the first branch of `lockOrders` is removed). Four planted faults, all caught. **Confirmed by S4 on #167.**

## Minors (follow-ups)

- **F-M10-end-12** (ORD-9, C3.1 point 3): an order with an open cancellation request (`CANCEL_REQUESTED`, `IN_PROGRESS`, `CANCEL_PENDING`) maps to Awaiting dispatch and groups. Keep the flag and exclude it; fix before M12's Ship together. **Fixed in T-1004**: `orders.cancel_requested` (eBay's open states; websites send none) is kept from the newest update, and such an order is in no group until the channel refuses.
- **F-M10-end-13** (ORD-6): `viewOrderCustomer` answers 500 when the vault record has just gone and db-main has no tombstone yet. Map the vault's not-found to 404. **Fixed in T-1004.**
- **F-M10-end-14** (ORD-4): `pii_subject` allows 200 characters, but an accepted external ID of up to 200 makes 237. One such order fails its whole page on every poll. Widen the check, or cap the ID at 163 in the parsers.
  - Resolution: fixed in T-1101 (red 824e3d0, fix 5fa8bad). Both parsers cap the order ID at 163 and read each order on its own; one that cannot be stored is set aside with one `orders.set_aside` notice per account (counts by reason, IDs only), the rest are stored and the cursor moves. Tests: `sync.test.ts`, the eBay parser tests, the website protocol tests (`provider-website/src/index.test.ts`, which replace the provisional parser tests when M11 replaces that protocol) and the worker end-to-end set-aside test.
- **F-M10-end-15** (ORD-9, C3.1): the spec says punctuation is removed; `normaliseName` turns it into a space, so "St John's" and "St Johns" do not match. **Fixed in T-1004**: punctuation is removed, and the vault re-indexes names and match keys of older records once at start.
- **F-M10-end-16** (VAT-3, INT-5): eBay's `pricingSummary.total` is parsed but never compared. A `deliveryDiscount` gave a gross of £15.00 against eBay's £13.00. Compare and raise a notice on a mismatch. Place in T-1501 with the spec check.
- **F-M10-end-17** (INT-5): one non-GBP order fails the parser for its whole page, so no later order of that account is stored. Quarantine the one order with a notice. S1 to place, before eBay goes live.
  - Resolution: fixed in T-1101 with F-14 (red 824e3d0, fix 5fa8bad). A non-GBP, empty or unreadable order is set aside with the notice; an unreadable one also raises the platform report. Same tests as F-14.
- **F-M10-end-18** (DEL-1, invariant 10): `vault.deleted_buyers` is not journalled, so a restore forgets notices that arrived after the backup. For S5 to judge. **Fixed in T-1003** (S5-20261124-08).
- **F-M10-end-19** (FA-10): a repeat ingest of an orphan returns the old record with its old (perhaps already expired) `delete_after`. By reading only. **Fixed in T-1003** (S5-20261124-06).
- **F-M10-end-20** (INV-4): lock order differs between mapping (stock row, then order) and an order update (order, then stock row). By reading only; a deadlock there is retried. **Fixed in T-1004** with F-10 (one lock order on both sides). **Confirmed by S4 on #173.**
- **F-M10-end-21** (ADR-080, CLAUDE.md): tests-first was not followed for most of T-1001 and T-1002, as S3 reported itself. For S1. Closes with F-11 (T-1004), as S1 placed it. **Closed with F-11 on #173.**
- **F-M10-end-23** (INV-9): a line on an FBA listing moves the seller's own stock, at ingest and on back-fill (S3's note in #164; by reading only). Not reachable before M18. S1 to place there.
- **F-M10-end-24** (DEL-1, ORD-4; found on #167): an expiry deletion already past its read deletes a record that has just been stored again. `DeletionService.delete` reads the expired refs, journals them, then locks and deletes by ref without looking at `delete_after` again. Probe: the run paused after its journal write, the order ingested (same ref, new date, committed), the run released: 1 record deleted. The order then holds a dead ref and counts as settled, so its customer details never come back. The window is short and opens once an hour, hence Minor. Fix: for the expiry scope, read the targets `FOR UPDATE` in the transaction that deletes, and journal inside it before the delete, so the journal never names a record that is kept. A red test as the probe. Best with S5-20261124-11, before T-1201. **Fixed in T-1004**: an expiry run picks its records `FOR UPDATE` in the transaction that deletes them and journals inside it, before the delete; other scopes are unchanged. Red first: S4's paused run, and a record re-dated while the run waits. **Confirmed by S4 on #173.**
- **F-M10-end-25** (FIN-1, ORD-6; found on #173): an update with no lines sets `late_change` and raises the platform notice, paid or not.
  - In `#amounts` (`packages/db/src/orders.ts`), an empty `o.lines` makes `open` false, and every stored line counts as closed. So `sameLines` is false and the mark is added.
  - Probe on cba5199: an unpaid order, then a newer update with `lines: []`. The order carries `late_change` (expected none), and its page says the channel sent different items.
  - The method's own comment says "An update with no lines says nothing about them". The paid-order test (`orders.int.test.ts`, "after payment a different total…") expects the mark for `{ lines: [] }`.
  - Both parsers accept an empty line array (`website/src/index.ts`, `ebay/src/adapter.ts`).
  - **Fix:** an update with no lines compares only discount, shipping and the channel total, never the lines, whether paid or not. Change the paid-order test to match, and add the unpaid case as a red test. For S1 to rule if S3 reads it otherwise.
  - Place in T-1101's first commits, with the website connector (ADR-086).
  - Resolution: fixed in T-1101 as ADR-087 rules (red 1f6fa31, fix faa37fe). An update with no lines uses the stored lines, so it never touches or marks them, paid or not. The paid-order test now expects no mark for `{ lines: [] }`; the unpaid case was red first (`orders.int.test.ts`, db).
- **F-M10-end-26** (Performance, ORD-9 C3.1; found on #173): the vault decrypts every buyer record of every workspace at each start, before it serves.
  - `reindexNames` (`apps/pii-vault/src/vault.ts`, called in `main.ts` before `app.listen`) takes one transaction per workspace. In it, it locks all the workspace's records `FOR UPDATE` and makes two queries and one decryption per record. Records that are already right are skipped only after they are decrypted.
  - With nothing deployed this costs little. In production it grows with the 90-day stock of records, on every restart, until M22 removes it.
  - **Fix:** run it once (a done marker in the vault, or a db-pii migration that flags the records still to do), and in batches, before go-live.
  - Resolution: fixed in T-1101 as ADR-087 rules (shape 788847e, red 1f6fa31, fix faa37fe). `reindexNames` runs once (done marker `reindex_names` in `vault.maintenance_done`, db-pii 0013, no UPDATE or DELETE for `vault_app`), in batches of 200 with a short transaction each. Tests in `vault.int.test.ts`: once, and in batches, red first.
- **F-M10-end-27** (test gaps found by planted faults on #173; the code is right in each place today):
  - G14: `removeMember` that leaves one member must close the group. `#closeSmall` with `< 1` passes every group and web test. The required test closes a group only through `applyGroups`, where unlinking already leaves the group empty.
  - T04: no test changes `order_lines.external_sku` after insert. The 0056 check can go unnoticed, yet F-05's line matching and `search_sku` rely on it.
  - `stock.ts:1492`: `FOR UPDATE` there instead of `FOR NO KEY UPDATE` is not caught.
  - F05k: `late_change` is not shown to clear in the open branch. That case is an unpaid order that shipped, was marked, then agreed again (ADR-086: it clears).
  - 651210f: "shipped orders that were never priced" was not red at its test commit. Say so in the PR as a guard, or give it a fault.
  - One test each, a guard red against its fault. They ride with T-1101 like the other Minors.

  - Resolution: T-1101 3fa0610. Each guard was planted with its fault by hand on that test alone (ADR-085) and caught it: G14 (`#closeSmall` with `< 1`, `order-groups.int.test.ts`), `stock.ts:1492` (`FOR UPDATE`, a key-share probe in `stock.int.test.ts`), F05k (the mark clears in the open branch, `orders.int.test.ts`). T04: the existing test already fails when the 0056 check on `external_sku` is removed, so no new test. 651210f's test is recorded as a guard.
## Acceptance

| Task | Item | Result |
|---|---|---|
| T-0901 | INV-3 each movement once | PASS |
| T-0901 | INV-6 20 parallel orders | PASS |
| T-0901 | AT-4 within the 2-minute budget | PASS |
| T-0901 | AT-27 table | PASS |
| T-0901 | INV-7 drift; INV-8 Sync failed | PASS, PASS |
| T-0901 | CI green at merge | PASS |
| T-1000 | Config test fails when a job is left out; CI green | PASS, PASS |
| T-1001 | Tests first | **FAIL** (S3's own report; F-11) |
| T-1001 | AT-15; AT-16 | PASS, PASS |
| T-1001 | Property tests | PASS as worded; they miss refunds with lines (F-02) |
| T-1001 | AT-6 | PASS |
| T-1001 | Replay and out of order | PASS |
| T-1001 | Orphan swept | PASS |
| T-1001 | Marker scan | PASS |
| T-1001 | CI green, Semgrep included | PASS |
| T-1002 | Tests first | **FAIL** (S3's own report; F-11) |
| T-1002 | AT-26; ORD-5; ORD-8 | PASS, PASS, PASS |
| T-1002 | Route walker and child scoping | PASS (behaviour; tests thin, F-11) |
| T-1002 | CI green, Semgrep included | PASS |

## Not checked

- Live eBay and website payloads (mocks only; T-1501, M11).
- The orders screens (T-0318).
- ARCHITECTURE 7 memory limits under load (AT-25).

The two FAILs are the same fact. I grade it Major, not Blocker: the order cannot be redone, and F-11 asks for the red runs that tests-first would have given. S1 may rule otherwise.

Resolution rule (ADR-077): Blocker F-01 at once, in its own PR (done, #164); Majors F-05 and F-07 to F-11 in T-1004 (F-06 and F-22 done, #167). The next S4 review confirms them, and M10 stays BLOCKED until then.
