# M01 halfway checkpoint report (T-0101 to T-0103)

From S3, 18 Oct 2026. For S4. Branches and PRs are merged into `main` at `fc47bdb`.

## Tasks done

| Task | Title | PR | Branch | Status |
|---|---|---|---|---|
| T-0101 | Walking skeleton (local Docker only) | #1, #2 (S1 rulings) | `task/T-0101-walking-skeleton`, `task/T-0101-s1-rulings` | done |
| T-0102 | Shared API contract pipeline | #3 | `task/T-0102-contract-pipeline` | done |
| T-0103 | Envelope encryption and secrets handling (HIGH risk) | #5 | `task/T-0103-envelope-crypto` | done |

## How each was built

**T-0101.** This is a pnpm 12.14.0 monorepo in the ARCHITECTURE.md §3 layout; stub packages export one thing and have one test.

- `infra/compose/compose.yaml` and `compose.dev.yaml` run web, worker, pii-vault, site, db-main and db-pii (PostgreSQL 18.6 pinned by digest), migrate jobs, caddy, mailpit and provider-mocks, plus clamd under the `scan` profile.
- Every service has mem_limit, cpus, pids_limit and a healthcheck (`scripts/check-limits.sh`).
- Networks are `ob_edge`, `ob_app`, `ob_db` (internal, ADR-034), `ob_pii` (internal) and `scan_ob` (internal).
- The role init scripts create `ob_owner`, `ob_app` and `ob_platform` (no BYPASSRLS) and `vault_owner` and `vault_app`. Migrations are forward-only with the Kysely Migrator and are linted with squawk.
- `packages/logger` is pino with a field allowlist and PII-marker scrubbing.
- `scripts/verify.sh` is the single gate: install, lint, typecheck, openapi drift, depcruise, names, req-coverage, limits, squawk, actionlint, caddy, unit, integration, contract, build, stack, e2e, gitleaks and audit. CI runs it with SHA-pinned Actions, plus Semgrep CE.

**T-0102.**

- `packages/contract` has a `defineRoute` registry on Zod 4. Each route must declare auth, tab, adminOnly and companyScoped; apps/web refuses to start without them, and any unregistered route is refused.
- Errors use RFC 9457 problem+json. List queries default to 50 and cap at 200.
- `openapi.json` and the openapi-fetch client are committed, and the gate fails on drift.
- `packages/core` gets London time helpers on Intl (no date-fns, ADR-035), the `Pence` stub, `cacheKey`/`companySetHash` (NFR-6) and `ApiError`.
- The testkit route walker is a stub until T-0201.

**T-0103.**

- `packages/crypto` uses only `node:crypto`: AES-256-GCM with a random 12-byte nonce. Each ciphertext is `[0x01][key version u32][nonce][ct][tag]`.
  - The 5-byte header is authenticated together with a length-prefixed AAD of purpose, workspace_id, table, column and row id.
  - Per-workspace DEKs are wrapped by a KEK keyring: one `<version>:<base64 32 bytes>` line per version, the last one active. The wrap AAD binds purpose, workspace and DEK version.
  - KEK rotation (`rewrapDataKey`) re-wraps DEKs only.
  - `Secret` prints `[REDACTED]` through String, JSON and inspect.
- There are two KEKs. `secrets_kek` is mounted only into web and worker, and `pii_kek` only into pii-vault. Both are read through `readSecretFile` (env values are refused) and loaded at boot.
- Migration 0002 adds `app.data_keys` and `app.credentials`.
  - Both tables have forced RLS on `app.workspace_id`, and a composite FK links credentials to their data key.
  - `ob_app` cannot DELETE data keys and may UPDATE only the re-wrap columns.
  - There is a partial unique index for one active row per (workspace, kind, account, slot).
