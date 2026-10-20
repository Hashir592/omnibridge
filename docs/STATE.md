# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 20 Oct 2026 by S1.

## Now

- **Phase:** B, local Docker only (ADR-029).
- **M01 Platform foundations: CLOSED 20 Oct 2026.** S4 APPROVED in round 2 (0 Blockers, 0 Majors). Tasks T-0101 to T-0106; PRs #1, #2, #3, #5, #9, #12, #15, #17.
- **Current module:** M02 Identity, tenancy and audit (all S3 tasks high risk: Hashir says "go" before each).
- **Now running:** S2, T-0304 (MSW out of the production build; faster table for ui-perf). Then S3, T-0201 (prompt `docs/sessions/briefs/S3-T-0201.md`). M03 end report merged (PR #21); S4 reviews M03 (T-0301..T-0304) together with the M02 halfway. One session at a time.
- **M02 order:** T-0201 → T-0202 → T-0203 → halfway checkpoint → T-0204 → T-0205 → T-0207 → T-0206 (S5 audit) → M02 end. Exit also needs the S5 audit clean (ADR-026).
- **Workflow tiers (ADR-043):** light = `--quick`, no code review; normal = `--quick` + `/code-review` medium; high = full local gate + `/code-review` high. CI always runs the full gate.
- **UI tests (ADR-046):** screenshots for 4 key screens only: Orders, Order detail, Shipping desk (tablet), Sign in.
- **Open questions:** none. PS-014 and PS-015 approved (ADR-047). PS-016 approved (ADR-048). Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

## M01 delivered

- Monorepo, limited compose stack, `verify.sh` gate, CI with parallel jobs and a docs fast path, lefthook.
- Contract registry with permission metadata, OpenAPI and typed client, numbered pages (ADR-040).
- Envelope crypto (AES-256-GCM, DEK/KEK), credential store, SOPS dev secrets (DEV ONLY age key).
- pg-boss queue and scheduler, file store with clamd scan and state guard, SMTP mail with Mailpit.
- **Local dev note:** after old volumes, run `docker compose … down -v`, then `bash scripts/dev-secrets.sh --reset`.

## Follow-ups placed

- T-0201: workspace FKs and rls-coverage for `app.data_keys` / `app.credentials`; all-workspace re-wrap job for data and file keys (F-03, R2-02).
- T-0207: migration no-transaction mode (ADR-047), credential purge index (F-06), job-record retention (F-05), /healthz 503 reason (R2-01), mail header colour.
- M06: the sign-in footer links (Privacy, Terms, Help) point to omnibridge.co.uk pages that M06 builds; dead until then.
- M05: `scan_failed` rescan path in the platform console; platform app-secrets table (PLAT-4, AMZ-10).
- M07: `channel_account_id` FK; LWA expiry reminders; new kinds in `CREDENTIAL_KINDS`.
- Before M01b observability: S1 re-checks prom-client (deprecated on npm).
- Housekeeping: an orphaned `docker stats` loop (PID 1135) may still run on this host.

## Next step

1. Hashir merges the S1 docs PR (T-0304). PR #21 is merged.
2. S2 runs T-0304 (prompt `docs/handoffs/20261020-1800-S1-to-S2.md`).
3. S3 posts the T-0201 plan; Hashir says "go". Then T-0202, T-0203.
4. S4 reviews the M02 halfway and the M03 end in one session.

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
