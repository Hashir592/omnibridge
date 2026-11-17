# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 17 Nov 2026 by S1.

## Now

- **Phase:** B, local Docker only. **Plan replaced on 12 Nov 2026** after the architecture audit (ADR-054): three releases, the order in `docs/plan/MODULES.md`. Release 1 = website + first approved marketplace + Evri: orders, stock, labels, tracking. The public site goes live early, deployed by Hashir's devops person.
- **M01:** closed. **M02:** T-0201, T-0202, T-0203 done; halfway fixes merged (PR #47, carry-over `docs/reviews/M02-halfway-carryover.md`; **recreate the local db-main volume once, then run `scripts/dev-secrets.sh`**); T-0208 faster CI merged (PR #48). T-0204 merged (PR #52, ADR-058). T-0207 housekeeping in review: no-transaction migrations (ADR-047), job/session/reset retention (daily `housekeeping.daily-sweep`, 02:45 London), healthz 503 reason, petrol mail header, ui-refs fix, role connection caps (sum 37 < 40), audit teardown flake; plus ADR-058 (a): the eBay key read counts against a daily budget in governor-ebay before sending (412 when spent). **The caps apply only to a new volume: recreate the local db-main and db-pii volumes once (or `ALTER ROLE … CONNECTION LIMIT` as the roles scripts list).** Next: S2, then S5 T-0206, then S4 M02 end.
- **M06 (site first):** T-0601 site + T-0603 terms acceptance merged (PR #49). T-0602 eBay deletion endpoint: PR #50. T-0604 early deploy pack: `infra/early-deploy/` and `docs/ops/runbooks/early-deploy.md`, dry run passes (`bash infra/early-deploy/dry-run.sh`). Waiting on the client: Operator legal details and the legal text review. S2: the SPA screen for `next: 'terms'`.
- **M03:** T-0305 (PR #40), T-0306 client changes (PR #41) and the M03 end fixes (PR #42) merged. M03 end round 2: APPROVED (S4, 14 Nov). Next S2 task: T-0307 (generic Website mark, light).
- **Client changes:** designs in `docs/plan/client-changes-20261112.md` (ADR-055, ADR-057). Real logic lands in M09, M10, M12 (Release 1) and M18, M20 (Release 3).
- **Order now (one session at a time):** done: M02 halfway fixes #47, T-0208 #48, M06 #49–#51, T-0204 #52, T-0207 #55, S2 screens #60, worker test cap fix #63. **T-0209 (ADR-060) merged (#62):** every contract route under `/api` (one rule: `packages/contract/src/mount.ts`; `/healthz`, `/webhooks/**`, `/connect/**/callback|declined` stay at the root), web serves the built SPA (`index.html` no-cache, `/assets/` immutable, unknown `/api/**` JSON 404), MSW handlers and signed file links on `/api`. S5 T-0206 audit done (#65): 0/0/1/2, blocks M02 until S5-20261117-01 is fixed; rulings ADR-061. **Next: S3 T-0210 (audit fixes, high) then T-0211 (module toggles, PS-024) → S4 M02 end.** S2 next batch: CSP inline styles to classes (ADR-061 note 6).
- **Speed (ADR-056):** never wait for CI (auto-merge); one review per PR; trivial lane; browser only when it proves something; quiet output; short sessions; batches up to 5.
- **Process (ADR-053, ADR-054, ADR-056):** sessions merge their own green PRs. CI is the only full gate; locally `--quick` (plus a task's integration tests for high risk). Halfway checkpoints only for M02, M04, M10, M12, M17, M18. Reviews do not block the next module.
- **Hashir:** GitHub CLI must stay on the Hashir592 account (`gh auth switch -u Hashir592`). Dev machine to 16 GB in 1 to 2 weeks.
- **Open questions:** none.

## What T-0203 delivered

- **Migration 0011:** user-level auth tables (`user_auth`, `password_history`, `recovery_codes`, `sessions`, `login_counters`, `ip_counters`, `password_resets`, `platform_keys`). ob_app holds no grant on them; every access is one narrow SECURITY DEFINER function. Times come from the app clock.
- **Passwords (USR-3):**
  - argon2id 19 MiB / t=2 / p=1, at most 4 hashes at once per web process (a queue of 32, then 429).
  - Rules: ≥12 characters; not the name or email local part; not on the committed list (`apps/web/data/common-passwords.txt`, 358 entries, case-insensitive, trailing digits and "!" stripped); not one of the last 10; minimum age 1 day.
  - Older than 365 days: `next: password_change`, and that session can only change it.
- **MFA (USR-4):** TOTP (@oslojs/otp) with one step of drift and no replay; the secret is sealed with a platform data key, which `rewrap-keys` re-wraps. The QR matrix comes from qrcode 1.5.4, server side. 10 recovery codes of 80 bits, stored as HMAC-SHA256 under `auth_hmac_key`.
- **Lockout (USR-5):** counters per HMAC of the email, so the same answers for real and unknown emails and no plaintext stored. 10 failures in 15 minutes lock for 15 minutes (429 + Retry-After). Per-address delay of 1 s doubling to 30 s after 3 failures. The lock notice goes to the user and the workspace admins as a worker mail job (web never sends SMTP).
- **Sessions (USR-6, SEC-1):** 256-bit token (SHA-256 stored), `ob_session` cookie HttpOnly/Secure/SameSite=Strict. Pre-MFA 10 minutes; then idle 30 minutes, absolute 12 hours; the token is replaced at every stage. Sign out, and sign out on all devices. Origin check plus a session-bound double-submit CSRF token on every state-changing route.
- **Reset (USR-7):** the worker makes the 30-minute single-use link just before sending, so only its hash is stored. A reset ends every session; signing in again still needs MFA.
- **Workspace picker (USR-2), platform path:** `GET /auth/workspaces`, `POST /auth/workspace`, `POST /auth/platform` (operators only, after MFA).
- **Audit:** `auth.login`, `auth.login_failed`, `auth.locked`, `mfa.enrolled` and `auth.signed_out_everywhere`, written into every workspace of the user.
- **SPA:** `apps/ui/src/auth/api.ts` on the typed client, with the CSRF header. Invites stay on the mock until T-0204.
- **Dev seed:** a one-off `seed` service (compose.dev.yaml) loads the launch workspace and the DEV ONLY demo sign-in, and refuses unless OB_ENV is dev or test. Playwright `[AT-3] login with TOTP` signs in through the edge.
- **Secrets:** new dev secrets `auth_hmac_key` (web and seed) and `ob_worker_password`. After pulling, run `scripts/dev-secrets.sh`; recreate the db-main volume once if it predates `ob_worker`.

## Follow-ups noted

- T-0209: web's CSP (`style-src 'self'`) blocks the SPA's inline `style=` attributes now that web serves the SPA; S1/S2 to pick nonce/hash, `style-src-attr`, or no inline styles. Route paths may not start with `/api` (the server adds it): WEB-3's `/api/v1/website/**` is declared as `/v1/website/**`.

- S1 (ADR-058 b): the M04/M05 deletion task must hard-delete `app.terms_acceptances` with the user; no backlog note yet (S1 edits the backlog).
- S2: `apps/ui/src/mocks/mocks.test.ts` page-size test now allows a page to finish a same-buyer group (the mock data is date-relative; main was red from 16 Nov).

- T-0204: invites (accept sets the first password through `AuthStore.setPassword`), roles and ticks; user and permission audit events; the invite screens move off the mock. USR-8: today a workspace session does not re-check its membership, so a removed member keeps reading until the session ends; revoke with `session_revoke_user` on removal and check the membership in `resolveSession`.
- T-0206 (S5 audit): a failed sign-in for a real account also writes audit rows, a few milliseconds that an unknown email skips. argon2 equalises the main cost (ADR-048); check whether the residual gap matters.
- S2 (later task): the password-change screen for `next: password_change`.
- M05: platform admins are made by platform tooling (no path yet); in-app lock alerts; a reset email for an operator with no workspace (skipped and logged today, since every job needs a workspace).
- M22: production `APP_ORIGINS`, `APP_ORIGIN` and SMTP (Scaleway TEM with TLS). The compose defaults are dev values: `SMTP_ALLOW_PLAIN` defaults to 1 for Mailpit, so production must set it to 0. `TRUSTED_PROXIES` defaults to uniquelocal (only the private-network edge may name the client address).
- T-0207: job retention can reuse `PLATFORM_JOBS`; plus the purge index, the /healthz 503 reason and the mail header colour.
- Capacity: role connection caps (ob_app 30, ob_worker 20, ob_platform 4) exceed `max_connections` 40; real peak is about 31 (web 10 + 2 queue, worker 18, fan-out 1). Revisit pool sizes in T-0207 or M22.
- Later: very large audit exports as a background job. M07: provider jobs must not hold a tenant transaction across network calls. M04: the AT-9 marker scan should cover `pgboss`. M12: carrier accounts of the launch seed.

## Next step

1. Hashir merges PR #30 after green CI, then the T-0203 PR after green CI.
2. S3 writes the M02 halfway checkpoint report (`docs/reviews/M02-halfway-report.md`) for S4.
3. T-0204 (invites, roles, tab and company ticks) after Hashir's "go".

## Prerequisites outstanding (Hashir)

| Needed for | Item | Status |
|---|---|---|
| Code review | CodeRabbit CLI is not installed on this machine, so `/code-review` runs instead (ADR-030) | open (optional) |
| Local full gate | WSL 2 has 3.8 GiB (host 7.9 GB, no `.wslconfig`); the full stack with clamd fits but is tight | open |
| Local tooling | Node 24.15 on the host; repo pins 24.22.0 (warning only). corepack needs `COREPACK_HOME=D:/.corepack` (EXDEV error otherwise) | open |
| M22 (deploy, near the end) | netcup VPS 2000 G12.5 + failover IPv4; VPS 1000 G12.5 (staging) | open |
| M22 | GoDaddy DNS for `omnibridge.co.uk`, `www`, `app`, staging hostnames | open |
| M22 | Backblaze B2 account (EU Central); Scaleway TEM account; UptimeRobot free account | open |
| M22 | Production age key for the private ops repo (secrets register) | open |
| M06 | Zoho Mail Lite (2 users + aliases); Operator legal name, number, address | open |

## Plan diagram

Lucid: https://lucid.app/lucidchart/f5dc0dc1-254a-47c4-959c-0b27cb5ca1fc/view (pages: build plan A to Z, task loop, what runs on localhost)

## Key files

`CLAUDE.md` · `docs/PRD.md` (v1.3) · `docs/ARCHITECTURE.md` · `docs/DECISIONS.md` · `docs/plan/MODULES.md` · `docs/backlog.json` · `docs/sessions/` · `README.md` (Run locally) · `docs/ops/github-settings.md` · `docs/ops/secrets-register.md`
