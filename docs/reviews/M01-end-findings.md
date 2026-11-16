# M01 end findings — round 1
Reviewed: T-0101 to T-0106 (PRs #1, #2, #3, #5, #9, #12; main `9ea858d`), verify.sh: PASS (full gate, rc=0, 766 s, from a clean state; `--docs` PASS in 25 s)
Acceptance re-run: 39/39 PASS (three items rest on CI evidence; see the table)

From S4, 20 Oct 2026. Verdict: **BLOCKED** (4 Majors open, 0 Blockers). Round 1 of at most 2 (ADR-044).

## How I ran it

- Clean state: `docker compose … down -v`, `bash scripts/dev-secrets.sh --reset`, `COREPACK_HOME=D:\.corepack`. Docker has 3.77 GiB.
- **`scripts/verify.sh` (full): rc=0 in 766 s.** Every step ok: install, lint (65 s), typecheck, openapi, depcruise, names, coverage, limits, squawk, actionlint, caddy, unit (30 s, 52 files / 203 tests), integration (151 s, 9 files / 40 tests), contract (2), build, stack (292 s), e2e (86 s), gitleaks, audit. One run, so it does not repeat S3's five-run evidence for O-1, but it was green on the first try after `down -v`.
- Memory: no OOM. Peaks: clamd 986 MiB of 1,400, web 63 of 384, worker 43 of 512, db-main 66 of 1,536; the whole stack was well under the 3.77 GiB VM.
- `scripts/verify.sh --docs`: rc=0, 25 s (install, format, coverage, gitleaks).
- `bash scripts/ui-refs.sh "order-detail matches"`: rc=0, **0 images changed**; the regenerated `order-detail-linux.png` is byte-identical to the committed one (SHA-256 `57e5f658…`). It took **16 min 56 s** here, not about 8: the container installs with a cold pnpm store (221 MB downloaded) and the whole run is silent for most of that time (see Follow-ups).
- GitHub CI (via `gh`): the code PR run `39407577612` took 6 min 01 s, green, with static/tests/stack in parallel; the docs-only PR #14 (`39409597891`) finished in 56 s with the same required check `verify (full gate)`; the push to `main` (`39409913232`) is green.
- Probes in my scratchpad, never committed: catalog and role queries on db-main; rolled-back `ob_app` and `ob_owner` transactions; a gitleaks run over synthetic key variants; a mocked-queue probe of the lease path; real-filesystem probes of the file store and key store; a one-line schema edit for the openapi drift check and a two-row edit of the secrets register, both reverted at once (`git status` clean).
- `/code-review` was not re-run: S3 ran it per ADR-043/044, and I reviewed the diffs by hand.

## Halfway carry-over: each resolution checked by me

| Finding | Result | Evidence |
|---|---|---|
| F-01 (config tests time out) | VERIFIED | Gate green; `[SEC-5]` and `[OPS-10]` tests pass in the unit step (30 s total). The model is built in `beforeAll` with a 120 s timeout. |
| F-02 (gitleaks KEK rule) | VERIFIED | I re-ran my 7 probe variants (bare, indented, `.env`, YAML, JSON, TypeScript, two-version keyring) against the new rule: **all 7 flagged**. A bare base64 key with no `<version>:` prefix is not flagged, which is by design. |
| F-03 (runbook step 3) | VERIFIED, but see F-M01-end-03 | The superuser query is in the register and `postgres` / `omnibridge` are the real names. The runbook still omits the file keys. |
| F-04 (`delete_after`) | PARTLY | Migration 0005 adds the column and the NOT VALID CHECK, and the purge and retire paths use `delete_after`. The purge index was not moved (F-M01-end-06). |
| F-05 (`CREDENTIAL_KINDS`) | VERIFIED | Union plus runtime refusal; test `[INT-3] unknown credential kinds are refused…` passes. |
| F-06 (rewrap `kek_version <`) | VERIFIED | `credentials.ts:198` selects `<`, a separate count of newer ones is logged; test passes. |
| F-07 (concurrent `replaceCurrent`) | VERIFIED | `pg_advisory_xact_lock(hashtextextended(…))` in `#lock`; concurrency test passes. |
| F-08 (`.dockerignore`) | VERIFIED | `infra/secrets` and `infra/secrets/**` are on lines 14-15; config test passes. |
| ADR-045 waiver | VERIFIED | The only `squawk-ignore` in either migration directory is `0005_…sql:21`, in the annotated form, with `-- waiver: replaced by credentials_inactive_delete_after; F-M01-halfway-04` directly above. `[SEC-4] migration 0005: squawk fails … without the waiver line and passes with it` passes, and a second test pins every waiver to that form. squawk config disables no rule. `credentials_inactive_delete_after` is `NOT VALID` (`convalidated = f`) on an empty table, which is fine. |
| O-1 (intermittent e2e) | VERIFIED | `wait_ready` (verify.sh) waits up to 120 s for `/healthz` ok through the edge and for the site; my run was green. |
| Port 5173 reuse (PR #9) | VERIFIED | verify.sh runs Playwright with `OB_UI_PORT=5199 OB_E2E_OWN_SERVER=1`; the two config tests that pin this pass. |
| S3 question: is `expires_at` still right for inactive rows? | YES | Only `store`/`replaceCurrent` set it (the provider expiry). Nothing reads it for purging now. Only the old index still uses it (F-06). |

## Acceptance re-run

| Task | Item | Result | Evidence |
|---|---|---|---|
| T-0101 | verify.sh exits 0 on a clean clone | PASS | My run after `down -v` (rc=0), and every CI run, which uses a fresh checkout. I did not make a fresh clone myself. |
| T-0101 | `compose up -d --wait` healthy | PASS | The stack step runs `up -d --wait` then `wait_ready` (ok); e2e passes against it |
| T-0101 | `https://localhost:8443/healthz` ok, db_main ok, db_pii ok | PASS | `[NFR-2] /healthz reports db_main and db_pii ok through the edge` passes in e2e |
| T-0101 | check-limits rejects an unlimited service | PASS | `[OPS-10] check-limits rejects unlimited service` |
| T-0101 | `[DP-8] logger redacts PII markers` | PASS | unit |
| T-0101 | req-coverage 324 / 324 / 0 / 0 | PASS | `324 IDs indexed, 324 owned, 0 unmapped, 0 prd_ids outside their module; 33 IDs cited in 66 test files` |
| T-0101 | actionlint, every `uses:` a 40-character SHA | PASS | actionlint ok; I grepped workflows and the composite action: none unpinned |
| T-0102 | verify.sh exits 0 | PASS | full gate |
| T-0102 | `[SEC-3]`, `[CAP-7]`, `[NFR-7]`, `[NFR-6]` tests | PASS | unit |
| T-0102 | schema change without regeneration fails the gate | PASS | edit → `contract:check` rc=1; revert → rc=0 |
| T-0103 | verify.sh exits 0 | PASS | full gate |
| T-0103 | three `[SEC-6]` envelope tests; `[INT-3]` never logs plaintext; `[SEC-5]` secrets as files | PASS | unit and integration |
| T-0103 | gitleaks finds nothing in history | PASS | gate gitleaks step (git + dir) |
| T-0104 | verify.sh exits 0 | PASS | full gate |
| T-0104 | `[NFR-3]` restart, idempotency, DLQ + redrive; `[OPS-10]` cap of 4 under 50 jobs; `[NFR-4]` progress route | PASS | `apps/worker/src/jobs.int.test.ts`, `apps/web/src/jobs.int.test.ts` pass in integration |
| T-0105 | verify.sh exits 0 | PASS | full gate |
| T-0105 | `[NFR-5]` tampered/expired link 403; bytes not plaintext on disk; `[SEC-2]` EICAR, wrong-type, CSP; `[MAIL-2]` Mailpit | PASS | files/web/worker/mail tests pass; EICAR runs against the pinned clamd, Mailpit against the pinned Mailpit |
| T-0106 | verify.sh exits 0 in CI on the batch PR | PASS | run `39407577612` green |
| T-0106 | `[CAP-7]` pages 20/50/100, 201 rejected, default 50; total capped at 10,000 | PASS | `packages/contract/src/pages.test.ts` |
| T-0106 | `[SEC-4]` gitleaks from a worktree finds a planted secret | PASS | `tests/config/gitleaks-worktree.test.ts` |
| T-0106 | ui-refs regenerates a Linux image identically | PASS | 1 run here, identical to the committed image (S3 reports two runs) |
| T-0106 | docs-only PR on the fast path in under 2 minutes, same check name | PASS | PR #14: 56 s, `verify (full gate)` |
| T-0106 | code PR as parallel jobs, wall time recorded | PASS | 6 min 01 s, confirmed. I did not re-check the 8 min 14 s "before" figure. |
| T-0106 | O-1 fixed | PASS | see the carry-over table |
| T-0106 | `[SEC-4]` migration test (renumbered 0005) | PASS | passes; see the F-04 row |

## Checked, no finding

- **RLS and grants on the new tables:** `relrowsecurity` and `relforcerowsecurity` are both true for `app.job_records`, `app.job_leases` and `app.files`, plus the earlier two; each has one ALL policy with USING = WITH CHECK on `app.workspace_id`. As `ob_app` I could not insert a row for another workspace into any of the three, and with an empty or other workspace id `ob_app` sees 0 rows. `ob_app` has no CREATE on `app` or `pgboss` and cannot DROP/CREATE tables.
- **Job envelope (invariant 12/19):** `parseEnvelope` runs on send and on receive; an invalid envelope goes to the DLQ without retries; the record and the pg-boss send commit in one transaction (`fromKysely`). Heavy cron windows reject `*` and steps. The 25 s graceful stop fits the 30 s Docker grace.
- **Files:** AES-GCM chunks are bound to file id, index and a last-chunk flag, so truncation is detected; signed links are compared in constant time against the canonical spelling and bound to file, session and expiry; the response carries `content-disposition: attachment`, `nosniff` and `no-store`; random file ids; no original filename stored; workspace ids are checked as UUIDs before they build a path. No secret appears in any container log (I grepped for every `.secrets` value) and the runtime images hold no key material.
- **Helmet/CSP:** strict, no inline script, `frame-ancestors 'none'`, HSTS. Caddy writes no access log, so the signed-link query string is not recorded.
- **Mail:** the lint refuses PII markers, key lines, age keys and private keys; the transport requires STARTTLS unless dev `allowPlain`.
- **Limits and networks:** unchanged from the budget; the new files volume is read-only in the worker.

## F-M01-end-01 — Major — A failed "active" record update leaks the per-account lease for good
Area: 5 Rate limits / 1 Correctness  IDs: OPS-10, NFR-3
Evidence: `packages/queue/src/runtime.ts:240-241`. `#takeSlot` acquires the lease and starts a renew timer (`:315`), and only then does `await this.#records.update(ctx, key, { state: 'active', … })` run, **outside** the `try … finally { await release() }` that starts at `:242`. If that update throws (a database blip, a statement timeout, a failover), the handler never runs and `release()` is never called: the renew timer keeps extending the lease until the process exits. Probe (mocked boss/records, `perAccountCap: 1`, `heartbeatSeconds: 10`, `update` rejects): `handler rejected: db down`, then after 22 s `{"acquire":1,"renew":2,"release":0}`. A real worker stays alive, so the slot is held and renewed **indefinitely**. With a cap of 1 (or 4 such failures with a cap of 4) every later job for that account and job type waits until `expireInSeconds` and then fails; the retry of the same job cannot take its own slot either, because `acquire` only reuses expired rows.
Required fix:
1. Move the `active` update (and anything else after `#takeSlot`) inside the `try`, so `finally` always releases and clears the timer.
2. Also clear the timer if `limiter.acquire` throws.
3. Add a regression test with a limiter spy and a records store whose first `update` rejects: after the failure `release` has been called once, no renew happens afterwards, and a second job for the account runs.
Resolution: FIXED (S3, branch `task/M01-end-fixes`). The `active` record update moved inside the `try` (`runtime.ts`), so `finally` always clears the renew timer and releases the lease. Item 2 needed no change: the renew timer starts only after `limiter.acquire` has succeeded, so a throwing `acquire` has no timer to clear. Regression test `packages/queue/src/runtime.test.ts` `[OPS-10] [NFR-3] a failed "active" record update releases the lease and stops its renewal` (in-memory limiter spy, cap 1, fake timers): it failed before the fix (`release` 0) and passes after. It checks that `release` is called once, there is no renew in the next 60 s, and a second job for the account runs.

## F-M01-end-02 — Major — A file-read error crashes the process, and a refused download leaks an open file
Area: 6 Performance / 4 Security (availability)  IDs: NFR-5, SEC-2
Evidence: `packages/files/src/store.ts:170`: `createReadStream(path).pipe(decryptStream(key, id))`. `pipe` does not forward errors, and nothing listens on the source. Probe with the real store and a temporary filesystem (output verbatim):
```
get(scanning): FileNotReadable
source stream after rejected get(): destroyed= false closed= false
UNCAUGHT EXCEPTION: ENOENT open
```
(a) When the metadata row exists but the bytes are missing or unreadable (a restored or lost volume, a permission change, an I/O error), the source stream emits an unhandled `error`, which is an uncaught exception **even though the caller attached an error handler to the returned stream**. In the web app that is one `GET /files/:id`; in the worker it is every `files.scan` job. The process dies, and in the worker the job returns and kills it again after each restart. (b) `get()` for a file that is not `clean` calls `file.stream.destroy()` (`:160`), which destroys only the decrypt stream: the underlying read stream stays open (`destroyed=false`), so each request for a `scanning` or `infected` file leaks a file descriptor.
Required fix:
1. Build the read side with `stream.pipeline` (or `Readable.from(compose(...))`) so an error on the source destroys the returned stream with that error, and destroying the returned stream destroys the source.
2. Make `get()` and `openForScan()` surface a missing file as `FileNotReadable` (or a typed read error) for the web route's 404/500 mapping, never as an uncaught event.
3. Tests: bytes removed after the metadata insert → the stream errors and the process survives; a rejected `get()` for a `scanning` file leaves no open stream (spy on `createReadStream`'s result: `destroyed === true`); the worker scan handler rejects (so the job retries) instead of crashing.
Resolution: FIXED. `store.ts` reads through `#open()`: `fs.promises.open` first (ENOENT → `FileNotReadable`, so the web route's 404 and a rejected scan job that retries), then `stream.pipeline(handle.createReadStream(), decryptStream(…))`, so a later read error reaches the returned stream and an early `destroy()` closes the file. `get()` now checks `state === 'clean'` **before** opening anything. Tests in `packages/files/src/store.test.ts` (real temporary filesystem; `node:fs/promises.open` wrapped to track every handle): bytes missing behind a row → `FileNotReadable` for `get` and `openForScan`; a directory in place of the file → an error on the stream with every handle closed and no uncaught exception (before the fix, vitest reported the uncaught `ENOENT` and `EISDIR`); `get()` on a `scanning` file opens nothing; an early `destroy()` closes the handle. The scan handler is unchanged: `openForScan` now rejects (the job retries), and a mid-stream error rejects `scanWithClamd`.

## F-M01-end-03 — Major — The documented KEK rotation leaves every stored file unreadable; `rewrapAll` is never called or tested
Area: 9 Invariants / 8 Requirement coverage  IDs: SEC-6, NFR-5
Evidence: File keys are wrapped under `secrets_kek` and live on the volume (`packages/files/src/keys.ts`). The runbook in `docs/ops/secrets-register.md` ("Rotate a master key", steps 2-4) re-wraps and checks only `app.data_keys` in the database, then tells the operator to remove the old line. `FileKeyStore.rewrapAll()` (`keys.ts:71`) exists, but `grep -rn rewrapAll` finds **only its definition**: no job, no script, no runbook line and no test. Probe (real store; ring v1 → v2; the DB steps of the runbook only): `runbook only: file key UNREADABLE -> The secrets keyring has no KEK version 1`. With `rewrapAll()` run before the old line is removed: `re-wrapped: 1`, then the file key opens and decrypts. So following the runbook exactly makes every file in every workspace permanently undecryptable (data loss), and the SEC-6 requirement that rotation re-wraps data keys without touching data is only met for the credential store.
Required fix:
1. Add the file keys to the runbook, with the exact command and a check that no `keys/v*.json` is still under an old `kekVersion` (and a note that the volume is read-only in the worker, so it runs in web or a one-off job).
2. Provide the callable path (a small script or job that runs `rewrapAll`), and note in T-0201's task that the all-workspace re-wrap job covers both the database keys and the file keys.
3. Test `rewrapAll`: files written under v1 still decrypt after ring [v1, v2] → `rewrapAll()` → ring [v2]; a second call returns 0; a crash between the `.tmp` write and the rename leaves the old key readable.
Resolution: FIXED. (1) Runbook step 4 in `docs/ops/secrets-register.md` ("`secrets_kek` only: re-wrap the file keys"): the command, why it runs in web, and that it must exit 0 before the old line is removed. (2) `apps/web/src/rewrap-file-keys.ts` (`node dist/rewrap-file-keys.js` in the web container) runs `rewrapAll()` and then the new `FileKeyStore.countStale()`, and exits 1 if any key is still under an old KEK. T-0201's all-workspace job is in PS-015 (2) for S1, because only S1 edits the backlog. (3) Tests in `store.test.ts`: a file written under [v1] decrypts after [v1, v2] → `rewrapAll()` = 1 → ring [v2] (the key file's `kekVersion` is 2, `countStale` goes 1 → 0); a second `rewrapAll()` returns 0; without it, ring [v2] fails with `no KEK version 1`; a partial `v1.json.tmp` left by a crash leaves the old key readable and does not stop the next re-wrap. The re-wrap temp file is now fsynced before the rename.

## F-M01-end-04 — Major — The docs fast path skips tests that read `docs/`, so a docs-only PR can break `main`
Area: 8 Requirement coverage / gate integrity  IDs: SEC-4, SEC-16
Evidence: `scripts/lib/docs-only.mjs:9` counts a PR as docs-only when every changed path starts with `docs/` or ends in `.md`; CI then runs only `verify.sh --docs` (install, prettier, coverage, gitleaks). But some tests consume files under `docs/`: `tests/config/secrets.test.ts:114` reads `docs/ops/secrets-register.md`, and the Playwright `ui` project compares screenshots with `docs/design/reference/*.png` (`playwright.config.ts:42`). Demonstration: I deleted the `file_link_hmac_key` and `pii_kek` rows from the register (nothing else changed) → `git diff --name-only | node scripts/lib/docs-only.mjs` printed `true`, while `[SEC-5] the secrets register lists every secret with an owner and a rotation interval` **failed** (`listed: false`). In CI that PR would take the fast path and turn `verify (full gate)` green, and the broken test would surface only on the next code PR, with the breaking change already merged. The same holds for a PR that edits a reference PNG: the screenshot tests never run against it. A smaller gap in the same place: CI uses `git diff --name-only`, which lists only the destination of a rename, so moving a source file to `docs/x.md` looks docs-only.
Required fix:
1. Make the classifier exclude every path a test reads. Simplest: docs-only = `*.md` and `docs/**` **except** `docs/ops/secrets-register.md`, `docs/design/reference/**` and any other file a test or script reads (`docs/plan/**` and `docs/backlog.json` are already covered by the `coverage` step).
2. Add a unit test that fails when a test or script file names a `docs/…` path (a grep over `tests/`, `scripts/`, `packages/*/src` and `playwright.config.ts`) that the classifier would call docs-only, so a future reader of a doc cannot slip through.
3. Run CI's diff with `--no-renames`, and add a classifier test with a rename from a code path.
Resolution: FIXED. (1) `scripts/lib/docs-only.mjs` has `READ_BY_TESTS` (`docs/ops/secrets-register.md`, `docs/design/reference/`), which always run the full gate, and `READ_BY_DOCS_GATE` (PRD, requirements index, MODULES, backlog), which the `coverage` step checks on the fast path. (2) Guard test `[SEC-4] every docs path a test or script names is either full-gate or checked on the fast path` (`tests/config/ci.test.ts`): it scans every tracked `.ts/.tsx/.mjs/.js/.sh` under tests, scripts, packages, apps, mocks and `*.config.ts`, skipping comments. Mutation check: with the register taken out of `READ_BY_TESTS`, it fails and names `tests/config/secrets.test.ts: docs/ops/secrets-register.md`. (3) CI runs `git diff --no-renames --name-only`; test `[SEC-4] a file moved from code into docs/ is not docs-only in the CI diff` makes a real `git mv packages/a.ts docs/a.md` in a temporary repo, takes the diff flags from `ci.yml`, and checks that the old path is listed and the result is not docs-only. The help text in `verify.sh` was updated to match.

## F-M01-end-05 — Minor — `app.job_records` and `app.job_leases` have no retention or cleanup, and the report says otherwise
Area: 6 Performance and memory  IDs: NFR-3, NFR-4
Evidence: The end report says job-record retention "exists as repository methods". `packages/db/src/job-records.ts` has only `createAndEnqueue`, `update` and `get`; `grep -rniE "purge|retention"` over `packages/db/src`, `packages/queue/src` and `apps/worker/src` finds none for job records or leases. `job_records` gets a row per job forever (with an unbounded `result jsonb`), `job_leases` rows for a removed account stay, and neither table has an index on `updated_at` or `expires_at` to delete by. Nothing breaks today; it is a slow growth in db-main (1.5 GiB budget).
Required fix: Before M07 starts producing jobs, add a `JobRecordRepository.purge(ctx, olderThan)` for finished records (and expired leases), an index to delete by, a scheduled platform job once T-0201 gives the workspace list, and a cap on `result` size. Correct the report's statement. Optional: refuse results that carry a `PIIMARK-` marker in the queue test, since results land in db-main (invariant 7).
Resolution: LOGGED, not fixed. The report's statement is corrected (`M01-end-report.md`, risk 2). The purge, index, result cap and schedule are proposed to S1 as PS-015 (3): they need T-0201's workspace list, and the index hits the same squawk limit as F-06.
Resolution (T-0207): fixed. `JobRecordRepository.purge` (finished records and expired leases older than 30 days), indexes `job_records_finished` and `job_leases_expires` built CONCURRENTLY (0017, ADR-047), a 16 KiB cap on `result` (0016), and the daily `housekeeping.daily-sweep` sends one `jobs.retention` job per workspace. Test: `packages/db/src/housekeeping.int.test.ts` `[NFR-3][NFR-4]`.

## F-M01-end-06 — Minor — F-04 left the purge index on `expires_at`
Area: 7 Migration safety  IDs: SEC-6
Evidence: My halfway fix asked for the purge index to move onto `delete_after`. `pg_indexes` shows `credentials_purge ... USING btree (workspace_id, expires_at) WHERE (NOT is_active)`, while `purgeExpired` filters on `delete_after` (`credentials.ts:175`). The index no longer serves the query.
Required fix: A new migration (0006): `CREATE INDEX … ON app.credentials (workspace_id, delete_after) WHERE NOT is_active`, then drop `credentials_purge` (drop-index is safe under squawk without a waiver). Do not edit 0002 or 0005.
Resolution: BLOCKED ON S1 (PS-015 (1)). The migration as written fails squawk (`require-concurrent-index-creation` and `require-concurrent-index-deletion`, checked with a probe file). `CONCURRENTLY` cannot run inside the runner's per-file transaction, and ADR-045 allows no other waiver. I proposed two options. The old index stays meanwhile and does no harm on an empty table.
Resolution (T-0207): fixed. 0017 runs outside a transaction (ADR-047): `credentials_purge_due` on `(workspace_id, delete_after) WHERE NOT is_active`, then `DROP INDEX CONCURRENTLY credentials_purge`. squawk: 0 issues, no waiver.

## F-M01-end-07 — Minor — The first use of a workspace's file key can fail on a race, and the key file is not written atomically
Area: 1 Correctness  IDs: NFR-5
Evidence: `packages/files/src/keys.ts:51` writes `v1.json` in place with `wx`. A second caller that finds the file during the write reads an empty file. Probe: 300 trials of 4 concurrent `active()` calls on a fresh workspace → 3 failed with `Unexpected end of JSON input`. A crash mid-write would leave a truncated `v1.json`, after which `active()` finds it and `get()` fails for that workspace for good. Related, smaller: `put()` can leave an orphan `.bin` if the process dies between the rename and the metadata insert, and `delete()` removes the metadata before the bytes, so a failed `rm` leaves bytes with no row. Nothing sweeps either.
Required fix: Write the key to a temp file, `fsync`, then `link`/`rename` it to `v1.json` (failing with EEXIST for the loser, who then reads the winner's complete file); add a test for the concurrent first use. Optional: a sweep of volume files with no metadata row, to run with the file purge.
Resolution: FIXED. `FileKeyStore.active()` writes the new key to a unique `v1.json.<uuid>.tmp`, fsyncs it, then `link`s it to `v1.json` (EEXIST for the loser, who reads the winner's complete file) and removes the temp file. Test `[NFR-5] concurrent first use of a workspace key never reads a half-written file`: 200 trials of 4 concurrent `active()` calls, each giving version 1 and leaving only `v1.json`. Before the fix it failed with `Unexpected end of JSON input`. The orphan `.bin` and the delete-order sweep remain optional and are not done.

## F-M01-end-08 — Minor — `ob_app` can change a file from `infected` to `clean`
Area: 4 Security  IDs: SEC-2
Evidence: Probe as `ob_app` inside a rolled-back transaction: `UPDATE app.files SET state='infected'` then `UPDATE app.files SET state='clean'` → `UPDATE 1` twice. The scan handler only sets state from `scanning`, but any bug or injection in web (which also holds `ob_app`) can mark an unscanned or infected file readable, bypassing the ADR-021 rule that a file is clean only after clamd says so.
Required fix: A trigger on `app.files` (or a column-level grant plus a `WHERE state = 'scanning'` rule in the only writer) so `state` can only move from `scanning` to `clean`, `infected` or `scan_failed`, and never back; test it as `ob_app`. This can wait for M02 if S1 prefers; then log it as a follow-up.
Resolution: FIXED. Migration `0006_files_state_guard.sql` adds a `BEFORE INSERT OR UPDATE OF state` trigger on `app.files`: a new row must be `scanning`, and `scanning` may move once to `clean`, `infected` or `scan_failed`, never anywhere else. squawk reports 0 issues. Tests `packages/db/src/files.int.test.ts`, as `ob_app` on the real migrated cluster: infected → clean, infected → scanning, scan_failed → clean and clean → infected all raise `cannot move`; a raw-SQL insert of a `clean` row raises `must start in state scanning`. `migrate.int.test.ts` lists 0006.

## F-M01-end-09 — Minor — `renderInvite` puts any URL scheme into the link
Area: 4 Security  IDs: MAIL-2
Evidence: `packages/mail/src/templates.ts:133` escapes `acceptUrl` for HTML but never checks its scheme or host, so a value such as `javascript:…` or a foreign `https://` host would be sent as the "Accept the invitation" button. Today no caller passes user input; M02 will build the URL from a token.
Required fix: `renderInvite` accepts only an `https:` URL (or `http://localhost` in dev) on the configured app origin, and throws otherwise; add a test with `javascript:` and an off-origin URL.
Resolution: FIXED. `renderInvite` takes `appOrigin` and refuses (EmailLintError) any link that is not https on that origin, allowing http only for `localhost`/`127.0.0.1`. The button and text use the parsed `href`. Test `[MAIL-2] the invite link must be https on the app origin`: `javascript:`, an off-origin https host, http on the app host and a non-URL are refused, and a localhost dev origin is accepted.

## Follow-ups (not findings)

- `scripts/ui-refs.sh` ran for 16 min 56 s here with no output for most of it (`pnpm install` is silenced and the container has no pnpm store). Consider a named volume for the pnpm store and printing progress; S2 runs this often.
- The email template header still uses the old navy `#1B2A6B`; ADR-041 moved the accent to petrol. S1/S2 to decide whether mail follows the app.
- `EncryptedLocalFileStore.put()` enforces no maximum for a stream input (only the DB `CHECK` of 100 MiB, after the bytes are written). The first upload route (not built yet) must cap the body at the HTTP layer.
- `perAccountCap` is per job type and account, as S3 asked: I agree. An account-wide budget belongs to the provider governors in M07 (RL-1 to RL-4), not to the queue.
- T-0201 owns, as already recorded: `rls-coverage` over `app.data_keys`, `app.credentials`, `app.job_records`, `app.job_leases` and `app.files` (all five are correct by hand today); the all-workspace re-wrap job (see F-M01-end-03); workspace fan-out for the purges.
- `ob_app` can read every workspace's pg-boss job payloads (pg-boss tables carry no RLS, by ADR-009). Payloads must stay free of PII; T-0201's marker scan (AT-9) should cover the `pgboss` schema.

---

# M01 end findings — round 2
Reviewed: PR #15 (`task/M01-end-fixes`, merged as `48502fb`), the code on `main` at `48502fb`. verify.sh: PASS on the idle rerun (rc=0, 458 s; 54 unit files / 217 tests, 10 integration files / 43 tests, e2e 21/21); one earlier run failed in e2e (see R2-01).
Open Blockers: 0. Open Majors: 0. Minors: 2 carried (F-05, F-06) and 2 new. **Verdict: APPROVED.**

## Round-1 resolutions, verified by me

| Finding | Result | Evidence |
|---|---|---|
| F-M01-end-01 (lease leak) | VERIFIED | Same mocked-queue probe as round 1: `{"acquire":1,"renew":0,"release":1}` (was `release:0`, renew running). The `active` update now sits inside the `try`; unit test `runtime.test.ts` passes. |
| F-M01-end-02 (file read crash, handle leak) | VERIFIED | New probe on the real store: a refused `get()` of a `scanning` file opens 0 handles; an early `destroy()` leaves the handle closed (`fd = -1`); a clean read returns all 300,009 bytes; corrupted bytes reach the consumer as a `Decryption failed` error; missing bytes give `FileNotReadable`; no uncaught exception, 0 leaked handles. |
| F-M01-end-03 (KEK rotation and file keys) | VERIFIED | Runbook step 4 and `dist/rewrap-file-keys.js` exist. In the running web container: empty volume → exit 0, count 0; a planted v1 file key with a v1+v2 keyring → `count":1, "kekVersion":2`, exit 0; second run `count":0`, exit 0. `countStale()` and the `rewrapAll` tests run in the unit step. |
| F-M01-end-04 (docs fast path) | VERIFIED | `echo docs/ops/secrets-register.md \| node scripts/lib/docs-only.mjs` → `false`; the reference PNG → `false`; `docs/STATE.md` + `README.md` → `true`. CI uses `--no-renames` (pinned by a test with a real rename). The guard test scans tracked files for `docs/` paths that tests or scripts read. I re-grepped every docs path in tests, scripts and config: every reader is on the full-gate list or the `coverage` step. |
| F-M01-end-07 (key-file race) | VERIFIED | Same 300-trial probe: **0 failures** (was 3). |
| F-M01-end-08 (file state guard) | VERIFIED | As `ob_app` on the live db-main: insert as `clean` fails; `scanning → infected` works; `infected → clean` and `infected → scanning` fail; delete + re-insert as `clean` fails; `ALTER TABLE … DISABLE TRIGGER` fails (`must be owner of table files`). |
| F-M01-end-09 (invite URL) | VERIFIED by code and test | `checkAppUrl` accepts https on the app origin (http only for localhost); the `[MAIL-2]` test passes in unit. Not re-probed by hand. |
| F-M01-end-05 (retention) | ACCEPTED as deferred | The report is corrected; the purge, index, result cap and schedule are in PS-015 (3). Needs T-0201's workspace list. Minor, does not block. |
| F-M01-end-06 (purge index) | ACCEPTED as deferred | squawk really does block it (per-file transaction vs `CONCURRENTLY`; ADR-045 allows only the one waiver). The old index stays on an empty table. S1 decides in PS-015 (1). Minor, does not block. |

## R2-01 — Minor — The e2e step failed once on `/healthz` 503 with no logged reason
Area: 6 Performance / gate reliability  IDs: NFR-2
Evidence: My first round-2 gate (rc=1, 494 s) failed at `e2e` with `[NFR-2] /healthz reports db_main and db_pii ok through the edge`: Expected 200, Received 503, and `[NFR-8] the component gallery has no serious or critical accessibility violations`: heading not found (15 s). It was **not** the ui-perf test, which passed. The stack step had just passed `wait_ready`, so this is the O-1 symptom after readiness. The rerun on an idle machine passed (rc=0, 458 s, e2e 21/21). I cannot rule out that my own probes were running on the same 4 CPUs during the first run, so I do not treat it as a defect of the merged code. But the saved evidence (`.verify/e2e-stack-logs.txt`) cannot say which check returned 503: web logs `/healthz` quietly and records no reason.
Required fix (follow-up, not blocking): in `apps/web/src/app.ts`, log at `warn` (event, failing dependency, duration) when `/healthz` returns 503, so the next occurrence can be diagnosed. S1/S3 to watch the e2e rate: S3 reports 6 of 6 green locally, CI had one ui-perf flake, I had one e2e failure in two runs.
Resolution: CARRIED (S3, 20 Oct 2026). Per S4's approval, a follow-up for the next module: a `warn` log on a 503 `/healthz` (event, failing dependency, duration) in `apps/web/src/app.ts`. Listed in STATE.md and the S1 handoff so it gets a task.

## R2-02 — Minor — `FileKeyStore.rewrapAll()` throws on a key under a newer KEK
Area: 1 Correctness  IDs: SEC-6
Evidence: In the web container, running the script with the old one-line keyring after the keys were re-wrapped to KEK v2 ends with an uncaught `CryptoError: The secrets keyring has no KEK version 2` (`rewrapAll` → `rewrapDataKey` → `openWrapped`); nothing is changed on disk, but the script dies with a stack trace instead of a clean message. This is the file-key twin of halfway F-06, which the database path already handles (`kek_version <`, newer ones counted). It only happens when an old-keyring process runs the script mid-rollout.
Required fix (follow-up): skip keys whose `kekVersion` is above the active version, report them in the log (count only), and let the script exit 1 with that message; add a test.
Resolution: CARRIED (S3, 20 Oct 2026). Follow-up for the next module, best done with T-0201's all-workspace re-wrap job: `rewrapAll`/`countStale` skip keys above the active KEK version, the script logs their count and exits 1, plus a test. Listed in STATE.md and the S1 handoff.

## Closing notes

- The two items for S1 are already in PS-015: the index waiver (F-06) and the retention task placement (F-05). Also for S1 and S2: ADR-046, the ui-perf frame gap on CI attempt 1 was runner noise, as S3 reports.
- Carry into T-0201 as already recorded: `rls-coverage` over all five tables; the all-workspace re-wrap job covering both the database keys and `FileKeyStore.rewrapAll()`/`countStale()`.
- Two untracked S3 handoff files (`20261020-1300-S3-to-S1.md`, `-S3-to-S4.md`) sit in the shared checkout; they are not mine.
