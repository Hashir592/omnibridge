# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 20 Nov 2026 by S3 (M05 batch 1 done).

## Now

- **Phase:** B, local Docker only. Plan of 12 Nov 2026 (ADR-054): three releases, order in `docs/plan/MODULES.md`.
- **Closed:** M01, M02 (ADR-064), M03, **M04** (S4 M04 end APPROVED 19 Nov, `docs/reviews/M04-end.md`, ADR-070). M06 site pieces merged; waiting on the client's legal details.
- **M04 in short:** pii-vault (ingest, read-full, mask, search, match, delete) on `ob_pii`/`ob_vault`; deletion service with all seven DEL-1 triggers, tombstones in three places, journal; erasure, withdraw, retry and access export; eBay deletion fan-out; backups, restore drill, AT-9 marker scan; S5 audit fixes (ADR-068) and the external audit fixes (ADR-069).
- **Now: M05 core** (notification centre, email alerts, security alerts, platform console, app secrets). Tasks in `docs/backlog.json`. No halfway review; S5 audit T-0506 before the M05 end review.
- **M05 batch 1 (S3) done:**
  - T-0411: PR #107, merged.
  - T-0501: PR #108, merged.
  - T-0502: PR #109, merged.
  - T-0503: PR #110, auto-merge.
  - T-0411 (DEL-4): an erasure request is `stuck` when it is confirmed and either its claim has no job 2 minutes on, or its `pii.delete` job is failed, cancelled or gone. The list returns `stuck`. Retry accepts failed and stuck requests under a new key `erasure:<id>:retry<n>` (Hashir and S1: ADR-070's "same key" would be a no-op).
  - T-0501 (NTF-1/2/5): db-main 0030 holds `app.notifications`, one row per type and record, updated in place; read state is per user and version. Platform notices sit in owner-only tables behind definers.
    - Core `Notifier` and type registry (IDs, counts and flags only); callers pass their bound context.
    - Routes `/notifications` (list, unread-count, read, read-all) and `/platform/notifications`.
  - T-0502 (NTF-3/4, MAIL-3): db-main 0031 holds per-user, per-type email preferences (critical types locked on for admins) and sent records per version.
    - `notify.email` is a phased job per recipient, queued in the raiser's transaction.
    - Critical platform notices go to platform admins by a minute sweep.
    - Routes `/me/notification-email-preferences`.
  - T-0503 (SEC-12): `security.scan` runs every 5 minutes per workspace, with thresholds in worker env `SECURITY_*`.
    - It alerts on failed sign-in bursts, sign-ins from a network unseen in 90 days, lockouts, mass exports, mass full reads and canary reads (24 h, critical platform).
    - Erasure failure alerts at once; an eBay key throttle raises a platform notice per hour.
    - The vault has a new `signals` capability (worker token). db-main 0032 adds the auth-event definers.
- **After pulling:** recreate the stack once (`docker compose up -d`) so web, worker and pii-vault join `ob_vault`. Locally, run `infra/backup/journal.sh --every 900` in a spare terminal if you want the 15-minute journal runs. Restart pii-vault once after T-0407 (runs the `buyer_exact` backfill); run `scripts/dev-secrets.sh` if the vault tokens are missing.
- **Speed (ADR-056):** never wait for CI (auto-merge); one review per PR; trivial lane; browser only when it proves something; short sessions.
- **Process (ADR-053, ADR-054):** sessions merge their own green PRs; CI is the only full gate.
- **Hashir:** GitHub CLI on Hashir592. Dev machine to 16 GB in 1 to 2 weeks.

## M05 plan (S1, 19 Nov, ADR-070)

- **Batch 1 (S3):** T-0411 stuck erasure retry (M04 Minors 01/02), T-0501 notification core (high), T-0502 email alerts and preferences, T-0503 security alerts (high).
- **S2 in parallel:** T-0311 (M04 Minors 02 to 04, light), then T-0312 notification centre and email preference screens.
- **Batch 2 (S3):** T-0504 platform console and daily digest (high), T-0505 app secrets store (high). S2: T-0313 console screens.
- **Then:** T-0506 S5 audit, then the S4 M05 end review. S1 writes the M07 tasks when batch 1 lands.

## Follow-ups noted

- **M05 (in tasks):** demoting a platform admin re-checked per request (ADR-061); console audit event when a module is switched (T-0211).
- **M05 batch 1 follow-ups (S1 to place):**
  - Notification retention or purge: not in the PRD.
  - A web raise for a company outside a child's ticks fails RLS: callers raise in scope.
  - A DB error while raising the erasure alert rolls back the failed state too; the request then shows stuck with Retry.
  - Email is at-least-once: a commit failure after the SMTP send can repeat it.
- **M05 (in T-0504):** archiving a workspace runs the `workspace_closure` deletion, then `DeletionLog.deleteUserTerms`. Workspaces whose keys predate T-0404 have no canary (dev data only).
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

1. S3: PR #110 (T-0503) merges itself on green (if red, S3 fixes it).
2. S2: T-0311, then T-0312 against PS-029 to PS-031 (handoff `docs/handoffs/20261120-0017-S3-to-S2.md`).
3. S1: amend ADR-070 (retry key), place the follow-ups, write the M07 tasks (handoff `docs/handoffs/20261120-0017-S3-to-S1.md`).
4. S3: batch 2 (T-0504, T-0505) once S1 says go.

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
