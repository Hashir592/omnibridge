# M02 halfway checkpoint report (T-0201 to T-0203)

From S3, 27 Oct 2026. For S4. Every PR is merged into `main`; this report is against `7974c13`.

## Tasks done

| Task | Title | PR | Branch | Status |
|---|---|---|---|---|
| T-0201 | Tenancy core and isolation harness (HIGH) | #24 | `task/T-0201-tenancy-core` | done |
| T-0202 | Append-only audit log (HIGH) | #25, #30 (ADR-049 additions) | `task/T-0202-audit-log`, `task/T-0202-adr049-additions` | done |
| T-0203 | Passwords, MFA, lockout and sessions (HIGH) | #31 | `task/T-0203-auth` | done |
| (fix) | NFR-8 table frame budget after the T-0203 merge | #32 | `fix/ui-table-frame-work` | done |

## How each was built

**T-0201.**
- Migrations 0007–0009 add workspaces, companies, channel accounts, users and memberships, all with forced RLS and composite `(workspace_id, id)` FKs.
  - `app.company_ids` is always an explicit list, filled by `app.workspace_company_ids()` (SECURITY DEFINER). There is no wildcard.
  - The users policy calls `app.is_co_member()` (SECURITY DEFINER), so it never recurses into the memberships policy.
  - Triggers: TEN-2 first-company defaults, the TEN-3 company lock, and TEN-10 limits counted under a workspace row lock.
  - The five M01 tables get workspace FKs added NOT VALID, then VALIDATE.
- `Tenancy` runs one transaction per request and per job (invariant 2) and hands out a `TenantContext` bound to it. A context used after its transaction ends throws.
  - Job bookkeeping keeps its own pool and short transactions (PS-017).
  - Worker handler connections have `statement_timeout` 60 s and `idle_in_transaction_session_timeout` 180 s.
- Web authenticates each route kind in `onRequest`, before validation. `service` and `signed-webhook` routes fail closed.
- The testkit route walker (TEN-1, AT-1) calls every registered route as workspace A with workspace B's ids, in the path, query and body.
- `rewrap-keys` is a one-off ops container and the only holder of `ob_platform` in web.
- New dependency-cruiser rule `db-access-only-in-packages-db`. The cruiser used to drop npm modules from its graph; it now keeps them, so the rule can see an npm import.

**T-0202.**
- Migration 0010 adds `app.audit_events`. An append-only trigger refuses UPDATE, DELETE and TRUNCATE for every role.
  - The only exception is the retention purge: a DELETE as ob_owner, with the purge flag set, of rows older than 6 years.
