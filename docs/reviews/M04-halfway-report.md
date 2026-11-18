# M04 halfway report (S3, 18 Nov 2026)

Batch 1 of M04: the picomatch audit fix, T-0401, T-0402 and T-0403. All are high risk, with Hashir's "go" given in S1's block of 17 Nov.

## Tasks done

| Task | PR | State |
|---|---|---|
| picomatch audit (light, before T-0401) | #80 | merged |
| T-0401 M02 carry-overs | #81 | merged, CI green |
| T-0402 PII store and vault core | #82 | auto-merge on |
| T-0403 deletion service | #83 | auto-merge on (stacked on #82) |

## How each was built

**picomatch (#80).** GHSA-fc5q-39xc-vjpf covers every picomatch release up to 4.0.7, the latest, so no bump or override could clear it.

- Hashir chose a time-boxed exception. `scripts/lib/audit-exceptions.json` lets only this advisory through until 1 Dec 2026; after that the gate goes red again by itself.
- Both audit gates read the file: osv-gate, and the new `pnpm-audit-gate.mjs`, which replaces `pnpm audit --audit-level high`.
- PS-026 asks S1 to confirm the mechanism.

**T-0401 (#81).** Every M02 end finding is closed:

- **F-M02e-01:** migration 0021 adds restrictive write policies on the member, tick, invite and review tables, through `app.may_manage_members()`. The named user must be an admin, or the transaction names no user (worker, seed). A first admin may be added only while the workspace has none.
- **F-M02e-03:** `job_records.company_id`, plus a SELECT scope for web.
- **F-M02e-04:** `app.invite_accept_new_user` accepts the invite and sets the password in one call.
- **F-M02e-02:** the invite mail states the real lifetime (72 hours).
- **F-M02e-05:** the `ci.test` git test gets a 30 s timeout.
- **F-M02e-06 / ADR-064:** db-main `max_connections` is 45, and caps sum to at most max − 5 on both clusters (db-pii `vault_app` cap 8 → 6).
- **ADR-063:** 0023 drops the three revoked functions, with the `ban-drop-function` waiver. The waiver test now also checks that an earlier migration revoked each one.
- **Load failures:** the scan test's "boss undefined" was a teardown error hiding a setup timeout; teardown now stops only what started. The flood test passed under 4x and 8x CPU stress and could not be reproduced; its assertion now prints any stray status.
- 26 test titles cite PRD IDs instead of ADRs, in their own commit.

**T-0402 (#82).**

- **db-pii `vault` schema (0002):** records keyed by `pii_ref` (`uuidv7()`) and workspace, one AES-256-GCM ciphertext per field, blind indexes (HMAC-SHA256 under a per-workspace index key), tombstones, and an access log with no value columns. Forced RLS on `app.workspace_id`.
- **Keys:** the per-workspace data and index keys are wrapped by the PII KEK. `IndexKey` is new in `packages/crypto`.
- **API, one bearer token per caller** (web, worker, deletion), each with a fixed capability set:
  - ingest, with a 90-day backstop expiry (PRD 7.3) when the caller gives none
  - expiry
  - read-full: purpose by caller and by record kind; logged
  - mask: ORD-5, computed on request
  - search: blind index, logged, reports `truncated`
  - match: same-buyer subject IDs on the same channel account (ORD-9)
- **Client:** `@omnibridge/vault-client` holds the shared zod schemas and the typed client.
- **Secrets:** `vault_token_web|worker|deletion` in SOPS and the register.
- **Rules:** dependency-cruiser rules `vault-client-holds-no-keys` and `vault-reached-over-http-only`. A config test proves only db-pii, migrate-pii and pii-vault hold db-pii secrets or join `ob_pii`.
- **AT-9 harness:** testkit `scanDatabaseForMarkers` (every text, json, bytea and array column of `app` and `pgboss`, as the superuser) and `scanTextForMarkers`.

**T-0403 (#83).** One deletion service in the vault (`/v1/delete`, deletion token only). A run works like this:

1. Pick the scope's records (at most 5000 per call; `more` asks the caller to call again).
2. Append IDs-only JSON lines to the off-site journal, fsynced. A local volume, `pii_journal`, stands in for B2.
3. In one transaction: hard-delete fields, index entries and records; write `vault.tombstones` and `vault.deletion_runs`. Workspace closure also deletes the keys.
4. After the commit: VACUUM, then the label-file hook (a no-op until M12).

A retry with the same run id deletes nothing and reports what that run deleted.

- **Worker side:** `pii.delete` serves every event trigger, and `pii.expiry` serves one workspace. The hourly `pii.expiry-sweep` (`5 * * * *`) fans out one expiry job per workspace per UTC hour.
- **Run id:** derived from the job key, so a retry is the same run in the vault and in db-main.
- **db-main half (0024):** `app.deletion_runs` and `app.pii_tombstones`, append-only for the app.
- **One entry point:** `requestDeletion(queue, ctx, {trigger, scope, idempotencyKey})` serves all seven DEL-1 triggers and refuses a scope that does not fit the trigger.
- **Triggers:** expiry is wired. The other six go through the entry point and have tests; their modules call it when they land (cancellation M10, erasure and eBay notice T-0404, Amazon M07, eBay termination M08, closure M05).
- **Certificate:** `GET /api/channel-accounts/:id/deletion-certificate` (connections tab, admin only) returns text with counts, runs and IDs.
- **ADR-058(b):** `app.user_terms_delete` deletes a person's terms acceptances once they have no membership left (ob_worker only). The table stays append-only for everyone else.

## Risks

- Deletion jobs call pii-vault while the queue runtime's job transaction holds a db-main connection. Mail jobs do the same with SMTP. A long workspace closure keeps one ob_worker connection idle in a transaction. Proposed follow-up: a runtime option for jobs that call out over the network.
- Each deletion run that deletes anything VACUUMs three db-pii tables, once per workspace per hour at most. This is fine at launch volumes; revisit with real numbers (M22).
- Erasure and the eBay notice delete by `refs`: the caller must first resolve identifiers to refs with a logged vault search, because no PII may enter a job (invariant 7a, FA-14). T-0404 wires this.
- The vault trusts the `workspace_id` a caller sends. Web and worker enforce tenancy themselves, as for db-main.

## Unsure

- A flood-test failure seen on S4's machine (`auth.int.test.ts:1040`) did not reproduce here under heavy CPU load. If it recurs, the assertion now names the status.
- Ingest is not idempotent per subject: a retried ingest makes a second record. M10's callers should key by order (follow-up).
- The vault decrypts with the workspace's current data key and does not use the stored `data_key_version`. That matters only once PII key rotation exists (follow-up).

## Test evidence

- `scripts/verify.sh --quick` passed for each PR. The static steps squawk, depcruise, coverage, names, limits and openapi passed.
- **Integration, T-0401:** packages/db 83 passed; web and worker (auth, people, jobs, isolation, audit, files, auth-mail, scan) 58 passed.
- **Integration, T-0402:** pii-vault 12 passed; pii-db and worker `pii-boundary` (AT-9) passed.
- **Integration, T-0403:**
  - vault `deletion.int.test.ts`: 8 passed
  - worker `deletion.int.test.ts`: 9 passed (all seven triggers, day 24 vs 25, tombstones in three places, marker scan)
  - db `deletion.int.test.ts`: 3 passed
  - web `deletion-certificate.int.test.ts`: 2 passed
- Full integration suite on the T-0403 branch: see the PR.
- Extra command for S4: `pnpm vitest run --project integration apps/pii-vault apps/worker/src/deletion.int.test.ts apps/worker/src/pii-boundary.int.test.ts packages/db/src/deletion.int.test.ts`.
