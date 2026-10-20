# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 21 Oct 2026 by S3.

## Now

- **Phase:** B, local Docker only (ADR-029).
- **M01 Platform foundations: CLOSED 20 Oct 2026.** S4 APPROVED in round 2.
- **Current module:** M02 Identity, tenancy and audit (all S3 tasks high risk: Hashir says "go" before each).
- **T-0201 Tenancy core and isolation harness: DONE.** Merged as PR #24 (25cd657).
- **Current task:** **T-0202 Append-only audit log: in review.** Full local gate and `/code-review` high (5 findings, all fixed). Own PR on `task/T-0202-audit-log`; waiting for CI and Hashir's approval.
- **M02 order:** T-0201 ✓ → T-0202 → T-0203 → halfway checkpoint → T-0204 → T-0205 → T-0207 → T-0206 (S5 audit) → M02 end. Exit also needs the S5 audit clean (ADR-026).
- **Workflow tiers (ADR-043):** light = `--quick`, no code review; normal = `--quick` + `/code-review` medium; high = full local gate + `/code-review` high. CI always runs the full gate.
- **UI tests (ADR-046):** screenshots for 4 key screens only: Orders, Order detail, Shipping desk (tablet), Sign in.
- **Open questions:** PS-018 (how the audit log stays append-only; see DECISIONS) waits for S1. Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

## What T-0202 delivered

- Migration 0010 `app.audit_events`:
  - Columns: UTC time set by the database, actor kind, user, action, entity type and id, before/after jsonb, reason, IP.
  - Forced RLS on the workspace.
  - ob_app may INSERT and SELECT only, and cannot set the id or time.
  - A trigger refuses UPDATE, DELETE and TRUNCATE for every role, ob_owner included.
- Retention (AUD-3, 6 years for everything): `app.purge_audit_events()` (SECURITY DEFINER, ob_owner) is the only deletion path. The daily platform job `audit.retention-sweep` (02:30 London) lists workspaces as ob_platform and sends one `audit.retention` job each. The worker now holds `ob_platform`.
- Event catalogue `packages/core/src/audit-events.ts`: every AUD-2 event, with its entity type, its allowed before/after fields and whether a reason is required. `auditDiff` keeps only the changed allowed fields. A field outside the catalogue, a non-scalar value or a `PIIMARK-` value is refused.
- Writer `AuditLog.record(ctx, …)` (packages/db) joins the request's or job's transaction.
- Routes (tab `audit-log`, adminOnly):
  - `GET /audit-events`: filters user, action, entity, from/to; keyset cursor.
  - `GET /audit-events/export`: CSV, formula-safe, paged, capped at 100,000 rows or 16 MiB. The export is itself audited.
- `adminOnly` is now enforced from the membership role (member or non-member → 403). The route walker covers 8 routes.

## Follow-ups noted (not in T-0202 scope)

- T-0203: write login, lockout and MFA events through `AuditLog.record`. The login lookup by email needs one narrow SECURITY DEFINER function. Real session and platform resolvers replace the stub.
- T-0204: child ticks narrow `companyIds`; tab enforcement joins the adminOnly check; AT-2 joins the walker. Write the user and permission events.
- T-0207: job retention can reuse `PLATFORM_JOBS`; plus the purge index, the /healthz 503 reason and the mail colour.
- Later: very large audit exports as a background job with a file link (today a 400 asks for a narrower range).
- M07: provider jobs must not hold a tenant transaction across network calls (S1 amends the invariant then). M07 also adds the `channel_account_id` FK on credentials.
- M04: the AT-9 marker scan should cover the `pgboss` schema. M12: carrier accounts of the launch seed.
- Dev: `pnpm seed` cannot reach the local stack yet (db-main publishes no port).

## Next step

1. CI runs the full gate on the T-0202 PR; Hashir reviews and approves the merge.
2. S1 rules on PS-018.
3. S3 starts T-0203 (passwords, MFA, lockout, sessions) after Hashir's "go".

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
