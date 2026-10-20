# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 20 Oct 2026 by S3.

## Now

- **Phase:** B. Building M01 on local Docker (ADR-029).
- **Current module:** M01 Platform foundations (local Docker only)
- **Current task:** **M01 end checkpoint, fix round 1 done (S3).** PR from `task/M01-end-fixes` fixes the 4 Majors and Minors F-07, F-08 and F-09; F-05 and F-06 go to S1 as PS-015. Next: Hashir merges, then S4 round 2. All M01 tasks are done: T-0101 to T-0106 (PRs #1, #2, #3, #5, #9, #12). S2: idle; next is T-0303 Auth screens (prompt `docs/sessions/briefs/S2-T-0303.md`), after the checkpoint (one session at a time). Done also: T-0301, T-0302 (PRs #7, #11).
- **Sessions:** Hashir runs **one session at a time** (ADR-043).
- **Workflow tiers (ADR-043):** light = `verify.sh --quick`, no code review, CI full gate; normal = `--quick` + `/code-review` medium, CI full gate; high = full local gate + `/code-review` high, then CI. S3 does not wait for CI.
- **Last checkpoint:** M01 end, handed to S4 on 20 Oct 2026 (one review of the whole module plus the halfway carry-over; up to 2 fix rounds, then S1, ADR-044). O-1 fixed (gate waits for a ready stack; 5 green full runs), F-04 landed as migration 0005.
- **Review (S4, 20 Oct 2026):** M01 end round 1 is **BLOCKED**: 0 Blockers, 4 Majors (lease leak on a failed record update, file-read errors crash the process, KEK rotation misses the file keys, docs fast path skips tests that read docs/), 5 Minors. Full gate, `--docs` and ui-refs pass; acceptance 39/39. See `docs/reviews/M01-end-findings.md`; S3's resolutions are filled in there.
- **UI tests (ADR-046):** screenshots for 4 key screens only: Orders, Order detail, Shipping desk (tablet), Sign in.
- **Open questions:** PS-015 (S3, M01 end fixes): how to move the credential purge index (F-06, squawk vs the transactional runner), file-key re-wrap in T-0201's job, job-record retention (F-05). PS-014 (S3, T-0105): nodemailer 10.1.0 and @fastify/helmet 13.1.2 instead of the ADR pins (7-day rule), @types/nodemailer 8.0.2, prom-client flagged deprecated. Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

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

1. Hashir merges the M01 end fixes PR once CI is green.
2. S4 runs round 2 of the M01 end review (the last of 2, ADR-044), then S1 closes M01 and rules on PS-014 and PS-015.
3. Then S2 T-0303, then T-0201.

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
