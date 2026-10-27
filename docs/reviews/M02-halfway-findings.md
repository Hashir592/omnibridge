# M02 halfway findings — round 1
Reviewed: T-0201, T-0202, T-0203 (PRs #24, #25, #30, #31, #32), `main` at `c753c60` (code identical to `7974c13`; only the report and handoff were added). verify.sh: PASS in parts, not in one run (see "How I ran it")
Acceptance re-run: 24/24 PASS

From S4, 27 Oct 2026. Verdict: **FIX REQUIRED** (0 Blockers, 3 Majors). Halfway flow (ADR-044): S3 fixes every Blocker and Major, records them in `docs/reviews/M02-halfway-carryover.md`, and there is no round 2. I check the carry-over at the M02 end.

## How I ran it

- Clean state: `compose down -v`, `dev-secrets.sh --reset`, `COREPACK_HOME=D:\.corepack`, Docker 3.77 GiB.
- My first gate attempt in the main checkout stopped at `lint`: `prettier --check` flagged an **untracked** `.claude/launch.json` (the Claude app's local preview config). That is F-M02h-08, not a code defect. I then made a clean worktree of `main` (`../omnibridge-s4`, detached at `c753c60`) and ran the gate there.
- **Gate in the clean worktree, run 1 (1,006 s):** install, lint, typecheck, openapi, depcruise, names, coverage, limits, squawk, actionlint, caddy ok; unit 65 files / 271 tests ok (75 s); integration 21 files / 117 tests ok (264 s); contract ok; build ok; stack ok (173 s); **e2e FAILED: 38 passed, 1 failed** — `[NFR-8] dialog, sheet and confirm work with the keyboard and return focus` (`apps/ui/e2e/kit.spec.ts:39`). `gitleaks` and `audit` did not run, because the gate stops at the first failure.
- That test passed 24/24 when I repeated the file 6 times with 2 workers, and `--only=install,build,stack,e2e` passed on the same code (39/39, 241 s). `--only=gitleaks,audit` also passed (83 commits scanned from the worktree, no leaks; audit: 11 findings, 0 high or critical). So every gate step has passed on this code, but **never in one uninterrupted run**. The one e2e failure is a timing race in the test (F-M02h-09), and it is the same kind of load-sensitivity S3 reports (Risk 7).
- Memory: no OOM. Peaks stayed far below every container limit.
- S3's extra commands are covered by the unit and integration steps (`auth.int.test.ts` files) and by e2e `[AT-3] login with TOTP` (passed).
- Probes (scratchpad only): catalog queries and rolled-back SQL as `ob_worker`/`ob_app`; a live probe script against `https://localhost:8443` with the DEV ONLY demo user (cookies, CSRF, gating, lockout, replay, change-password, timing, race, per-IP delay). Each probe reset the failure counters afterwards.
- `/code-review` was not re-run: S3 ran it at high for each task, and I read the migrations (0007 to 0011) and the auth, tenancy, audit and queue code by hand.

## Acceptance re-run

| Task | Item | Result | Evidence |
|---|---|---|---|
| T-0201 | verify.sh exits 0 | PASS* | all steps green across two runs (see above) and CI on `main` |
| T-0201 | `[TEN-1] rls-coverage` | PASS | `tenancy.int.test.ts`; also checks forced RLS on every `app.*` table, company policies and composite FKs. My catalog probe: all 19 `app` tables `relrowsecurity` and `relforcerowsecurity` true |
| T-0201 | `[TEN-1][AT-1]` route walker | PASS | `apps/web/src/isolation.int.test.ts` seeds A and B with markers, calls every route with B's ids |
| T-0201 | raw SQL as `ob_app` without `SET LOCAL` returns zero rows | PASS | integration; the 8 auth tables are denied outright |
| T-0201 | `[TEN-1]` job without workspace is rejected | PASS | `queue/runtime.test.ts` |
| T-0201 | `[TEN-4]` name gate, `[TEN-10]` limits only when set | PASS | `repo-rules.test.ts`, `tenancy.int.test.ts` |
| T-0201 | `[TEN-1]` re-wrap job reports done only when no key is left | PASS | `key-rotation.int.test.ts`; code reviewed (data keys, platform key and file keys, newer-KEK skip) |
| T-0202 | `[AUD-1]` UPDATE/DELETE fail for `ob_app` | PASS | `audit.int.test.ts` |
| T-0202 | `[AUD-3]` PII marker rejected; `[AUD-4]` child 403, export audited | PASS | `audit-events.test.ts`, `audit.int.test.ts` (web and db) |
| T-0203 | no workspace route before MFA | PASS | live: pre-MFA cookie gets 401 on `/auth/workspaces`, `/audit-events`, `/jobs/:id` |
| T-0203 | `[USR-5]` 10 failures lock 15 min and notify; unknown email locks the same | PASS | live: 9 × 401 then `429` with `Retry-After: 900` for both an unknown and the real email; a correct password while locked also 429; the counter key holds no plaintext (`bool_or(... LIKE '%example%')` = false) |
| T-0203 | `[USR-3]` breached, short, name, reused passwords | PASS | `auth.int.test.ts` |
| T-0203 | `[USR-6]` idle 30 min / absolute 12 h | PASS | `auth.int.test.ts` fake clock; live: sign-out kills the token, MFA step replaces it |
| T-0203 | `[USR-7]` reset link 30 min, MFA still required | PASS | `auth.int.test.ts`; code: the reset opens no session and revokes all |
| T-0203 | `[SEC-1]` no CSRF token rejected | PASS | live: no token, bad Origin, no Origin all 403 |
| T-0203 | Playwright `[AT-3]` login with TOTP | PASS | e2e 39/39 |
| T-0203 | TOTP replay refused | PASS | live: the same code in a second sign-in gets 401 |

## Checked, no finding

- **Tenancy (T-0201):** every `app` table has forced RLS and a policy; companies and channel accounts add RESTRICTIVE policies on an explicit company list; `app.company_ids` is never a wildcard. The users and memberships policies use SECURITY DEFINER helpers and do not recurse. A context used after its transaction ended throws. Limits, the company lock and the first-company defaults are triggers under a workspace row lock.
- **Definer surface:** I listed all of them from `pg_proc`: **31 SECURITY DEFINER functions, all owned by `ob_owner`, all with `search_path = pg_catalog, pg_temp`, none executable by PUBLIC**. `ob_platform` can execute none; the purge function only `ob_worker`.
- **Audit (T-0202):** append-only trigger on UPDATE, DELETE and TRUNCATE; the one delete path is the definer purge (6-year cut-off inside, current workspace only, `current_user = 'ob_owner'` plus the flag). Cursor is `(occurred_at, id)`. The CSV cells are quoted and formula-safe, capped at 100,000 rows / 16 MiB, and the export audits itself.
- **Auth (T-0203):** session cookie `HttpOnly; Secure; SameSite=Strict`, responses `Cache-Control: no-store`; the token is replaced at every stage and the old pre-MFA token dies (401); signed-out tokens die; a pre-MFA cookie opens only the MFA routes. 20 parallel wrong sign-ins on a fresh email: 9 × 401 and 11 × 429, **0 errors**, 10 failures recorded (no race). The per-IP delay starts at the 4th failure, as specified. Unknown and real emails give the same answer body and status; sign-in medians were 65 ms and 57 ms. Passwords, emails and TOTP codes appear nowhere in the web logs.
- **Gate/CI:** CI split works (`changes`, `static`, `tests`, `stack`, one required check). The history scan runs from a worktree. The five new migrations (0007 to 0011) are forward-only and expand-only; squawk is clean and there is no new waiver.
- **Capacity:** I confirmed S3's Risk 2: role caps (ob_app 30, ob_worker 20, ob_platform 4) exceed `max_connections` 40.

## F-M02h-01 — Major — The password-reset token is written to the web logs
Area: 3 PII / 4 Security  IDs: USR-7, SEC-5
Evidence: `GET /auth/password/reset/:token` (`packages/contract/src/routes/auth.ts:149`) carries the single-use token in the URL path. The logger drops only the query string (`packages/logger/src/logger.ts`, `serializeRequest`), so the path stays. Live probe (a fake token): `docker logs omnibridge-web-1 | grep PROBE-RESET-TOKEN` →
```
{"level":30,…,"req":{"method":"GET","url":"/auth/password/reset/PROBE-RESET-TOKEN-1793086212892"},"msg":"incoming request"}
```
A real token is therefore written to the logs, which the plan keeps for 13 months in VictoriaLogs (SEC-12). The token is a credential for 30 minutes (it still needs MFA afterwards, which limits the harm, but SEC-5 says no secrets in logs). I checked for the other secrets: passwords, emails and TOTP codes are not logged.
Required fix:
1. Do not put the token in a path or query. Make the "who is this link for" lookup a `POST` with the token in the body (or a header), and change the SPA's reset screen to call it.
2. Add a logger rule that redacts any path segment after `/auth/password/reset/` (and, for later, invite tokens), so a future route cannot repeat this.
3. Test: call the reset-info route with a marker token while capturing the log stream; the marker must not appear.
Resolution: (S3 fills in)

## F-M02h-02 — Major — Changing a password checks the current password with no failure counter
Area: 4 Security  IDs: USR-5, USR-3
Evidence: `AuthService.changePassword` (`apps/web/src/auth/service.ts`) verifies `currentPassword` with `passwords.check` and answers 422 on a miss, but it never calls `recordFailure` or `lockState`. Live probe, signed in (workspace stage), 12 wrong current passwords in a row: `422,422,422,422,422,422,422,422,422,422,422,422`, `login_counters` rows after: 0. So anyone holding a live session (a stolen cookie, an unlocked laptop) can guess the current password online without limit, at the speed of the 4-slot hash gate, and then reuse it elsewhere or keep access after the session ends. USR-5 limits failed attempts at the sign-in verifier; this is a second verifier of the same secret.
Required fix: Count a wrong current password against the same email key and the same per-IP delay (and refuse with 429 and `Retry-After` while locked or delayed), exactly like `signIn` and the MFA routes. Add tests: 10 wrong current passwords lock; a lock started by sign-in failures also blocks the change; a right password after the lock is refused.
Resolution: (S3 fills in)

## F-M02h-03 — Major — The auth definers are open to every `ob_app`/`ob_worker` connection: raw SQL can mint a platform session or read password hashes
Area: 4 Security / 9 Invariants  IDs: SEC-3, USR-6, ADR-048, ADR-049
Evidence: Migration 0011 says "ob_app holds no grant at all, so even a bug that sends raw SQL as ob_app reads nothing", and the test `[TEN-1] raw SQL as ob_app …` checks the raw tables. But the 27 `auth_*`/`session_*`/`platform_key_*` functions are `GRANT EXECUTE … TO ob_app`, take any argument and check nothing about the caller, and `ob_worker` inherits them (it can execute 28). Probe as **`ob_worker`**, in a rolled-back transaction:
```
SELECT user_id, left(password_hash,22) FROM app.auth_login_lookup('demo.admin@example.test');
 → 5eed0000-…-d1 | $argon2id$v=19$m=19456
SELECT app.session_create('9999…', decode(repeat('ab',32),'hex'), decode(repeat('cd',32),'hex'), '5eed0000-…-d1', 'platform', now(), now()+interval '12 hours');
SELECT id, stage, user_id FROM app.session_find(decode(repeat('ab',32),'hex'));
 → 9999… | platform | 5eed0000-…-d1
```
So any code running as `ob_worker` or `ob_app` (a SQL-injection bug in web, or a compromised worker that will parse provider data from M07 on) can read the hash of any known email and create a `platform`-stage session for any user id; the API then trusts that stage (`resolvePlatform` checks only the stage). `session_advance` likewise accepts any stage. The worker needs only a few of these (the reset link and the workspace list), not the session functions.
Required fix:
1. `session_create` creates a `pre_mfa` session only (reject any other stage inside the function).
2. Stop the worker and `rewrap-keys`/`seed` from executing what they do not need: give `ob_worker` EXECUTE only on the few functions the mail jobs call (`auth_reset_create`, and whatever `issuePasswordReset`/`userWorkspaces` use), and everything else only to the web role. Because `ob_worker` inherits `ob_app`, this needs a role split: for example a NOLOGIN group that holds the table DML grants, with `ob_app` and `ob_worker` as members, and a second group for the auth definers that only `ob_app` joins. S1 to confirm the role design (ADR-049 touches it).
3. Test as `ob_worker`: `session_create(…, 'platform', …)`, `auth_login_lookup` and `session_find` are denied; `auth_reset_create` still works.
4. Correct the claim in the migration header and in `docs/ops` so it says what is true.
Resolution: (S3 fills in)

## F-M02h-04 — Minor — `POST /auth/password/forgot` shows whether an email has an account, by timing
Area: 4 Security  IDs: USR-7
Evidence: USR-7 says nothing may tell whether an email has an account. Live probe, 15 requests each, same session: medians **25.2 ms for the real email vs 11.8 ms for unknown ones** (min/max 14.0–68.5 vs 6.0–32.2). The real path does the workspace lookup and queues a mail job; the unknown path returns after one lookup. Sign-in is equalised (65 vs 57 ms) because ADR-048 runs a dummy hash; forgot has no equivalent.
Required fix: Make both paths do the same work before the 202: for example always run the lookup, then queue the work after the response is sent (or for an unknown email send a no-op job through the same code path). Re-run the timing probe; the medians should be within normal noise.
Resolution: (S3 fills in)

## F-M02h-05 — Minor — Nothing limits `POST /auth/password/forgot` per address, and mail is a paid, capped resource
Area: 5 Rate limits  IDs: USR-7, SEC-1
Evidence: `notifier.passwordReset` uses the idempotency key `reset:<user>:<minute>` (`apps/web/src/auth/notifier.ts:28`), so a known email gets at most one mail per minute, forever, and each one inserts a `password_resets` row. There is no per-IP or global cap (the web app registers no `@fastify/rate-limit`, which ADR-002 lists), and ADR-020's free tier is 300 emails a month. One script could spend the month's allowance in five hours, and use the product to mail-bomb a known address.
Required fix: A per-address cap (for example 3 per hour), a per-IP cap and a daily global ceiling on reset mails; over the limit the route still answers 202 and sends nothing. Test it.
Resolution: (S3 fills in)

## F-M02h-06 — Minor — Sessions and used or expired reset links are never deleted
Area: 6 Performance and memory  IDs: USR-6, USR-7
Evidence: `app.sessions` gets a row per sign-in (revoked or expired rows stay), and `app.password_resets` keeps used and expired links; `grep -rn "DELETE FROM app.sessions\|DELETE FROM app.password_resets"` finds nothing outside tests. Only `login_counters` and `ip_counters` clean themselves (inside `auth_record_failure`). Hash-only data, so nothing leaks, but the tables grow for ever.
Required fix: Put both into T-0207's retention job (delete sessions revoked or expired more than, say, 30 days ago; resets used or expired more than 7 days ago), with an index to delete by, and a test.
Resolution: (S3 fills in)

## F-M02h-07 — Minor — The documented demo TOTP secret is wrong
Area: 1 Correctness  IDs: USR-4 (AT-3)
Evidence: `docs/reviews/M02-halfway-report.md:141` gives the DEV ONLY TOTP secret as `IRCVMLKPJZGFSWJNKRHVIUBNKNCUGUSFKQ` (34 characters). The seed secret is the 20 bytes `DEV-ONLY-TOTP-SECRET`, and the module's own `base32()` gives **`IRCVMLKPJZGFSLKUJ5KFALKTIVBVERKU`** (32 characters). With the first string my probe's TOTP code was refused (401 `invalid_code`); with the seed bytes it was accepted (200 `next: app`). Anyone typing the documented secret into an authenticator app gets codes that never work. CLAUDE.md asks that demo values shown to Hashir be right and inline.
Required fix: Correct the value wherever it is stated (the report, the S3 handoff, `STATE.md` or README if it appears), and add a unit test that `base32(DEV_ONLY_DEMO_USER.totpSecret)` equals a literal that is also what the docs show.
Resolution: (S3 fills in)

## F-M02h-08 — Minor — The gate fails in the main checkout when `.claude/launch.json` exists
Area: 8 Requirement coverage / gate integrity  IDs: SEC-16
Evidence: First gate attempt in the main checkout: `--- lint FAILED`, `[warn] .claude/launch.json … Code style issues found`. The file is the Claude app's local preview config (it points at `D:/Work Projects/omnibridge-ui`); it is untracked and not ignored, and `.prettierignore` lists only `.claude/settings.local.json`. Any developer who starts a preview from the app gets a red gate on a clean tree. The same clean tree in a worktree passed lint.
Required fix: Add `.claude/` (or `.claude/launch.json`) to `.prettierignore` and `.gitignore`, and the ESLint ignores if it matters.
Resolution: (S3 fills in)

## F-M02h-09 — Minor — The kit focus-trap test checks once, right after a keypress
Area: 8 Requirement coverage  IDs: NFR-8
Evidence: `apps/ui/e2e/kit.spec.ts:39-50` presses Tab and immediately runs a one-shot `expect(await dialog.evaluate(d => d.contains(document.activeElement))).toBe(true)`. Under load the focus moves a frame later. It failed once in my full gate (`Expected: true  Received: false`) and passed 24/24 alone. This is the cause of the flake and not a focus-trap bug.
Required fix (S2's file; route through S3 only if S2 is idle): use `await expect.poll(() => dialog.evaluate(…)).toBe(true)`, or `await expect(dialog.locator(':focus')).toHaveCount(1)`, for each Tab. Do not loosen what is asserted.
Resolution: (S3 or S2 fills in)

## F-M02h-10 — Minor — The dependency housekeeping due on 25 Oct has not been done, and nodemailer has known advisories
Area: 4 Security (dependency risk)  IDs: SEC-4
Evidence: (a) `pnpm-workspace.yaml` still has the 75-entry `minimumReleaseAgeExclude` list that PS-005 and `STATE.md` say to delete after 25 Oct 2026 (today is 27 Oct). (b) `osv-scanner` in the audit step reports 11 moderate or low findings with 0 high or critical (so the gate stays green), among them three on **nodemailer 10.1.0** (CVSS 6.5 each): GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, all address-parser flaws that can deliver mail to a recipient the header does not name. They are fixed in 10.1.4. The reset and lock mails address users by the stored email.
Required fix: Delete the exclude list; move nodemailer to the newest release that is at least 7 days old and has provenance (10.1.4 or later; S1 to amend ADR-020/PS-014), and in `Mailer.send` refuse any recipient that is not a plain `local@domain` address before it reaches the parser.
Resolution: (S3 fills in)

## Carried to T-0204 and later (not findings)

- **Invariant 4 / TEN-5 is not enforced yet.** `Tenancy.runWorkspace` sets `app.company_ids` to every company of the workspace, so `GET /companies` ("their permitted companies only") returns all of them to any member. That is fine while only the admin exists; T-0204 must add the ticks and a walker test for a child with no ticks, **before** any member user can be created.
- **USR-8** (a removed member keeps access up to 12 h): T-0204 revokes on removal and re-checks membership in `resolveSession`; add a test that proves it.
- **Auth events in every workspace.** A user's login events (with their IP) are written into each workspace they belong to (S3's open question). An admin of workspace B can see when and from where a consultant used workspace A. S1 to decide whether `auth.login` belongs only to the workspace chosen after the picker, and failed attempts to a platform audit (M05).
- The per-IP timing gap of Risk 4 stays with S5 (T-0206). `GET /auth/csrf` and the other public routes have no per-IP cap beyond F-M02h-05.
- Capacity (Risk 2) is real: pool sizes in T-0207.
- `ui-perf` margins are thin everywhere (CI p95 14.28, 16.20, 15.99, 13.17 ms; my gate run 15.40 ms; idle 8.1 to 8.8 ms); see the M03 findings.
