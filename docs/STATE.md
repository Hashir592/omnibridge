# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 20 Nov 2026 by S2 (T-0313 console screens in a PR; M05 batch 2 merged as #117).

## Now

- **Phase:** B, local Docker only. Plan of 12 Nov 2026 (ADR-054): three releases, order in `docs/plan/MODULES.md`.
- **Closed:** M01, M02 (ADR-064), M03, **M04** (S4 M04 end APPROVED 19 Nov, `docs/reviews/M04-end.md`, ADR-070). M06 site pieces merged; waiting on the client's legal details.
- **M04 in short:** pii-vault (ingest, read-full, mask, search, match, delete) on `ob_pii`/`ob_vault`; deletion service with all seven DEL-1 triggers, tombstones in three places, journal; erasure, withdraw, retry and access export; eBay deletion fan-out; backups, restore drill, AT-9 marker scan; S5 audit fixes (ADR-068) and the external audit fixes (ADR-069).
- **Now: M05 core** (notification centre, email alerts, security alerts, platform console, app secrets). Tasks in `docs/backlog.json`. No halfway review; S5 audit T-0506 before the M05 end review.
- **M05 batch 1 (S3):** done and merged (T-0411, T-0501 to T-0503; ADR-071).
- **M05 batch 2 (S3) merged:** PR #117 (T-0504 and T-0505; #118 was stacked into it).
- **T-0313 (S2) in a PR, auto-merge on:** `/platform` console screens (workspaces and status moves, jobs and redrive, API usage, credential calendar, health, incident banner editor, write-only app secrets, flags), the incident line across the app, notification company names from `GET /companies` (ADR-072). Own frame outside the workspace shell; not linked from the app. Proposal PS-034: a `platform_admin` flag so the picker can offer the console.
  - T-0504 (PLAT-1/2/3, OPS-6): db-main 0033.
    - `/platform` routes are for a platform admin with MFA, from `PLATFORM_IP_ALLOWLIST` (`request.ip` via TRUSTED_PROXIES; an empty list denies). The flag and MFA are re-read every request (ADR-061 closed).
    - Workspaces have a status, active/suspended/archived; archive is final. Suspend and archive end sessions and open invites. Archive queues `workspace.close`: the workspace_closure deletion, then memberships, then the terms of people left with none.
    - Also: flags (`public_signup`), module toggles, the incident banner (in `GET /auth/session`), jobs, dead letters and redrive one, `app.api_usage_daily` (THE usage table M07's eBay governor reserves against, provider's own day), the credential calendar, health, `app.platform_audit_events`.
    - Daily jobs: the `platform.health-digest` email at 07:00 (counts only), and `notify.retention` (90 days, in the housekeeping sweep).
    - PLAT-3 proof: the platform route walk and a static field allowlist. PS-032.
  - T-0505 (PLAT-4): db-main 0034 `app.app_secrets`.
    - Current and next slots, AES-256-GCM under the platform data key (secrets_kek), sealed to the name. Write-only routes; the audit holds name and slot only.
    - `AppSecretStore.get` is the typed reader for M07. `PlatformKeys` moved to `@omnibridge/db`. The register has an app secrets section. PS-033.
