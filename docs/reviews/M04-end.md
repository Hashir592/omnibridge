# M04 end review (S4, 19 Nov 2026)

Reviewed: all of M04 on `main` at `b743989` (PR #103 merge). S3: T-0401 to T-0405, T-0407 to T-0410 (PRs #80 to #93, #98, #102). S2: T-0308, T-0309, T-0310 (PRs #90, #94, #103). Also the halfway carry-over, the M02 end carry-overs, the S5 audit of 18 Nov and the external audit (ADR-069).
**Verdict: APPROVED** (0 Blockers, 0 Majors, 4 Minors). The Minors become follow-ups and do not block. One round (ADR-044).

## Evidence

- **Gate (ADR-054):** CI run 44574171992 on `b743989` is green, and so are 44573430175 (`6fe5b8e`) and 44567889423 (`eaa91c7`, the T-0410 merge). PR #103's own run 44572738317 is green (UI lane).
- **My local run:** `scripts/verify.sh --quick` on `b743989` in a clean worktree: PASS in 160 s (lint, typecheck, openapi, unit). The first attempt ran out of memory (lint heap) because probes were running beside it on this 7.9 GB host. It was re-run on its own.
- **Probes (break it on purpose):** for each fix I changed the code back to the broken behaviour in a throwaway worktree (never committed), ran the test that names it, and then restored the code. Every one fails on the broken code; CI shows them passing on `main`.

| Fix | What I broke | Result |
|---|---|---|
| A-001 vault | `ebayUserMatch` answers `next: null` (one page only) | `vault.int` "[AT-10] … pages through every record" fails |
| A-001 web | the 422 on a truncated erasure search removed | `privacy.int` "[AT-10][DEL-4] 5,001 records …" fails |
| A-002 invite | the invite job takes a fresh context, not the request's | `notify-commit.int` both [TEN-7] invite tests fail |
| A-002 deletion | `requestDeletion` copies the context (unbound) | `notify-commit.int` "[DEL-4] a deletion queued from a request is invisible until …" fails |
| A-003 | no miss cache / no `beforeFetch` / no fetch cap | `account-deletion.test` 1, `ebay.test` 1 and `account-deletion.test` 2 fail |
| A-004 | `expired-snapshots.mjs` keeps everything; `retention.sh` skips the explicit forget | `expired-snapshots.test` fails; `retention.int` (real restic) keeps 3 snapshots aged 44+ days and fails |
| A-005 | pool `error` handler removed / client `error` handler removed | `pool.int` fails on an unhandled `57P01` / 1 test fails |
| A-006 server | the job's `erasures.complete` removed; `overdue` only while open | `erasure-outcome.int` and `privacy.int` "[DEL-4] a failed deletion leaves the request failed and overdue …" fail |
| A-006 UI | a confirmed row reads "Deleted" | `buyer-data.spec.ts` (Playwright, ui project): 2 failed, 13 passed |
| F-M04h-03 | VACUUM only when this call removed rows | `deletion.int` "[DEL-2] a retry of the same run VACUUMs …" fails |

## The six checks S1 asked for

1. **Halfway carry-over (`M04-halfway-carryover.md`, F-M04h-01 to -05):** all closed. Each fix is in the code, and each test exists:
   - `auth.int.test.ts:1028` [TEN-7] (route, then accept)
   - `people.int.test.ts:182` [PERM-5]
   - `vault.int.test.ts:360` [DEL-1][DP-6] (expiry window) and `:391` [DP-5] (reads make no keys)
   - `deletion.int.test.ts:226` (ingest during closure) and `:263` (VACUUM on retry, probed above)
   - `runtime.test.ts:266` (phased handler) and `apps/worker/src/deletion.test.ts:15`

   The carry-over's T-0404 observations are handled:
   - The case-folded eBay ID became T-0407 (`buyer_exact`, ADR-066).
   - The per-notice cost stays a staging measurement (FA-14).
   - Directory drift answers 500, so eBay retries.
2. **M02 end carry-overs (`M02-end.md`, F-M02e-01 to -06):** closed by T-0401 (PR #81), as I confirmed at the halfway review. Its one regression, the first-admin invite (F-M04h-01), is fixed and is now proven through the route. The 0023 drop uses the ADR-063 waiver.
3. **S5 (`security/20261118-findings.md`):** -01 to -04 are fixed. S5's re-check says yes, and the tests exist:
   - -01: `restore.int.test.ts:205` (real restic)
   - -02: `privacy.int.test.ts:391` and `:444`
   - -03: `logger.test.ts:55` and `tests/config/marker-scan.test.ts:36`
   - -04: `privacy.int.test.ts:613`

   Hardening 1, 2, 3, 4, 5 and 7 are in the code. Hardening 6 (`gcTime: 0`) came with T-0310 (`buyer-data.tsx`, both mutations).
4. **External audit, A-001 to A-006 (ADR-069):** each has a fix and a test that fails without it (table above). In the code:
   - **A-001:** the vault pages in (workspace, pii_ref) order with `cursor`/`next`. Web queues every page before the 200, one job per batch, keyed by a hash of the notice and its refs. Past 1,000 pages it fails loudly with a 503. A truncated erasure search answers 422 `too_many_matches` and stores nothing. The other deletion paths have no silent limit: the worker throws past 200 batches, and the vault loops on `more`.
   - **A-002:** every web `queue.send` path checked. The invite (both routes) and `requestDeletion` (confirm, retry and the eBay batch) run on the request's bound context. Lock and reset mail go out only after their own commits.
   - **A-003:** the limiter counts before any fetch (`beforeFetch`). Unknown kids are cached for 1 h and kids are checked for format. At most 5 uncached fetches a minute, and a known key is used past its hour while the cap is held.
   - **A-004:** `retention.sh` forgets every db-pii snapshot older than 3 days by its own time, then applies `--keep-daily 3 --prune`.
   - **A-005:** `createPiiPool(config, onError)` handles errors on the pool and on each client, and the vault logs `db.connection_error`.
   - **A-006:** db-main 0028/0029 add `completed`/`failed`. The job completes the request in the same transaction as its run log, or fails it on the last attempt. `overdue` holds until the request is closed. Retry is admin-only, audited, makes a new run and returns 409 unless the request is failed. The UI shows "Deletion in progress", "Deleted DD/MM/YYYY" or "Deletion failed DD/MM/YYYY: an admin must retry" with a Retry button, and overdue shows on in-progress and failed rows.
5. **ADR-065 to ADR-068 rulings, all in the code:**
   - `delete_after` window (`vault.ts:615`)
   - VACUUM on retry (`deletion.ts:192`)
   - keys made on ingest only (reads call `#loadKeys(…, false)`)
   - closed-workspace 409 (`app.ts:101`, `vault.closed_workspaces`)
   - deletion outside the db-main transaction (phased handlers)
   - exact buyer IDs (`buyer_exact`, trim only)
   - withdraw route (admin only, reason from the fixed list, open-only 409)
   - claim-then-queue (`claim` in its own committed transaction)
   - strong identifiers (the contract refine, 400)
   - `gcTime: 0`
   - also: the `ob_vault` internal network (`compose.yaml:350`), `no-store` on `/api` (`contract.ts:345`), the canary excluded from expiry, `purge_security_logs`, and both NOT VALID checks validated (0027, pii 0007, 0029)
6. **PRD IDs:** every ID is cited by test titles that prove it (count of titles):

   | IDs | Titles |
   |---|---|
   | DP-4 / DP-5 / DP-6 / DP-7 / DP-8 | 2 / 3 / 4 / 12 / 8 |
   | DEL-1 / DEL-2 / DEL-3 / DEL-4 / DEL-5 | 14 / 12 / 8 / 29 / 10 |
   | AT-8 / AT-9 / AT-10 | 4 / 6 / 7 |

   `req-coverage` passes in CI.

**`squawk-ignore` waivers (ADR-045):** each has its `-- waiver:` line and a rule ADR-045 or ADR-063 allows:

| Migration | Rule | ADR |
|---|---|---|
| 0023 | `ban-drop-function` | ADR-063 |
| 0026 | `ban-drop-constraint` (×2) | ADR-067 |
| 0028 | `ban-drop-constraint` | ADR-069 |
| pii 0006 | `ban-drop-constraint` | ADR-066 |

## Minor findings (follow-ups; none blocks)

## F-M04e-01 — Minor — An erasure request can stay "in progress" for good when the worker dies on the last attempt
Area: 1 Correctness  IDs: DEL-4 (A-006)
Evidence:
- The `failed` hook runs only in `#run`'s catch (`packages/queue/src/runtime.ts`, `if (last && … handler.failed …)`). If the worker process dies or restarts during a `pii.delete` job's last attempt (`retry.limit: 10`, `registry.ts:96`), the job is dead-lettered with no hook, and the request stays `confirmed` with its `job_id`.
- `ErasureRequestRepository.retry` accepts only `failed` (`packages/db/src/erasure.ts:228`), and a second confirm re-queues only when `job_id` is null. So the admin sees "Deletion in progress · overdue" and has no action.
- Rare: it needs a crash on the 10th attempt. A-006 itself is met, because the request is never shown as done. S3 noted this in STATE, and S1 has not placed it yet.

Required fix: let `retry` also take a `confirmed` request whose job record is `failed` (the job record is in db-main), with a test. Or have the dead-letter path call the hook. S1 to place.
Resolution:

## F-M04e-02 — Minor — A claimed request whose queue call failed shows "Deleting…" with no action
Area: 1 Correctness  IDs: DEL-4
Evidence:
- If the confirm request fails after `claim` commits (S5-20261118-02), the request is `confirmed` with `job_id` null. The server queues it on a second confirm (`apps/web/src/privacy.ts`, confirm path; tested at `privacy.int.test.ts:444`).
- The screen offers no way to send that confirm:
  - `Outcome` (`apps/ui/src/routes/buyer-data.tsx:650-690`) shows "Deleting N records…" with no action.
  - The list row offers Confirm only when the request is `open` and Retry only when it is `failed` (`buyer-data.tsx:836-844`).
- The list also polls every 2 s for as long as such a row exists (`buyer-data.tsx:138`).

Required fix (S2): for `confirmed && jobId === null`, show plainly that the deletion has not started, with an action that calls confirm again. Add an e2e test using a mock request in that state. Polling may stay, since the action ends the state.
Resolution:

## F-M04e-03 — Minor — The "truncated" warning is dead code
Area: 1 Correctness  IDs: DEL-4
Evidence: `buyer-data.tsx:382` (`result.truncated && …`). Since A-001 the server answers 422 `too_many_matches` and never returns a truncated request.
Required fix (S2): delete the branch (S1 ruled this in the M04 end handoff).
Resolution:

## F-M04e-04 — Minor — The UI's identifier rule is a copy of the contract's, and no test keeps them in step
Area: 8 Requirement coverage  IDs: DEL-4, DEL-5
Evidence:
- `pinsOneBuyer` (`buyer-data.tsx:125`) and the MSW mock's rule (`apps/ui/src/mocks/privacy.ts:324`) restate the refine in `packages/contract/src/routes/privacy.ts:38`.
- Each is tested only on its own side (e2e "a postcode alone does not pin one buyer"; mock test at `privacy.test.ts:61`). A change to the contract rule would leave the screen refusing or sending the wrong sets.

Required fix (S2): one shared table of identifier sets with the expected outcome, checked against `BuyerIdentifiersSchema` and against `pinsOneBuyer` and the mock. Export `pinsOneBuyer`. The schema may be imported in a test only, if dependency-cruiser allows; otherwise put the table in `packages/contract` with its own schema test, and have the UI test read the same table. S1 accepted the copy itself; this finding is only about the missing test (S1's ruling).
Resolution:

## Accepted, not raised (S1 rulings or earlier decisions)

- The card follows the list query (S1's ruling). The global eBay key-fetch cap per web process (STATE follow-up). `MAX_EXPORT_RECORDS` stays at 500 (ADR-068).
- The M07, M08 and M10 needs-validation items (ADR-068) and the M22 journal timer are already placed.

## Notes for later

- M05: alert on `pii.erasure_failed`, `ebay.public_key_throttled`, `ebay.account_deletion.too_large` and `vault.canary_read`.
- The picomatch audit exception expires on 1 Dec 2026 (PS-026, ADR-065).
- Local full runs on this 7.9 GB host must not run beside other heavy work: lint alone ran out of heap when run in parallel.