- The purge is `app.purge_audit_events()`: SECURITY DEFINER, `search_path` pinned, no arguments, cut-off computed inside, current workspace only, returns the count.
- ADR-049 (PR #30):
  - A new `ob_worker` role (member of ob_app, no BYPASSRLS) is the only role with EXECUTE on the purge. The worker connects as ob_worker.
  - `@omnibridge/db/platform` is a subpath export. Depcruise rule `ob-platform-only-in-fanout` limits it to `apps/worker/src/platform-jobs.ts` and `apps/web/src/rewrap-keys.ts`.
- `AUDIT_EVENTS` (core) is the event catalogue. `auditDiff` rejects any value carrying the PII marker.
- `AuditLog.list` pages on a keyset cursor `{at, id}`, the event's own time and id, so it leaks nothing about other workspaces.
- The CSV export reads 1,000-row pages and is capped at 100,000 rows or 16 MiB. Over the cap it answers 400 `validation_failed`.
  - Every export writes its own `audit_log.exported` event.
  - Cells are formula-safe.
- The audit routes are adminOnly (AUD-4).
- Retention runs as `auditRetentionSweepJob` (PLATFORM_JOBS, cron 02:30 London), which fans out one `auditRetentionJob` per workspace.

**T-0203.** Built to ADR-048, with the ADR-050 changes.
- Migration 0011 adds the user-level tables:
  - `user_auth`, `password_history`, `recovery_codes`, `sessions`, `login_counters`, `ip_counters`, `password_resets`, `platform_keys`
  - RLS is forced, ob_app holds no grant, and every access is one narrow SECURITY DEFINER function. Expiries use the app clock, passed in.
- **Passwords (USR-3):**
  - argon2id (@node-rs/argon2 2.2.2) at 19 MiB, t=2, p=1.
  - `HashGate` allows 4 hashes at once per web process, the dummy hash included. Up to 32 wait in a queue; beyond that, 429.
  - Rules: at least 12 characters; not the name or email local part; not on the committed list of 358 entries (case-insensitive, trailing digits and "!" stripped); not one of the last 10; minimum age 1 day.
  - A password older than 365 days gets `next: password_change`.
- **MFA (USR-4):**
  - TOTP via @oslojs/otp 1.1.0, ±1 step, a step never reused.
  - The secret is sealed with a platform data key, which `rewrap-keys` re-wraps.
  - The QR matrix comes from qrcode 1.5.4, server side.
  - 10 recovery codes of 80 bits, stored as HMAC-SHA256 under `auth_hmac_key`.
- **Lockout (USR-5):**
  - Counters are keyed by an HMAC of the normalised email, so real and unknown emails get the same answers and no plaintext is stored.
  - 10 failures in 15 minutes lock for 15 minutes (429 with Retry-After).
  - Each IP waits from 1 s, doubling to 30 s, after 3 failures.
  - A correct answer is still refused if a lock started while it ran.
  - The lock notice is an `auth.lock_notice` worker mail job; web never sends SMTP.
- **Sessions (USR-6, SEC-1):**
  - 256-bit token, stored as SHA-256, in the `ob_session` cookie (HttpOnly, Secure, SameSite=Strict). The token is replaced at every stage.
  - The pre-MFA stage lasts 10 minutes. After it: idle 30 minutes, absolute 12 hours.
  - Every non-GET route gets an Origin check plus a session-bound double-submit CSRF token.
- **Reset (USR-7):**
  - The worker makes the 30-minute single-use link just before mailing it, so only its hash is stored.
  - A reset revokes every session, and MFA is still required.
- **Contract:**
  - New auth kinds `pre-mfa` and `signed-in`, with 15 auth routes.
  - The workspace picker (USR-2) and `POST /auth/platform` for operators.
- **Dev seed:**
  - A one-off DEV ONLY `seed` service loads the launch data and the demo sign-in.
  - It refuses unless OB_ENV is dev or test.
- **#32:** after #31 merged, main's CI failed the NFR-8 table frame budget twice (p95 17.15 and 16.20 ms against 16). The virtualiser moved into a memoised body component, and each row gets CSS containment. The test and the budget are unchanged.

## Risks

1. **SECURITY DEFINER surface.** T-0203 adds 26 definer functions owned by ob_owner. Each has `search_path` pinned and its own FORCE RLS policy `TO ob_owner`, but each one is a privileged entry point. Please read them as one set in `0011_auth.sql`.
2. **Connection caps.** The role caps (ob_app 30, ob_worker 20, ob_platform 4) add up to more than `max_connections` 40. Real peak use is about 31 (web 10 plus 2 queue, worker 18, fan-out 1). Deferred to pool sizing in T-0207 or M22.
3. **USR-8 not yet enforced.** A workspace session does not re-check membership, so a removed member keeps access until the session ends (at most 12 hours). Planned in T-0204: revoke on removal, and check membership in `resolveSession`.
4. **Timing gap.** A failed sign-in for a real account also writes audit rows, a few milliseconds that an unknown email skips. argon2 equalises the main cost. Left for S5 (T-0206).
5. **Dev defaults in compose.** `SMTP_ALLOW_PLAIN` defaults to 1 (Mailpit), and `APP_ORIGINS` and `TRUSTED_PROXIES` have dev values. Production must set them (M22).
6. **CI headroom on the NFR-8 test.** Before #32 the shared runner sat at the 16 ms budget. After #32, main's CI measured 13.17 ms; locally it is about 8–12 ms.
7. **Local resources.** WSL 2 has 3.8 GiB. Under load, single local runs flaked on things these tasks don't touch:
   - the clamd `scan.int` test
   - `/healthz` 503: web's 2 s timeout on the pii-vault health call (R2-01, T-0207)

## Unsure of

- **Audit fan-out:** auth events are written into every workspace the user belongs to. That is ADR-048's reading of "per workspace audit", but an operator with no workspace leaves no audit row. M05 adds platform audit.
- **Lock-notice skip:** a user with no workspace gets no lock notice, because every job needs a workspace (invariant 12). It is logged and skipped; M05 adds in-app alerts.
- **Common-password list:** hand-written, 358 entries (Hashir's decision, ADR-008 amended). Coverage is deliberately small.
- **Platform admins:** they can only be created by setting the flag in SQL today. Platform tooling comes in M05.
- **Recovery codes:** the normaliser strips digits for the breach check only, not for recovery codes. Recovery-code fixtures use letters so they never collide with the strip rule.

## Test evidence

CI on `main` at `7974c13` (run 39613666934): success.

| Step | Result |
|---|---|
| unit | 65 files, 271 tests passed |
| integration (Testcontainers PG 18.6) | 21 files, 117 tests passed |
| contract | 1 file, 2 tests passed |
| e2e (Playwright: stack, UI, ui-perf) | 39 passed; table work p95 13.17 ms |
| req-coverage | 324 IDs indexed, 324 owned, 0 unmapped, 0 prd_ids outside their module; 52 IDs cited in 93 test files |
| gitleaks | no leaks found |
| lint, typecheck, depcruise, names, limits, squawk, actionlint, openapi, audit, build | ok |

Local full gate on each task head:
- **T-0201:** rc=0 in 789 s.
- **T-0202:** rc=0 in 699 s; the #30 additions rc=0 in 640 s on a fresh volume.
- **T-0203:** rc=0 in 939 s before the review fixes. On the final commit every step passed, but across two runs, not one (host load, Risk 7).

Review:

| Task | `/code-review` high (CodeRabbit CLI not installed) |
|---|---|
| T-0201 | 9 findings, 8 fixed |
| T-0202 | 5 findings, all fixed |
| #30 | 5 findings, 4 fixed |
| T-0203 | 5 findings, 2 fixed; 3 left as follow-ups (Risks 3–5) |

Mutation checks. Each mutation turned its tests red, then the code was restored:
- **T-0202:** removing the trigger's age check; disabling adminOnly.
- **T-0203:**
  - a pre-MFA session treated as a workspace session
  - no CSRF check
  - the counter keyed by the plain email
  - no lock re-check after a correct password

Extra commands for S4:
```bash
corepack pnpm exec vitest run packages/db/src/auth.int.test.ts apps/web/src/auth.int.test.ts
corepack pnpm exec playwright test tests/e2e/auth.spec.ts
```
The Playwright test needs the dev stack up (`docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml up -d`; the `seed` service runs first). It signs in as the DEV ONLY demo user: `demo.admin@example.test`, password `DEV ONLY lantern harbour 2026`, TOTP secret (base32) `IRCVMLKPJZGFSLKUJ5KFALKTIVBVERKU`.
