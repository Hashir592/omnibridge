# M01 halfway findings — round 1
Reviewed: T-0101, T-0102, T-0103 (PRs #1, #2, #3, #5), code at `fc47bdb`, run on `main` at `3599b83` (adds only PR #7 UI mock-ups and PR #8 docs). verify.sh: FAIL (flaky: run 1 from a clean state failed at `unit` on a 5 s test timeout; run 2 passed every step in 509 s)
Acceptance re-run: 14/18 PASS

From S4, 19 Oct 2026. Reviewer: S4 by hand, plus `/code-review` at high effort on PR #5 (ADR-030); I kept only findings I reproduced or confirmed in code.

## How I ran it

- Clean state: `docker compose … down -v`, `bash scripts/dev-secrets.sh --reset`, `COREPACK_HOME=D:\.corepack`. Docker has 3.77 GiB and 4 CPUs.
- `scripts/verify.sh` (full), twice, sampling `docker stats` every 15 s:
  - **Run 1: rc=1 after 125 s.** `unit` FAILED: `[SEC-5] containers receive secrets only as /run/secrets files 9836ms — Test timed out in 5000ms` (`tests/config/secrets.test.ts:21`). Every step before it passed.
  - **Run 2: rc=0, 509 s.** install, lint, typecheck, openapi, depcruise, names, coverage, limits, squawk, actionlint, caddy, unit (14 s), integration (45 s), contract, build, stack (221 s), e2e (83 s), gitleaks (18 s) and audit were all ok.
  - Memory: the stack peaked at about 1.35 GiB in total (clamd 868 MiB, db-main 57 MiB, web 43 MiB). No OOM and no container near its limit, so memory was **not** the cause of run 1.
- S3's extra commands: `dev-secrets.sh` rc=0; unit `packages/crypto tests/config` 43/43; integration `packages/db` 11/11.
- Probes (in the scratchpad, never committed): catalog and role queries on db-main; rolled-back `ob_app` and `ob_owner` transactions; a gitleaks run on synthetic key-line variants; scans of the runtime images and the container logs; and a temporary one-line schema edit for the openapi drift check, reverted at once (`git status` clean).

## Acceptance re-run

| Task | Item | Result | Evidence |
|---|---|---|---|
| T-0101 | verify.sh exits 0 on a clean clone | **FAIL** | Run 1 rc=1 (SEC-5 timeout), run 2 rc=0. Flaky, so not reliably 0 (F-01). Note: run in the existing checkout after `down -v`, not a fresh clone. |
| T-0101 | `compose up -d --wait` reports every service healthy | PASS | rc=0 in 71 s; caddy, db-main, db-pii, mailpit, pii-vault, provider-mocks, site, web and worker all healthy |
| T-0101 | `curl -fsS https://localhost:8443/healthz` | PASS | `{"status":"ok","db_main":"ok","db_pii":"ok","version":"0.0.0-dev"}` |
| T-0101 | check-limits fails on an unlimited service | PASS | `[OPS-10] check-limits rejects unlimited service` ✓ (fixture → rc 1 with all four messages) |
| T-0101 | `[DP-8] logger redacts PII markers` | PASS | unit run 2 (135/135) |
| T-0101 | req-coverage 324/324/0/0 | PASS | `324 IDs indexed, 324 owned, 0 unmapped, 0 prd_ids outside their module` |
| T-0101 | actionlint, every `uses:` pinned to 40-char SHA | PASS | actionlint ok; all 6 `uses:` lines are SHA-pinned, none unpinned |
| T-0102 | verify.sh exits 0 | **FAIL** | same gate as above (F-01) |
| T-0102 | `[SEC-3] server refuses route without permission metadata` | PASS | unit run 2 |
| T-0102 | `[CAP-7] list routes default to 50 rows and cap at 200` | PASS | unit run 2; `pagination.ts` caps at 200 |
| T-0102 | `[NFR-7] londonDate … BST boundaries` | PASS | unit run 2; my spot checks: `2026-10-24T23:30Z → 2026-10-25`, `2026-06-30T23:00Z → 2026-07-01`, `2026-03-29T00:30Z → 2026-03-29` |
| T-0102 | `[NFR-6] cache key includes workspace and company set` | PASS | unit run 2 |
| T-0102 | changing a schema without regenerating fails the gate | PASS | edited `routes/health.ts` enum → `pnpm contract:check` rc=1, naming `openapi.json` and `client/schema.ts`; rc=0 after revert |
| T-0103 | verify.sh exits 0 | **FAIL** | same gate as above (F-01) |
| T-0103 | the three `[SEC-6]` envelope tests | PASS | `envelope.test.ts`, 43/43 in the extra command |
| T-0103 | `[INT-3] credential repository never logs plaintext` | PASS | integration `packages/db` 11/11 |
| T-0103 | `[SEC-5] containers receive secrets only as /run/secrets files` | **FAIL** | timed out at 9.8 s in gate run 1; passes alone in 1.7 s (F-01) |
| T-0103 | gitleaks finds no secret in the history | PASS | gate gitleaks step ok (git history + dir), on the main checkout rather than a worktree. But see F-02: the custom rule misses most shapes. |

## Checked, no finding

- **Nonce:** `randomBytes(12)` for each seal (`envelope.ts:66`), GCM tag fixed at 16 bytes on both sides. The low message counts per DEK are far below the 2³² random-nonce limit.
- **Header and AAD:** the 5-byte header is part of the AAD (`envelope.ts:68,82`). The AAD is length-prefixed, with a domain label (`omnibridge/field/v1`, `omnibridge/dek/v1`). Field AAD binds purpose, workspace, table, column and row. Wrap AAD binds purpose, workspace and DEK version, and the KEK version via the header. Tests flip bits in each region.
- **Keyring:** strict line regex, exactly 32-byte keys, versions strictly increasing, last line active. Errors give line numbers only. Values set directly in the environment are refused (`env.ts:24`). Keyrings are loaded at boot in web, worker and pii-vault.
- **RLS:** `relrowsecurity = relforcerowsecurity = t` on `app.data_keys` and `app.credentials`; one ALL policy each, with USING = WITH CHECK on `app.workspace_id`. With no context, `ob_app` and even the owner `ob_owner` see 0 rows. A malformed `app.workspace_id` raises an error, so it fails closed. A cross-workspace INSERT is rejected by RLS.
- **Grants:** `ob_app` has SELECT/INSERT/UPDATE/DELETE on credentials, and on data_keys only SELECT, INSERT and column UPDATE on (kek_version, wrapped_key, rewrapped_at). DELETE, a full UPDATE and TRUNCATE are denied. `ob_app` and `ob_platform` are NOSUPERUSER, NOBYPASSRLS, NOINHERIT, with no CREATE on `app` or `public`. `log_statement = none`.
- **Secrets at runtime:** web and worker get `ob_app_password` and `secrets_kek`; pii-vault gets `pii_kek` and `vault_app_password`; other containers get none. No secret value appears in the 61 lines of stack logs (I grepped for every `.secrets/` value). The runtime images (web, worker, pii-vault) contain no age key, SOPS file, KEK line or secret env, and `docker history` is clean.
- **Committed DEV ONLY key:** marked on line 1 and unlocks only `dev.sops.yaml`. All 9 entries are `ENC[AES256_GCM…]`. The gitleaks allowlist path is anchored to that exact file.
- **Limits and networks:** they match the ARCHITECTURE §7 "today" column. `ob_db`, `ob_pii` and `scan_ob` are internal; host ports bind to 127.0.0.1 only.
- **Contract:** the `onRoute` guard refuses non-contract routes; 5xx details are hidden from clients.
- **Not in this checkpoint's scope:** the `rls-coverage` SQL test (invariant 1) does not exist yet. It is in T-0201's scope, and T-0201 must cover these two tables.

## F-M01-halfway-01 — Blocker — The config tests time out in the gate, so verify.sh is not reliably green
Area: 8 Requirement coverage / gate reliability  IDs: SEC-5, OPS-10, SEC-16
Evidence: In gate run 1 from a clean state: `× [SEC-5] containers receive secrets only as /run/secrets files 9836ms`, `Error: Test timed out in 5000ms` (`tests/config/secrets.test.ts:21`), `--- unit FAILED`, rc=1. Separately, `tests/config/compose.test.ts` `[OPS-10] service limits match the "today" budget…` timed out at 5122 ms on its first run, and took 2299 ms warm. Cause: `composeModel()` (`tests/config/helpers.ts:40-58`) runs `scripts/dev-secrets.sh` (a `docker run` of the SOPS image) and then `docker compose config` inside whichever unit test calls it first, under Vitest's default 5 s timeout. Its `spawnSync` result is ignored (`stdio: 'ignore'`, no status check), so a failed decryption is also hidden. S2 reported the same timeout in PS-010 (5). It fails an acceptance item (verify.sh exits 0), which makes it a Blocker under the S4 rules.
Required fix:
1. Build the compose model once, outside any test's timeout. Use a `beforeAll` with an explicit timeout (for example 60 s), or a Vitest `globalSetup` that runs `dev-secrets.sh` and `docker compose config` and writes the JSON for the tests to read.
2. Check the `dev-secrets.sh` exit status and throw on failure.
3. Do not weaken or skip any assertion.
4. Prove it with three consecutive full `verify.sh` runs from a clean state (after `down -v` and `dev-secrets.sh --reset`), all rc=0.
Resolution: FIXED in `44a9919` and `b1c55a3` (branch `task/M01-halfway-fixes`).
- The compose model is now built by `loadComposeModel()` in each file's `beforeAll` with `DOCKER_SETUP_TIMEOUT_MS` (120 s). The two `check-limits.sh` runs in compose.test.ts also moved into `beforeAll`. No test body calls Docker, and no assertion changed.
- `loadComposeModel()` now checks the `dev-secrets.sh` exit status and throws with its stderr. `composeModel()` throws if it is called before the model is loaded.
- **The first three-run attempt found a second gate defect.** Run 1 failed at `e2e`, not `unit`, because Playwright (`reuseExistingServer: !CI`) had reused S2's Vite dev server from the `omnibridge-ui` worktree on port 5173. That server holds uncommitted T-0302 code (`bg-[#d9dee5]`), so the gate tested code that is not in this checkout. Fix `b1c55a3`: verify.sh runs Playwright with `OB_UI_PORT=5199 OB_E2E_OWN_SERVER=1`, and `--strictPort` makes a taken port fail instead of being reused. A config test pins this: `[SEC-16] the gate e2e step starts its own UI server and never reuses another one`.
- Evidence (three consecutive full runs on `b1c55a3`, each after `down -v` and `dev-secrets.sh --reset`, with S2's server still listening on 5173): run 1 rc=0 in 678 s, run 2 rc=0 in 451 s, run 3 rc=0 in 461 s (19:10Z to 19:25Z on 19 Oct 2026). Each run: unit 40 files and 138 tests, integration 4 files and 19 tests, contract 2, e2e 16 (chromium + ui), gitleaks no leaks, req-coverage 324/324/0/0.

## F-M01-halfway-02 — Major — The gitleaks KEK rule misses a key in an env, YAML, JSON or code line
Area: 4 Security  IDs: SEC-5, SEC-6 (invariant 22)
Evidence: `.gitleaks.toml:10` is anchored as `(?m)^\s*[1-9][0-9]{0,8}:[A-Za-z0-9+/]{43}=\s*$`. I ran gitleaks 8.30.1 (the pinned image, the repo config) over synthetic random keys. Bare and indented lines were flagged. `SECRETS_KEK=1:<b64>` (.env), `secrets_kek: "1:<b64>"` (yaml), `{"kek":"1:<b64>"}` (json) and `const KEK = '1:<b64>';` (ts) produced **no finding**, and neither did a bare base64 key; the default rules do not catch these either. Those are the shapes in which a key is most likely to be pasted. The SEC-5 config test guards only compose `environment`.
Required fix:
1. Match the key wherever it appears, for example `(?:^|[^A-Za-z0-9+/])[1-9][0-9]{0,8}:[A-Za-z0-9+/]{43}=(?:[^A-Za-z0-9+/=]|$)`. Optionally add `keywords` or an allowlist for known false positives.
2. Add a gate test that writes the variants above, using random keys generated at run time and never committed, to a temp directory, runs `scripts/gitleaks.sh`-style `dir` scans on it, and expects every one to be flagged.
3. Prove that `gitleaks git` and `dir` on the repo stay clean.
Resolution: FIXED in `44a9919`.
- The rule is now `(?m)(?:^|[^A-Za-z0-9+/])[1-9][0-9]{0,8}:[A-Za-z0-9+/]{43}=(?:[^A-Za-z0-9+/=]|$)`.
- New gate test `tests/config/gitleaks.test.ts`, `[SEC-6] flags a KEK line in bare, env, YAML, JSON and code files`. It writes 7 variants (bare, indented YAML, quoted YAML, .env, JSON, TypeScript, a two-version keyring) using keys generated at run time and never committed. It scans them with the pinned gitleaks image and the repo config, and expects every variant flagged and a near-miss file not flagged. Against the old rule the test fails (`quoted.yaml` not flagged); against the new one it passes.
- `scripts/gitleaks.sh full` (git history + dir) reports no leaks.
- Not covered: a bare 32-byte base64 key with no `<version>:` prefix. That shape is the same as any base64 SHA-256 digest, so a rule for it would flag ordinary hashes. The keyring format always carries the prefix.

## F-M01-halfway-03 — Minor — The KEK rotation runbook's "check no old kek_version is left" cannot run under FORCE RLS
Area: 1 Correctness / 9 Invariants  IDs: SEC-6
Evidence: `docs/ops/secrets-register.md`, "Rotate a master key", step 3. I probed this: with no `app.workspace_id`, `SELECT count(*) FROM app.data_keys WHERE kek_version=1` returns 0 for `ob_owner` too, even with a v1 row present in the same transaction, because FORCE applies to the owner. Only a superuser or a BYPASSRLS role can see across workspaces. An operator who trusts that 0 and removes the old line makes every credential in a missed workspace undecryptable (`no KEK version 1`), which is data loss.
Required fix:
1. Give step 3 its exact query and the role that runs it, for example the db-main superuser over a one-off `psql` with no app role.
2. Add a note that it must return 0 before the old line is removed.
3. Note in T-0201/T-0104 (the all-workspace re-wrap job) that the job reports the remaining count across all workspaces and refuses to call rotation done otherwise.
Resolution: FIXED in `44a9919`. `docs/ops/secrets-register.md` → "Rotate a master key", step 3, now says:
- FORCE RLS hides rows from every app role, `ob_owner` included.
- The exact superuser query to run, as `postgres` through `docker compose exec db-main psql`.
- That it must return no rows before the old line is removed, and why (data loss).
- A new step 4 removes the old line.
- Follow-up for T-0201/T-0104: the all-workspace re-wrap job must report the remaining count across all workspaces and refuse to call the rotation done unless it is 0. This is noted in STATE.md follow-ups.

## F-M01-halfway-04 — Minor — `credentials.expires_at` has two meanings; split out `delete_after` now
Area: 1 Correctness / 7 Migration safety  IDs: SEC-6, INT-3 (AMZ-8)
Evidence: This is S3's open question. `credentials.ts:250` (`#retireCurrent`) overwrites `expires_at` with `now + retainOldForMs`, so a retired row loses its provider expiry. `purgeExpired` (`:147`) deletes on `NOT is_active AND expires_at <= now`. Any future path that sets `is_active = false` without rewriting `expires_at` (for example an M07 revocation) would therefore purge at the provider expiry: at once if that date is past, which breaks AMZ-8's 7-day retention, or months late. The CHECK `credentials_inactive_expire` cannot tell the two meanings apart.
Judgement: split it. Add `delete_after timestamptz` (required when `is_active` is false, by CHECK), and keep `expires_at` for the provider expiry only. The table holds no data yet, so this is a cheap expand migration (0003) now; after M07 it needs a backfill.
Required fix: Migration 0003 adds `delete_after` with that CHECK and moves the purge index onto it. The repository retires by setting `delete_after`, and purges on `delete_after`. The integration tests prove the AMZ-8 7-day retention and that the provider `expires_at` survives retirement.
Resolution: DEFERRED to M07, before any credential is stored, under proposal **PS-012** in DECISIONS.md.
- The split needs migration 0003 to drop `credentials_inactive_expire`; otherwise a retired refresh token with no provider expiry violates it. squawk's `ban-drop-constraint` flags every DROP CONSTRAINT.
- CLAUDE.md forbids disabling a lint rule to get green, and S4 area 7 requires a clean squawk. So the fix needs S1 to rule on a reviewed `-- squawk-ignore` for the contract step of an expand/contract pair.
- I drafted 0003 (add `delete_after`, a NOT VALID CHECK, drop the old CHECK, move the purge index) and reverted it when squawk flagged 4 issues.
- `app.credentials` stays empty until M07, so the split stays a no-backfill change until then. The code now marks the dual meaning at `#retireCurrent`.

## F-M01-halfway-05 — Minor — Credential `kind` is a free string; a typo silently reads or writes another slot
Area: 1 Correctness  IDs: INT-3
Evidence: This is S3's other open question. The DB checks only `kind ~ '^[a-z][a-z0-9_.]{1,63}$'` (`0002_credentials.sql:37`), and `CredentialRef.kind` is `string` (`credentials.ts:20`). `get(…, { kind: 'amazon.refresh_tokn' })` returns `undefined`, which looks like a disconnected account. A mistyped `store` creates a credential that no reader finds.
Judgement: the DB pattern is fine for now; an enum in SQL would need a migration per provider. But code should not pass free strings.
Required fix: Add a closed TypeScript union or registry of credential kinds in `packages/db` (or `core`), seeded from the secrets register's rows: `amazon.refresh_token`, `ads.refresh_token`, `ebay.refresh_token`, `evri.api_key`, `dpd.api_key`. Type `CredentialRef.kind` as that union. Provider modules extend the list. This can wait until M07 if S1 prefers; then log it as a follow-up.
Resolution: FIXED in `44a9919`.
- `CREDENTIAL_KINDS` / `CredentialKind` (exported from `@omnibridge/db`) lists the five kinds in the secrets register, and `CredentialRef.kind` is that union.
- `#lock` also refuses an unknown kind at runtime, for callers that bypass the type.
- Test: `[INT-3] unknown credential kinds are refused, not silently stored` (store and replaceCurrent).

## F-M01-halfway-06 — Minor — The rewrap job aborts if a DEK is wrapped under a newer KEK than the process holds
Area: 1 Correctness  IDs: SEC-6
Evidence: `credentials.ts:171` selects `kek_version <> activeVersion`, which includes versions newer than this process's keyring, and `openWrapped` then throws `no KEK version N`, rolling back the whole workspace's re-wrap. The scenario is rotation step 1 mid-rollout: web on [v1, v2] creates a DEK under v2 while a worker on [v1] runs the re-wrap.
Required fix: Select `kek_version < activeVersion` only, and log (count only) any newer ones. Add an integration test with keyrings [v1] and [v1, v2] working on one workspace.
Resolution: FIXED in `44a9919`.
- `rewrapDataKeys` now selects `kek_version < active` only.
- Data keys under a newer KEK are counted and logged as `data_keys.newer_kek` (count only), and left alone.
- Test: `[SEC-6] re-wrap leaves DEKs under a newer KEK alone during a rollout`. Workspace F has a v2 key and is re-wrapped by a [v1] repository: 0 re-wrapped, F stays on v2 and still decrypts. Workspace G (v1) is re-wrapped by a [v1, v2] repository as normal.

## F-M01-halfway-07 — Minor — `replaceCurrent` lets a concurrent unique violation through as a raw pg error
Area: 1 Correctness  IDs: INT-3 (AMZ-8)
Evidence: `credentials.ts:142-143` retires, then inserts, but has no `isUniqueViolation` translation, unlike `store()` (`:69`). Two OAuth returns racing for one account give `duplicate key value violates unique constraint "credentials_one_active"`, which becomes an unhandled 500 at M07.
Required fix: Translate 23505 the same way as `store()`, or serialise per ref with `pg_advisory_xact_lock(hashtext(workspace‖kind‖account))`. Add an integration test with two concurrent `replaceCurrent` calls.
Resolution: FIXED in `44a9919`.
- I chose the advisory-lock option: `#lock` runs `pg_advisory_xact_lock(hashtextextended('app.credentials|ws|kind|account', 0))` at the start of `store`, `promoteNext` and `replaceCurrent`. Writers of one credential therefore run one after the other, and a second re-authorisation retires the first one's token (AMZ-8) instead of failing.
- `store` keeps its 23505 translation as defence in depth.
- Test: `[SEC-6] concurrent re-authorisations of one account both succeed, one after the other`. Two `replaceCurrent` calls run concurrently: both fulfil, leaving 1 active row and 2 retained.

## F-M01-halfway-08 — Minor — `.dockerignore` lets `infra/secrets/` into the image build stage
Area: 4 Security  IDs: SEC-5
Evidence: `.dockerignore` excludes `infra/compose/.secrets` but not `infra/secrets`. `infra/docker/node-app.Dockerfile:18` runs `COPY . .` in the build stage, so `dev.age.key` and `dev.sops.yaml` sit in a build-stage layer. The runtime images are clean today: I scanned web, worker and pii-vault and found nothing. But a build-cache export (for example `--cache-to type=registry,mode=max` in the M22 GHCR pipeline) or a remote builder would carry the dev key.
Required fix: Add `infra/secrets` (and `infra/secrets/**`) to `.dockerignore`, and add a config test that asserts both secrets paths are excluded.
Resolution: FIXED in `44a9919`.
- `.dockerignore` now excludes `infra/secrets` and `infra/secrets/**`.
- Test: `[SEC-5] secret files and the dev age key never enter a Docker build context` checks `infra/compose/.secrets`, `infra/secrets` and `infra/secrets/**`.

## Follow-ups (not findings)

- T-0201: the `rls-coverage` test must include `app.data_keys` and `app.credentials` (both pass by hand today).
- The `/code-review` pass also raised the ignored `dev-secrets.sh` exit status in `composeModel`, which is folded into F-01.