- **After pulling:** recreate the stack once (`docker compose up -d`) so web gets `PLATFORM_IP_ALLOWLIST` (dev default: loopback plus 172.20.0.1, this machine's ob_edge gateway; set the variable if yours differs) and the seed adds the console's API usage rows. Locally, run `infra/backup/journal.sh --every 900` in a spare terminal if you want the 15-minute journal runs. Restart pii-vault once after T-0407 (runs the `buyer_exact` backfill); run `scripts/dev-secrets.sh` if the vault tokens are missing.
- **Speed (ADR-056):** never wait for CI (auto-merge); one review per PR; trivial lane; browser only when it proves something; short sessions.
- **Process (ADR-053, ADR-054):** sessions merge their own green PRs; CI is the only full gate.
- **Hashir:** GitHub CLI on Hashir592. Dev machine to 16 GB in 1 to 2 weeks.

## M05 plan (S1, 19 Nov, ADR-070)

- **Batch 1 (S3):** T-0411 stuck erasure retry (M04 Minors 01/02), T-0501 notification core (high), T-0502 email alerts and preferences, T-0503 security alerts (high).
- **S2 in parallel:** T-0311 (M04 Minors 02 to 04, light), then T-0312 notification centre and email preference screens.
- **Batch 2 (S3):** T-0504 platform console and daily digest (high), T-0505 app secrets store (high). S2: T-0313 console screens.
- **Then:** T-0506 S5 audit, then the S4 M05 end review. S1 writes the M07 tasks when batch 1 lands.

## Follow-ups noted

- **ADR-073/074:** repo is public (Hashir); open S5 findings stay in handoffs until fixed. T-0412 also pins the dev `ob_edge` subnet. Platform-audit read route in M21; eBay keyset into the store in M15; LWA rotation reminders in M18.
- **ADR-072:** T-0412 (S3, light) shared identifier-rule fixture, after batch 2. Notification detail key per type comes with M08/M09. T-0313 reads company names from `GET /companies`.
- **M05 batch 2 follow-ups (S1 to place):** `public_signup` is stored only; T-0205 (deferred) reads it. Platform audit has no read route yet. M15 moves the eBay endpoint's token and keyset into the app secrets store (S1 accepted). M18: LWA rotation reminders.
- Workspaces whose keys predate T-0404 have no canary (dev data only).
- **ADR-068, for the M07, M08 and M10 tasks:** expiry changes journalled; no re-ingest after an eBay deletion (tombstone check); eBay username reuse matched by user ID first.
- **M07 / M08:** Amazon revocation and eBay termination call `requestDeletion` with the channel account. Provider jobs use phased handlers and never hold a tenant transaction across network calls. The eBay key fetch cap (5 a minute) is per web process.
- **M10:** ingest is not idempotent per subject: key buyer records by order. Call `requestDeletion` on cancellation; set `delete_after` at dispatch/delivery + pii_expiry_days (vault backstop 90 days). The access export's `linkedOrders` joins orders by subject.
- **M12:** the vault's `LabelFiles` hook deletes label files with their records.
- **PS-026 / picomatch:** time-boxed audit exception (GHSA-fc5q-39xc-vjpf) **expires 1 Dec 2026**; when a fix ships, bump and delete the entry.
- **M22 (backups):** apply `infra/backup/b2.md`; schedule `backup.sh` nightly and `retention.sh`; host timer for the 15-minute journal run before go-live (ADR-068); pin the restic image by digest; restic gets its own `ob_backup` network (ADR-066); backup-age alert (OPS-4).
- **M22 (other):** remove the vault's start-up `buyer_exact` backfill; production `APP_ORIGINS`, `APP_ORIGIN`, SMTP (`SMTP_ALLOW_PLAIN=0`), `TRUSTED_PROXIES`; role creation (`10-roles.sh`) in the deploy; SEC-12 log retention 12 months and the two-weekly review; `data_key_version` for PII key rotation and a re-wrap job.
- F-M02e-01 residual: `MembershipRepository.add` is a system write (dev seed and tests only, guarded by a source-scan test).
- Not reproduced: `auth.int.test.ts` flood test failure on S4's machine (passes under 8x CPU stress).
- Later: very large audit exports as a background job.

## Next step

1. T-0313's PR merges itself on green CI.
2. S1: place the batch 2 follow-ups and rule on PS-034 (handoffs `docs/handoffs/20261120-1745-S3-to-S1.md`, `docs/handoffs/20261120-1910-S2-to-S1.md`); then S5 T-0506 audit.

## Prerequisites outstanding (Hashir)

| Needed for | Item | Status |
|---|---|---|
| CI (blocks every merge) | GitHub Actions jobs do not start: account payment failed or spending limit reached (20 Nov 2026) | open |
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
