# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 19 Oct 2026 by S1.

## Now

- **Phase:** B. Building M01 on local Docker (ADR-029).
- **Current module:** M01 Platform foundations (local Docker only)
- **Current task:** S4: M01 halfway review (T-0101 to T-0103), prompt `docs/sessions/briefs/S4-kickoff.md`. S3: idle until S4 findings come back. S2: T-0302 component kit, prompt `docs/sessions/briefs/S2-T-0302.md`. Done: T-0101, T-0102, T-0103, T-0301 (PRs #1 to #7).
- **Next:** after S4 halfway findings: fixes, then T-0104, T-0105, T-0106 (numbered pages + tooling), then the M01 end checkpoint.
- **Last checkpoint:** M01 halfway, handed to S4 on 18 Oct 2026 (findings pending).
- **Review (S4, 19 Oct 2026):** M01 halfway round 1 is **FIX REQUIRED**: 1 Blocker (config tests time out in the gate, so verify.sh is flaky), 1 Major (gitleaks KEK rule misses keys in env, YAML, JSON and code lines), 6 Minors. Acceptance 14/18. See `docs/reviews/M01-halfway-findings.md`.
- **Open questions:** none; PS-007 to PS-011 approved (ADR-038 to ADR-042). Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

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
- T-0201 + T-0104: an all-workspace KEK re-wrap job.
- M07: `channel_account_id` foreign key; LWA expiry reminders.

## Next step

1. Hashir merges the checkpoint docs PR (`docs/M01-halfway-checkpoint`) and pastes the handoff into Session 4.
2. S4's findings come back to S3, which fixes Blockers and Majors, then continues with T-0104.

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