- `CredentialRepository` (packages/db) covers store, get, promoteNext (AMZ-10), replaceCurrent with retention (AMZ-8), purgeExpired (hard DELETE) and rewrapDataKeys. It logs ids, kinds, slots and counts only.
- Dev secrets: `infra/secrets/dev.sops.yaml` holds 9 synthetic values encrypted to a committed DEV ONLY age key.
  - `scripts/dev-secrets.sh` decrypts them with the digest-pinned SOPS 3.13.3 image (PS-007) and writes `infra/compose/.secrets/`.
  - It stops when a local file differs, and `--reset` overwrites after `down -v`.
- A new gitleaks rule catches raw KEK lines; the allowlist covers only `infra/secrets/dev.age.key`.
- `docs/ops/secrets-register.md` lists every secret.
- Review: `/code-review` at high effort (CodeRabbit CLI not installed) found 7 issues, all fixed in `633ad83`.

## Risks

1. **The committed dev age key** is intended (brief, PS-007), so anyone with the repo can decrypt `dev.sops.yaml`. The values are synthetic and the dev databases are not published outside Docker networks. The production key must never come near this repo (M22).
2. **Tenancy scaffolding ahead of T-0201.** The `workspace_id` columns in `app.data_keys`/`app.credentials` have no FK yet, because there is no workspace table. `TenantContext` is a minimal `{ workspaceId }`. The tenant transaction wrapper exists only as a test helper (`asTenant`).
3. **KEK rotation is per workspace only.** An all-workspace job needs the workspace list (T-0201) and the queue (T-0104). Until then, a rotation would need a manual loop.
4. **Key material in memory.** Keyrings and DEKs live in process memory for the process lifetime; Node gives no reliable zeroisation.
5. **Squawk mode.** The gate now runs squawk with `--assume-in-transaction`, which matches the runner (one transaction per file). Without it, squawk flagged every CREATE INDEX on the new tables.
6. **Local resources.** WSL 2 has 3.8 GiB, so the full stack with clamd is tight on this host (STATE prerequisites).

## Unsure of

- Whether `app.credentials` should also hold platform-level app secrets. Hashir and S1 ruled no: an M05 platform table on the same crypto.
- The `expires_at` column has two meanings: provider expiry on an active row, and deletion time on an inactive (retired) row. It is documented in the migration and repository, but S4 may prefer a separate `delete_after`.
- `CredentialRef.kind` is checked only by a DB pattern (`^[a-z][a-z0-9_.]{1,63}$`), not by a closed enum. Provider modules will fix the list.
- The web container loads `secrets_kek` at boot but does not use it until the OAuth returns in M07.

## Test evidence

Full gate on the T-0103 head (`633ad83`, the same tree as merge `fc47bdb`): `scripts/verify.sh` passed in 412 s. CI on `main` after merge: success.

| Step | Result |
|---|---|
| unit | 36 files, 117 tests passed |
| integration (Testcontainers PG 18.6) | 4 files, 16 tests passed |
| contract | 1 file, 2 tests passed |
| e2e (Playwright) | 2 passed |
| req-coverage | 324 IDs indexed, 324 owned, 0 unmapped, 0 prd_ids outside their module; 20 IDs cited in 42 test files |
| gitleaks (git history + working tree) | no leaks found |
| limits, squawk, actionlint, caddy, depcruise, names, openapi, audit | ok |

T-0103 acceptance tests:

- `packages/crypto/src/envelope.test.ts`: `[SEC-6] encrypt/decrypt round trip`, `[SEC-6] tampered ciphertext or wrong AAD fails`, `[SEC-6] KEK rotation re-wraps DEKs and old data still decrypts`
- `packages/db/src/credentials.int.test.ts`: `[INT-3] credential repository never logs plaintext`. Mutation check: making `Secret.toString` return the value makes this test fail.
- `tests/config/secrets.test.ts`: `[SEC-5] containers receive secrets only as /run/secrets files`

**Extra commands for S4:**

```bash
bash scripts/dev-secrets.sh
corepack pnpm exec vitest run --project unit packages/crypto tests/config
corepack pnpm exec vitest run --project integration packages/db
```

On a machine with volumes from before T-0103, run `docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml down -v` and then `bash scripts/dev-secrets.sh --reset` first. On Windows, set `COREPACK_HOME` to a folder on the repo's drive.
