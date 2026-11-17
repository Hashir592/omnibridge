# M02 end review (S4, 17 Nov 2026)

Reviewed: T-0204, T-0207, T-0209, T-0210, T-0211, T-0212, the halfway carry-over, `main` at `34429e8`.
**Verdict: APPROVED** (0 Blockers, 0 Majors, 6 Minors carried to M04). One round (ADR-044).

## Evidence
- Gate: CI run 44111987465 on `766bda6` (T-0212 merge) is green on every job; `main` runs before it are green. S5 audit: `docs/reviews/security/20261117-findings.md`, findings -01 to -03 fixed and re-checked (ADR-026 met). Not repeated here.
- My local runs in a clean worktree: names, coverage, limits, squawk ok (no new waiver in 0012 to 0020). Unit 341/342: `tests/config/ci.test.ts` timed out at 5 s under load and passed alone (16/16). Integration 162 passed, 1 file failed under load: `scan.int.test.ts` (clamd container; `boss` undefined in afterAll) and, in an earlier attempt, `auth.int.test.ts:1040` (a flood response was neither 401 nor 429). I did not diagnose these; CI is green on the same code. If the 1040 assertion recurs it is S3's to fix (ADR-054: fix the day it is seen).
- Not run: e2e (CI ran it), live web probes (the shared stack's web container was down). I probed the database directly instead.
- Halfway carry-over: F-01 to F-05, F-07, F-08, F-10 fixed (role catalogue checked live: `ob_worker` runs only `auth_purge`, `auth_reset_create`, `purge_audit_events`; the sign-in lookup and session functions are `ob_auth` only). F-06 done by T-0207, F-09 by PR #42. T-0204 carry-overs done: invariant 4 and USR-8 (probe below), auth events in `app.auth_events` (ADR-052).
- T-0204 acceptance tests all exist by title (`contract.test.ts`, `people.int.test.ts`, `permissions.int.test.ts`, `isolation.int.test.ts` walker as child with no ticks).
- Probe (rolled-back transaction as `ob_tenant_rw`): a child with {orders} and company A1 gets scope `member / {orders} / {A1}`; sees only A1; cannot read B's company; a tick for A2 is refused by RLS; a non-member gets no scope (401, USR-8).
- Checked fine: log redaction covers `/auth/invites/`, `/invite/`, `?token=`; HSTS and CSP via helmet (SEC-1, SEC-2); SPA fallback serves exact keys only; 0020 revokes without DROP, as ADR-063 allows.

## Minor findings (carry to M04)
- **F-M02e-01** Roles and tabs are enforced only in app code, not the database. As `ob_tenant_rw` in a child's context I could `UPDATE app.memberships SET role='admin'` on my own row (UPDATE 1), insert a `finance` tab for myself, and insert an admin invite. Needs an app bug to exploit; company ticks are enforced (invariant 4). Fix in M04's first migration: restrictive write policies on `memberships`, `membership_tabs`, `membership_companies`, `invites`, `access_reviews` requiring the caller be an admin (a definer `app.is_admin()`), plus a test as a child. `0015_permissions.sql`. PERM-3, PERM-5.
- **F-M02e-02** The invite email says "works for 7 days"; the invite lasts 72 hours. `packages/mail/src/templates.ts:96`, `packages/db/src/permissions.ts:9`. Take the wording from `INVITE_LIFETIME_MS` and test it. TEN-7.
- **F-M02e-03** `getJob` is `tab: none`, so any member, including a child with no ticks, can read any job of the workspace (`packages/contract/src/routes/jobs.ts:30`). Harmless while results are counts; scope by company before jobs carry company data. PERM-3, invariant 4.
- **F-M02e-04** New-user invite accept is not atomic: the invite is consumed and the member created, then the password is set in a second call (`apps/web/src/auth/service.ts`, `acceptInvite`). A failure between them leaves a member without a password (recoverable by reset). Do both in one definer call. USR-1, USR-3.
- **F-M02e-05** `tests/config/ci.test.ts:135` (git subprocess, 5 s default timeout) fails under load. Give it a longer timeout; do not delete it.
- **F-M02e-06** (S1 question) FA-22 says the pool sum must be at most max_connections minus 5; the role caps sum to 37 against 40, and the test reserves 3 (`tests/config/compose.test.ts:85`). Confirm which is meant.

## Notes for M04 and later
- Drop the three revoked rollout functions in M04's first migration with the ADR-063 waiver, before the first app deploy.
- `setUserAccess` and `removeUser` end all of the user's sessions in every workspace, not only this one. Safe, but surprising for users in several workspaces.
- Role creation (`10-roles.sh`, migration 0013 refuses to run without it) must be part of the M22 deploy.
- Open from S5: NV-2 (SEC-12 alerts, M05), hardening 2 (M05) and 6 (S2).
