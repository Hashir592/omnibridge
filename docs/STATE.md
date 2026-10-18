# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 18 Oct 2026 by S3.

## Now

- **Phase:** B. Building M01 on local Docker (ADR-029).
- **Current module:** M01 Platform foundations (local Docker only)
- **Current task:** T-0101 Walking skeleton. Status: `review` (PR open, waiting for green CI and Hashir's merge).
- **Next task after it:** T-0102 Contract pipeline (normal), then T-0103 Envelope crypto (**high**: wait for Hashir's "go").
- **Last checkpoint:** none yet. M01 halfway checkpoint comes after T-0103.
- **Open findings:** none from S4. Self-review of T-0101 (/code-review, because the CodeRabbit CLI is not installed): 9 fixed, 1 deferred (CI image cache).
- **Open questions:** PS-001 to PS-005 in `docs/DECISIONS.md` "Proposed (from sessions)" wait for S1 (PS-004 lefthook 2.2.1 and PS-005 pnpm policies are already applied with Hashir's approval). Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

## Delivery model

Local-first (ADR-029): everything is built and tested on local Docker with mocks; servers arrive only in M22 Deploy, near the end. Local containers keep the production limits.

## What T-0101 delivered

- pnpm 12.14.0 monorepo in the ARCHITECTURE.md §3 layout; stub packages have one export and one test.
- Stack (`infra/compose/compose.yaml` + `compose.dev.yaml`): web, worker, pii-vault, site, db-main, db-pii, migrate jobs, caddy, mailpit, provider-mocks, and clamd under the `scan` profile. Every service is limited and health-checked.
- `scripts/verify.sh` is the full gate (`--quick`, `--help`). Local run: 513 s. First CI run of the gate on GitHub: 4 min 4 s.

## Next step

1. Hashir reviews and merges the T-0101 PR after CI is green. S3 never merges.
2. S1 rules on PS-001 to PS-005 and amends ADR-019 (lefthook 2.2.1).
3. S3 starts T-0102 after `/clear`.
4. S2 starts M03 once T-0102 is merged.

## Prerequisites outstanding (Hashir)

| Needed for | Item | Status |
|---|---|---|
| Code review | CodeRabbit CLI is not installed on this machine, so `/code-review` ran instead (ADR-030) | open (optional) |
| Local full gate | WSL 2 has 3.8 GiB (host 7.9 GB, no `.wslconfig`); the full stack with clamd fits but is tight. 8 GB is recommended, which this host cannot give | open |
| Local tooling | Node 24.15 on the host; repo pins 24.22.0 (warning only). corepack needs `COREPACK_HOME` on drive D: (EXDEV error) | open |
| M22 (deploy, near the end) | netcup VPS 2000 G12.5 + failover IPv4; VPS 1000 G12.5 (staging) | open |
| M22 | GoDaddy DNS for `omnibridge.co.uk`, `www`, `app`, staging hostnames | open |
| M22 | Backblaze B2 account (EU Central); Scaleway TEM account; UptimeRobot free account | open |
| M06 | Zoho Mail Lite (2 users + aliases); Operator legal name, number, address | open |

## Plan diagram

Lucid: https://lucid.app/lucidchart/f5dc0dc1-254a-47c4-959c-0b27cb5ca1fc/view (pages: build plan A to Z, task loop, what runs on localhost)

## Key files

`CLAUDE.md` · `docs/PRD.md` (v1.3) · `docs/ARCHITECTURE.md` · `docs/DECISIONS.md` · `docs/plan/MODULES.md` · `docs/backlog.json` · `docs/sessions/` · `README.md` (Run locally) · `docs/ops/github-settings.md`
