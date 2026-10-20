# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 21 Oct 2026 by S3.

## Now

- **Phase:** B. Building M01 on local Docker (ADR-029).
- **Current module:** M01 Platform foundations (local Docker only)
- **Current task:** S3: batch T-0104 + T-0105 + T-0106 done on `task/T-0104-T-0106-m01-rest`, PR #12 (all three in review). T-0106: F-04 as migration **0005** with the annotated squawk waiver (proven), numbered-page helper, gitleaks history scan from worktrees (fails loudly), `scripts/ui-refs.sh`, CI split into parallel jobs plus a docs fast path (`verify.sh --only` / `--docs`), and O-1 fixed (the gate now waits for the stack to be ready; 5 full local runs green). Next: PR #12 ready once CI is green, Hashir merges, then the M01 end report as a docs-only PR (it proves the fast path) and the S4 handoff. S2: idle; next is T-0303 Auth screens, after S3 (one session at a time). Done: T-0101, T-0102, T-0103, T-0301, T-0302 (PRs #1 to #11).
- **Sessions:** Hashir runs **one session at a time** (ADR-043).
- **Workflow tiers (ADR-043):** light = `verify.sh --quick`, no code review, CI full gate; normal = `--quick` + `/code-review` medium, CI full gate; high = full local gate + `/code-review` high, then CI. S3 does not wait for CI.
- **Last checkpoint:** M01 halfway: S4 found FIX REQUIRED (1 Blocker, 1 Major, 6 Minors). S3 fixed 7; F-04 moves into T-0106 as migration 0003 (PS-012 approved, ADR-045). Carry-over for the M01 end review: `docs/reviews/M01-halfway-carryover.md` (O-1 e2e flake, now in T-0106 scope).
- **UI tests (ADR-046):** screenshots for 4 key screens only: Orders, Order detail, Shipping desk (tablet), Sign in.
- **Open questions:** PS-014 (S3, T-0105): nodemailer 10.1.0 and @fastify/helmet 13.1.2 instead of the ADR pins (7-day rule), @types/nodemailer 8.0.2, prom-client flagged deprecated. Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

## Delivery model

Local-first (ADR-029): everything is built and tested on local Docker with mocks; servers arrive only in M22 Deploy, near the end. Local containers keep the production limits.

## Done so far

- **T-0101 (done):** pnpm monorepo, the limited compose stack, `scripts/verify.sh` full gate, CI, lefthook.
- **T-0103 (done):** see below.
- **T-0102 (done):** contract registry with permission metadata, OpenAPI plus typed client, time, cache-key and error helpers.

## What T-0103 delivered

- `packages/crypto`: AES-256-GCM with a random 96-bit nonce, a key-version prefix, and AAD binding workspace, table, column and row. DEK/KEK envelope with versioned keyrings; KEK rotation re-wraps DEKs only. `Secret` never prints its value.
- Two master keys as Docker secrets: `secrets_kek` (web, worker) and `pii_kek` (pii-vault only), both loaded at boot.
- Migration 0002: `app.data_keys` and `app.credentials` (current/next slots, forced RLS). `CredentialRepository` in `packages/db`. `TenantContext` type in core (T-0201 extends it).
- Dev secrets: SOPS 3.13.3 image plus the DEV ONLY age key in `infra/secrets/`. Run `bash scripts/dev-secrets.sh` (or `--reset` after `down -v`). Register: `docs/ops/secrets-register.md`. PS-007 (approved).
- **Local dev note:** dev DB passwords are now the SOPS values. Any machine with older volumes needs one `docker compose … down -v`, then `bash scripts/dev-secrets.sh --reset`.

## Follow-ups noted (not in T-0103 scope)

- M05: platform app-secrets table (PLAT-4, AMZ-10 LWA current/next) on the same crypto.
- T-0201: workspace foreign keys on `app.data_keys` and `app.credentials`; tenant transaction wrapper.
- T-0201 + T-0104: an all-workspace KEK re-wrap job, which reports the count of data keys left under the old KEK across all workspaces and refuses to call the rotation done unless it is 0 (F-03).
- T-0201: the `rls-coverage` test must include `app.data_keys` and `app.credentials` (S4).
- M07: `channel_account_id` foreign key; LWA expiry reminders; new provider credential kinds go into `CREDENTIAL_KINDS`.
- Housekeeping: an orphaned `docker stats` loop from S4's session (PID 1135, read-only) still runs on this host; ending it is up to Hashir.

## Next step

1. Hashir merges the S1 docs PR for PS-013.
2. S3 runs the batch T-0104, T-0105, T-0106 (draft PR after T-0104; no waiting on CI).
3. M01 end checkpoint: S3 report plus the halfway carry-over → S4 (up to 2 fix rounds).

## Prerequisites outstanding (Hashir)

| Needed for | Item | Status |
|---|---|---|
| Code review | CodeRabbit CLI is not installed on this machine, so `/code-review` runs instead (ADR-030) | open (optional) |
| Local full gate | WSL 2 has 3.8 GiB (host 7.9 GB, no `.wslconfig`); the full stack with clamd fits but is tight | open |
| Local tooling | Node 24.15 on the host; repo pins 24.22.0 (warning only). corepack needs `COREPACK_HOME` on drive D: (EXDEV error) | open |
| M22 (deploy, near the end) | netcup VPS 2000 G12.5 + failover IPv4; VPS 1000 G12.5 (staging) | open |
| M22 | GoDaddy DNS for `omnibridge.co.uk`, `www`, `app`, staging hostnames | open |
| M22 | Backblaze B2 account (EU Central); Scaleway TEM account; UptimeRobot free account | open |
| M22 | Production age key for the private ops repo (secrets register) | open |
| M06 | Zoho Mail Lite (2 users + aliases); Operator legal name, number, address | open |

## Plan diagram

Lucid: https://lucid.app/lucidchart/f5dc0dc1-254a-47c4-959c-0b27cb5ca1fc/view (pages: build plan A to Z, task loop, what runs on localhost)

## Key files

`CLAUDE.md` · `docs/PRD.md` (v1.3) · `docs/ARCHITECTURE.md` · `docs/DECISIONS.md` · `docs/plan/MODULES.md` · `docs/backlog.json` · `docs/sessions/` · `README.md` (Run locally) · `docs/ops/github-settings.md` · `docs/ops/secrets-register.md`
