# M04 halfway findings — round 1
Reviewed: T-0401, T-0402, T-0403 (PRs #80, #81, #82, #83), `main` at `34ddbe5`
Gate evidence (ADR-054): CI run 44311869260 on the head of PR #83 is green. My local run: S3's extra command passed (5 files, 33 tests: pii-vault, `deletion`, `pii-boundary` AT-9, db `deletion`). I did not re-run the full local gate.

From S4, 18 Nov 2026. Verdict: **FIX REQUIRED** (0 Blockers, 1 Major, 4 Minors). Halfway flow (ADR-044): S3 fixes, no round 2; leftovers go to `M04-halfway-carryover.md` and I check them at the M04 end.

## What I checked and found sound
- **Vault storage:** forced RLS on every `vault` table, a ciphertext per field with AAD = workspace, table, field, `pii_ref`; blind indexes are HMACs keyed per workspace with the field in the input; no plaintext or mask is stored; the access log has no value columns; keys, tombstones and the log are append-only for `vault_app`.
- **Auth:** one token per caller, digest compare in constant time, tokens under 32 characters refused at boot, fixed capabilities; the `deletion` token can only delete; errors carry a code and route only, request logging is off.
- **Deletion:** journal is appended and fsynced before the delete; fields, indexes and records go in one transaction with the tombstones (db-pii) and run log; VACUUM follows; a repeat with the same run id deletes nothing and reports the run. I broke it on purpose (skipped the blind-index delete): 6 deletion tests failed, so the tests do guard it.
- **T-0401 carry-overs:** the three halfway Minors from M02 end are closed (invite text, atomic invite accept, job company scope, `ci.test` timeout, caps, 0023 drop with its waiver and the earlier-revoke test); the first one has a regression, see F-M04h-01.
- Acceptance re-run: T-0402 and T-0403 items all have a passing test (AT-9 marker scan, wrong capability 403, cross-workspace 404, access-log row without a value, day 24 vs day 25).

## F-M04h-01 — Major — Since 0021 the platform cannot invite a workspace's first admin
Area: 3 Security / 8 Requirement coverage  IDs: TEN-7, PERM-5
Evidence: `POST /api/platform/workspaces/:id/invites` (`apps/web/src/users.ts`, `inviteFirstAdmin`) runs `tenancy.run({ workspaceId, companyIds: [], userId: platform.userId }, …)`. Migration 0021 (`0021_m02_end_fixes.sql`, policy `invites_admin_insert`) lets an insert through only when no user is named or the named user is an admin of that workspace. An operator is not a member. I ran the same call as a throwaway integration test on `main` (not committed): `new row violates row-level security policy "invites_admin_insert" for table "invites"`. No test calls this route end to end (the route walker in `isolation.int.test.ts:295` only checks isolation), so CI stayed green. TEN-7: "a platform admin creates a workspace and invites its first admin".
Required fix: Run the platform call without a user in the transaction (the audit row already names the platform actor), or add an explicit platform exception to `app.may_manage_members()` that cannot be reached from a request that names a user. Add a test that creates the first-admin invite through the route and accepts it (the TEN-7 path), and one that a child's request still cannot write.
Resolution: Fixed on `task/M04h-fixes` (S3, 18 Nov 2026). `inviteFirstAdmin` (`apps/web/src/users.ts`) opens its tenant transaction with no user: a system write, which `app.may_manage_members()` already allows; the audit row still names the operator. No migration. Tests: `auth.int.test.ts` "[TEN-7] the platform creates a workspace and invites its first admin, who accepts" (console sign-in → create → invite through the route → token as the worker stores it → accept → admin membership); `people.int.test.ts` "[PERM-5] a child still cannot invite, through the route or straight at the database" (403 and the RLS error); guard `apps/web/src/platform-writes.test.ts` (no tenant transaction names the platform operator; fails on the old code).

## F-M04h-02 — Minor — The vault accepts any expiry date
Area: 8 Requirement coverage  IDs: DEL-1, DP-6
Evidence: `ExpiryRequest.delete_after` and the optional `delete_after` of ingest (`packages/vault-client/src/schemas.ts:65,92`) take any ISO date: the year 9999 keeps a record for ever, a past date deletes it at the next sweep. The 90-day backstop (`HARD_LIMIT_MS`, `vault.ts`) is only the default.
Required fix: Bound it in the vault (for example not before 1 day ago and not more than a ceiling S1 names after creation or now), with a test for both ends.
Resolution: Fixed on `task/M04h-fixes`. `Vault.ingest` and `Vault.setExpiry` refuse a `delete_after` before now minus 1 day or after now plus 90 days (`BadExpiry` → 400 `invalid_expiry`, ADR-065). Test: `vault.int.test.ts` "[DEL-1][DP-6] delete_after is accepted only from now minus 1 day to now plus 90 days" (both edges, on ingest and on expiry, and the year 9999).

## F-M04h-03 — Minor — A failed VACUUM is never retried
Area: 9 Invariants (10)  IDs: DEL-2
Evidence: `apps/pii-vault/src/deletion.ts`: VACUUM runs only when `removed.length > 0`. If it fails after the commit, the call answers 500, the retry finds nothing to delete and skips VACUUM, so only autovacuum clears the dead tuples.
Required fix: Run VACUUM on a retry of the same run id as well (the tombstones of the run say it deleted something), or state in the code and ADR-064 that autovacuum is the backstop and test that it is on for the vault tables.
Resolution: Fixed on `task/M04h-fixes`. `DeletionService.delete` VACUUMs whenever the run has tombstones (`removed` or `deleted` non-empty), so a retry runs it again. Test: `deletion.int.test.ts` "[DEL-2] a retry of the same run VACUUMs even though it finds nothing left to delete" (first VACUUM fails after the commit, the retry VACUUMs; a run with no tombstones does not).

## F-M04h-04 — Minor — The vault makes keys on any read, for any workspace id
Area: 3 Security  IDs: DP-5, invariant 7
Evidence: `Vault.#keysFor` creates a key pair the first time any workspace id is used, including by `mask`, `search` and `readFull` (`vault.ts`, `#loadOrCreateKeys`). After a workspace closure deletes its keys, a later ingest or read quietly makes new keys; an unknown id gets rows in `vault.workspace_keys`.
Required fix: Create keys on ingest only; reads of a workspace with no keys answer empty or 404. Decide with S1 whether ingest for a closed workspace must be refused (a closed marker).
Resolution: Fixed on `task/M04h-fixes`. db-pii migration 0004 adds `vault.closed_workspaces` (forced RLS, append-only for `vault_app`). Keys are made only inside ingest's own transaction; reads load keys without creating them (none: `readFull`/`match` 404, `mask` and `search` empty, search still logged) and keys are cached only after the transaction commits. Closure's last batch writes the closed marker with the key delete; ingest for a closed workspace answers 409 `workspace_closed`. Tests: `vault.int.test.ts` "[DP-5] reads never make keys"; `deletion.int.test.ts` closure test now proves the marker, the 409, no new keys and no effect on another workspace. One edge left for the M04 end (carry-over file).

## F-M04h-05 — Minor — Deletion jobs hold a db-main transaction while calling the vault (S3 flagged)
Area: 6 Performance and memory  IDs: DEL-2, invariant 3
Evidence: `apps/worker/src/deletion.ts` loops up to 200 vault batches (each with a journal fsync and a VACUUM) inside the job's transaction; the worker sets `idle_in_transaction_session_timeout` to 180 s (`apps/worker/src/db.ts:15`) and `ob_worker` has 15 connections. A large closure can be cut off at 180 s and then finishes on retry; many at once could hold the pool.
Required fix: The runtime option S3 proposed (run the vault loop before the job's transaction opens), done before the first caller that can trigger a large run (T-0404 erasure or M05 closure).
Resolution: Fixed on `task/M04h-fixes`. The queue gains phased handlers (`PhasedHandler` in `packages/queue/src/runtime.ts`): `prepare` runs with no db-main transaction and no `ctx`, then `commit` runs in the job's one tenant transaction. `pii.delete` and `pii.expiry` run the vault loop in `prepare` and write the run log and tombstones in `commit`. Tests: `runtime.test.ts` "[TEN-1] a phased handler prepares outside any tenant transaction, then commits in one" and "a failing prepare opens no transaction and fails the job for a retry"; `apps/worker/src/deletion.test.ts` "[DEL-2] the vault is called in prepare, in batches; db-main is written only in commit"; the existing worker deletion integration tests pass unchanged.

## Follow-ups (not findings)
- Ingest is not idempotent per subject, and the vault does not read `data_key_version` (both in S3's report): fix with M10's callers and PII key rotation.
- `actor_user_id` in the access log is what the caller says; the log is only as true as web.
- The picomatch exception ends on 1 Dec 2026 (PS-026 with S1).
