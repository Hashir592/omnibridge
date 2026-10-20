# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 20 Oct 2026 by S3.

## Now

- **Phase:** B, local Docker only (ADR-029).
- **M01 Platform foundations: CLOSED 20 Oct 2026.** S4 APPROVED in round 2. PRs #1, #2, #3, #5, #9, #12, #15, #17.
- **Current module:** M02 Identity, tenancy and audit (all S3 tasks high risk: Hashir says "go" before each).
- **Current task:** **T-0201 Tenancy core and isolation harness: in review.** Full local gate rc=0 (789 s), `/code-review` high: 9 findings, 8 fixed, 1 a follow-up. Own PR on `task/T-0201-tenancy-core`; waiting for CI and Hashir's approval.
- **M02 order:** T-0201 → T-0202 → T-0203 → halfway checkpoint → T-0204 → T-0205 → T-0207 → T-0206 (S5 audit) → M02 end. Exit also needs the S5 audit clean (ADR-026).
- **Workflow tiers (ADR-043):** light = `--quick`, no code review; normal = `--quick` + `/code-review` medium; high = full local gate + `/code-review` high. CI always runs the full gate.
- **UI tests (ADR-046):** screenshots for 4 key screens only: Orders, Order detail, Shipping desk (tablet), Sign in.
- **Open questions:** none. PS-017 (one transaction per request and job; bookkeeping apart) recorded as approved by S1 with the T-0201 go. Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

## What T-0201 delivered

- Migrations 0007 to 0009:
  - `app.workspaces` (plan `free_internal`, optional limits, TEN-6 settings, PII retention fixed at 25).
  - `app.companies` (TEN-2), `app.channel_accounts` (TEN-3 company lock), `app.users` (global; RLS: self or co-member), `app.memberships`.
  - Workspace FKs on the five M01 tables (NOT VALID, then VALIDATE).
- RLS: forced on every app table. `app.company_ids` is always an explicit list, filled by `app.workspace_company_ids()` (SECURITY DEFINER); unset or empty means no rows. `ob_platform` reads workspace ids only.
- `Tenancy` (packages/db) opens one tenant transaction per request and per job and hands out contexts bound to it. A context used after its transaction ends throws. Job bookkeeping runs in its own short transactions on its own pool (PS-017).
- Worker handler connections: `statement_timeout` 60 s and idle-in-transaction 180 s. Every pg pool now handles connection errors.
- Web: each route kind is authenticated before validation and fails closed. Production has no session or platform resolver yet, so those routes answer 401. Routes: `POST /platform/workspaces`, `POST /platform/workspaces/:id/companies`, `GET /companies`.
- Tests: the route walker covers 6 routes with 12 calls. A testkit stub auth exists for tests only and refuses to start outside dev and test.
- Ops job `rewrap-keys` (ops profile) re-wraps data keys and file keys for every workspace and exits 1 until none is left under another KEK (F-03, R2-02). The runbook in `docs/ops/secrets-register.md` is updated.
- Also: the launch seed (`packages/db/seed/`), and the dependency-cruiser rule `db-access-only-in-packages-db`. The cruiser no longer drops npm packages from its graph, so rules can now see them.

## Follow-ups noted (not in T-0201 scope)

- T-0203: the login lookup by email needs one narrow SECURITY DEFINER function, because ob_app sees only self and co-members in `app.users`. Real session and platform resolvers replace the stub.
- T-0204: child ticks narrow `companyIds` (today every member gets all of the workspace's companies); AT-2 joins the walker.
- T-0207: job retention, the purge index, the /healthz 503 reason and the mail colour (unchanged). The scheduled all-workspace jobs can now use `WorkspaceDirectory`.
- M07: provider jobs must not hold a tenant transaction across network calls; they use several short ones from one envelope, and S1 amends the invariant then. M07 also adds the `channel_account_id` FK on credentials.
- M04: the AT-9 marker scan should cover the `pgboss` schema (S4, M01 end).
- M12: the carrier accounts of the launch seed.
- Dev: `pnpm seed` cannot reach the local stack yet, because db-main publishes no port. Add a way in with the first screen that needs the data.
- Housekeeping: an orphaned `docker stats` loop (PID 1135) may still run on this host.

## Next step

1. CI runs the full gate on the T-0201 PR; Hashir reviews and approves the merge.
2. S3 starts T-0202 (append-only audit log) after Hashir's "go".

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
