# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 18 Oct 2026 by S3.

## Now

- **Phase:** B. Building M01 on local Docker (ADR-029).
- **Current module:** M01 Platform foundations (local Docker only)
- **Current task:** T-0102 Contract pipeline. Status: `review` (PR open on `task/T-0102-contract-pipeline`; full gate passed locally in 495 s). T-0101 is `done`.
- **Next task after it:** T-0103 Envelope crypto (**high**: S3 posts its plan and waits for Hashir's "go").
- **Last checkpoint:** none yet. M01 halfway checkpoint comes after T-0103.
- **Open findings:** none from S4. Self-review of T-0102 (/code-review, CodeRabbit CLI not installed): 7 fixed, 1 waits on S1 (PS-006), 1 cosmetic follow-up.
- **Open questions:** PS-006 in `docs/DECISIONS.md` (openapi-types 12.1.3; openapi-typescript's TypeScript ^5 peer warning; Intl instead of date-fns). Delete the `minimumReleaseAgeExclude` list after 25 Oct 2026.

## Delivery model

Local-first (ADR-029): everything is built and tested on local Docker with mocks; servers arrive only in M22 Deploy, near the end. Local containers keep the production limits.

## What T-0101 delivered

- pnpm 12.14.0 monorepo in the ARCHITECTURE.md §3 layout; stub packages have one export and one test.
- Stack (`infra/compose/compose.yaml` + `compose.dev.yaml`): web, worker, pii-vault, site, db-main, db-pii, migrate jobs, caddy, mailpit, provider-mocks, and clamd under the `scan` profile. Every service is limited and health-checked.
- `scripts/verify.sh` is the full gate (`--quick`, `--help`). Local run: 513 s. First CI run of the gate on GitHub: 4 min 4 s.

## What T-0102 delivers

- `packages/contract`: `defineRoute` registry with permission metadata (auth, tab, adminOnly, companyScoped), RFC 9457 `ProblemSchema`, `listQuery` (default 50, max 200) and `pageOf`. `/healthz` is the first registry route.
- `apps/web`: routes come only from the registry; startup fails on missing metadata, and any other route is refused.
- Committed `packages/contract/openapi.json` + `src/client/schema.ts`; `pnpm contract:gen` regenerates, the `openapi` gate step fails on drift.
- `@omnibridge/contract/client` (openapi-fetch) for apps/ui; example in `apps/ui/src/api.ts`.
- `packages/core`: London time helpers (`@omnibridge/core/time`), `Pence` stub, `cacheKey`/`companySetHash`, `ApiError`. `packages/testkit`: `walkRoutes` stub.

## Next step

1. S1 rules on PS-006. Hashir reviews and merges the T-0102 PR after CI is green. S3 never merges.
2. S2 starts M03 on the merged contract (`@omnibridge/contract/client`).
3. S3 posts the T-0103 plan after `/clear` and waits for Hashir's "go".

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
