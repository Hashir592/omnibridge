# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 18 Nov 2026 by S3 (M04 halfway fixes).

## Now

- **Phase:** B, local Docker only. Plan of 12 Nov 2026 (ADR-054): three releases, order in `docs/plan/MODULES.md`.
- **Closed:** M01, M02 (S4 M02 end APPROVED, ADR-064), M03. M06 site pieces merged; waiting on the client's legal details.
- **M04 batch 1 (S3) done; halfway checkpoint reviewed (S4), fixes in a PR:** report `docs/reviews/M04-halfway-report.md`.
  - picomatch audit: PR #80 merged. No fixed release exists, so there is a time-boxed exception in `scripts/lib/audit-exceptions.json` (GHSA-fc5q-39xc-vjpf only, **expires 1 Dec 2026**, then the gate goes red again). **PS-026 open for S1.**
  - T-0401 M02 carry-overs: PR #81 merged. Migrations 0021 (admin-only member writes in the DB, job company scope, one-call invite + password), 0022, 0023 (drop of the 0020 functions, ADR-063). db-main max_connections 45; caps ≤ max − 5 on both clusters (vault_app cap 6).
  - T-0402 vault core: PR #82 (auto-merge). db-pii 0002; pii-vault API (ingest, expiry, read-full, mask, search, match); `@omnibridge/vault-client`; tokens `vault_token_web|worker|deletion`; AT-9 marker scan in testkit.
  - T-0403 deletion service: PR #83 (auto-merge, stacked on #82). Vault `/v1/delete`, journal volume `pii_journal`, db-pii 0003, db-main 0024, worker jobs `pii.delete`, `pii.expiry`, hourly `pii.expiry-sweep`, entry point `requestDeletion` (all seven DEL-1 triggers), deletion certificate route, terms acceptances deleted with the person.
- **Review (S4, 18 Nov 2026):** M04 halfway round 1 was FIX REQUIRED (1 Major, 4 Minors). **All five fixed** on `task/M04h-fixes` (ADR-065): first-admin invite works again (TEN-7 test through the route), `delete_after` bounded, VACUUM on retry, keys on ingest only plus the closed marker (db-pii 0004, ingest 409), phased job handlers (deletion's vault loop outside db-main transactions). Carry-over for the M04 end: `docs/reviews/M04-halfway-carryover.md`.
- **After pulling:** run `scripts/dev-secrets.sh` (three new vault tokens). For db-main max_connections 45, restart db-main (compose passes `-c max_connections=45`). An existing db-pii volume keeps vault_app's old cap 8: run `ALTER ROLE vault_app CONNECTION LIMIT 6` or recreate it.
- **Speed (ADR-056):** never wait for CI (auto-merge); one review per PR; trivial lane; browser only when it proves something; short sessions.
- **Process (ADR-053, ADR-054):** sessions merge their own green PRs; CI is the only full gate.
- **Hashir:** GitHub CLI on Hashir592. Dev machine to 16 GB in 1 to 2 weeks.

## M04 plan (S1, 17 Nov)

- Batch 1 (S3): done (above). Halfway fixes: PR on `task/M04h-fixes`. **Now: batch 2.**
- Batch 2: T-0404 erasure/access requests and eBay deletion (S3, high), T-0405 backups, restore drill and marker scan (S3, high), T-0308 screens (S2), then T-0406 S5 audit, then the S4 M04 end review.

## Follow-ups noted

- **PS-026 (S1):** confirm the expiring audit exception mechanism; when picomatch ships a fix, bump it and delete the entry (before 1 Dec 2026).
- **T-0404:** erasure and the eBay deletion notice resolve identifiers to refs with a logged vault `search` (web), then `requestDeletion` with `refs` (no PII in jobs, FA-14). The eBay webhook (`apps/web/src/webhooks/ebay.ts`) still only logs a receipt; EBAY-2 says "200", it answers 204.
- **T-0405:** ship the `pii_journal` volume off-site; the restore runbook re-applies `app.pii_tombstones`, `vault.tombstones` and the journal; the marker scan (`scanDatabaseForMarkers`) runs on dumps.
- **M10:** ingest is not idempotent per subject (a retried ingest makes a second record): key buyer records by order. Call `requestDeletion` on cancellation; set `delete_after` at dispatch/delivery + pii_expiry_days (the vault defaults to a 90-day backstop).
- **M05:** workspace closure calls `requestDeletion({trigger:'workspace_closure'})`, then `DeletionLog.deleteUserTerms` for people left with no workspace. Audit event when the console switches a module (T-0211).
- **M07 / M08:** Amazon revocation and eBay termination call `requestDeletion` with the channel account.
- **M12:** the vault's `LabelFiles` hook deletes label files with their records.
- **Queue runtime:** phased handlers exist now (`PhasedHandler`, F-M04h-05); SMTP mail jobs and M07 provider jobs should use them for their network half.
- **PII key rotation:** decrypt by the stored `data_key_version`; a re-wrap job for the pii keyring.
- F-M02e-01 residual: `MembershipRepository.add` is a system write (dev seed and tests only, guarded by a source-scan test).
- Not reproduced: `auth.int.test.ts` flood test failure on S4's machine (passes under 8x CPU stress); the assertion now names any stray status.
- M22: production `APP_ORIGINS`, `APP_ORIGIN`, SMTP (`SMTP_ALLOW_PLAIN=0`), `TRUSTED_PROXIES`. Role creation (`10-roles.sh`) is part of the deploy.
- Later: very large audit exports as a background job. M07: provider jobs must not hold a tenant transaction across network calls.

## Next step

1. S3: halfway fix PR merges itself on green; then T-0404, then T-0405 (one PR each).
2. S2: T-0308 screens. Then T-0406 S5 audit, then S4 M04 end review (with the carry-over file).

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
