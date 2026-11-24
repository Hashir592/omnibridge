# M09 + M10 milestone findings, round 1

Reviewed: M09 (#142, #143, fixes #151) and M10 (T-1000 #156, contract #157, T-1001 #158, T-1002 #159), on main 35746f5. The critical review of #158 is folded in here. Also re-checked: #141, #146 and #151.
Gate: CI green on main 35746f5 (run 45429202845), on 55d558b, and on every PR in scope, except Semgrep red on #151 (the ADR-079 0 gap, closed by #153 and #156).
Local: `verify.sh --quick` PASS (333 s; a first run had one 5 s unit timeout, `webhooks/ebay.test.ts`, while other suites loaded the machine). Integration re-run: 15 files, 142/142 PASS (db orders, stock, catalogue, definers, migrate; worker orders, stock, discovery, outbound; web orders, isolation, stock, privacy; vault, restore), plus db `tenancy` 16/16.
Probes: about 20 ad-hoc tests on bd1741d; the later commit 0f3c393 changes only the testkit and the end report. Tests-can-fail check: 123 planted faults on 0f3c393. None of it is committed.
Acceptance re-run: 22/24 PASS (table at the end).

Verdict: **BLOCKED**. Found: Blockers 3, Majors 8, Minors 10. **Open on main ecb1834: Blockers 1 (F-01), Majors 7 (F-05 to F-11), Minors 9.** Fixed by #160: F-02, F-03, F-04, F-16. Every earlier Major is resolved and verified. M09 has no open finding of its own; the one M09 gap (Oversold on back-fill) is inside F-M10-end-01.

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

Resolution: (S3)

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

Resolution: (S3)

## F-M10-end-06 — Major — A backfilled shipped order can keep customer details far past the retention window
Area: PII  IDs: DEL-1, ORD-4, FA-16

Evidence: the eBay adapter uses `lastModifiedDate` as the dispatch time of a FULFILLED order, and `piiDeleteAfter` adds 25 days with no bound by placement. Probe: placed 89 days ago, FULFILLED, edited yesterday (a refund or feedback does that). The buyer is stored, and the expiry is placement + 113 days. PRD 7.3: 25 days after dispatch, every copy gone by day 30.

Required fix: bound the expiry by placement + 90 days always. For an order first seen already shipped with no real dispatch time, do not treat a later edit as the dispatch: use the earliest defensible date (ship-by or placement), and store no vault record when that is past the window.

Resolution: (S3)

## F-M10-end-07 — Major — A dismissed or removed pair is regrouped when a recompute is in flight
Area: Correctness  IDs: ORD-9

Evidence: `applyGroups` takes the account's advisory lock; `dismissGroup` and `removeMember` do not. Probe with two connections, the recompute held just after it has read the exclusions:
- dismiss: all three orders end in a new open group, with the 3 exclusion rows present;
- remove: the removed order is back in its open group.

It stays so until the next page that stores an order for that account, and Ship together (M12) would offer one label for orders a user has said are not the same buyer.

Required fix: dismiss and remove take the same advisory lock first, then lock the group and read its members. `applyGroups` links only to a group it has re-checked as open under that lock. Test with two connections, both actions.

Resolution: (S3)

## F-M10-end-08 — Major — A group recompute makes one vault call and one 6-year log row per waiting order
Area: Performance, PII  IDs: ORD-9, CAP-2

Evidence: `ordersGroupRecomputeHandler.prepare` calls `vault.match` for each candidate that is not already in a class. Probe with 301 waiting orders: 301 calls, 301 `access_log` rows, 80 KB, 6.6 s. An update that changed no status still queues a recompute (confirmed). The job has a random idempotency key, so nothing collapses repeats.
At 300 waiting orders and a recompute each poll, that is about 86,000 rows (23 MB) a day per account, kept 6 years. db-pii's disk budget is 3 GB (ARCHITECTURE 7). C3.2 specified one call: `(workspace, channel_account, order_ids)`.

Required fix: one `match` call per recompute (batched refs in, subject groups out, one access-log row with the count). Queue a recompute only when an order is new or enters or leaves Awaiting dispatch, with a key that collapses repeats. Test the call count.

Resolution: (S3)

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

Resolution: (S3)

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

Resolution: (S3)

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
- **Deletion and retention:** delivery wins over dispatch, at ingest and in the expiry job (O04, O05). The 25-day window is used at ingest (O10). The sweep's one-day grace and second page (O01, O03). The expiry job ignores cancelled orders (O15) and never sends a past date (O06). A record already stored and then erased is not re-created by a later poll (O13). Closure removes the deleted-buyer marks (V10). The newest journal line wins on restore (V12).
- **Grouping:** an order that is cancelled or dispatched leaves its group and a group of one closes (G13, G14).

The other 19 (R03, R04, R06 to R11, R15, R17, G02, G09, G10, G17 to G19, G21, G22, G24) ride along as Minors; G02, G09 and G10 belong with F-07.

Resolution: (S3)

## Minors (follow-ups)

- **F-M10-end-12** (ORD-9, C3.1 point 3): an order with an open cancellation request (`CANCEL_REQUESTED`, `IN_PROGRESS`, `CANCEL_PENDING`) maps to Awaiting dispatch and groups. Keep the flag and exclude it; fix before M12's Ship together.
- **F-M10-end-13** (ORD-6): `viewOrderCustomer` answers 500 when the vault record has just gone and db-main has no tombstone yet. Map the vault's not-found to 404.
- **F-M10-end-14** (ORD-4): `pii_subject` allows 200 characters, but an accepted external ID of up to 200 makes 237. One such order fails its whole page on every poll. Widen the check, or cap the ID at 163 in the parsers.
- **F-M10-end-15** (ORD-9, C3.1): the spec says punctuation is removed; `normaliseName` turns it into a space, so "St John's" and "St Johns" do not match.
- **F-M10-end-16** (VAT-3, INT-5): eBay's `pricingSummary.total` is parsed but never compared. A `deliveryDiscount` gave a gross of £15.00 against eBay's £13.00. Compare and raise a notice on a mismatch. Place in T-1501 with the spec check.
- **F-M10-end-17** (INT-5): one non-GBP order fails the parser for its whole page, so no later order of that account is stored. Quarantine the one order with a notice. S1 to place, before eBay goes live.
- **F-M10-end-18** (DEL-1, invariant 10): `vault.deleted_buyers` is not journalled, so a restore forgets notices that arrived after the backup. For S5 to judge.
- **F-M10-end-19** (FA-10): a repeat ingest of an orphan returns the old record with its old (perhaps already expired) `delete_after`. By reading only.
- **F-M10-end-20** (INV-4): lock order differs between mapping (stock row, then order) and an order update (order, then stock row). By reading only; a deadlock there is retried.
- **F-M10-end-21** (ADR-080, CLAUDE.md): tests-first was not followed for most of T-1001 and T-1002, as S3 reported itself. For S1.

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

Resolution rule (ADR-077): Blocker F-01 at once, in its own PR; Majors F-05 to F-11 in the first commits of S3's next task. The next S4 review confirms them, and M10 stays BLOCKED until then.
