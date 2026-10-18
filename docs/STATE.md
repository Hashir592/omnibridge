# STATE

This file is overwritten at each update, never appended. Keep it under 100 lines. Last updated: 18 Oct 2026 by S1.

## Now

- **Phase:** B (sessions being set up). The plan is approved after outside review round 2.
- **Current module:** M01 Platform foundations (local Docker only)
- **Current task:** T-0101 Walking skeleton. Status: `todo`. Risk: normal.
- **Next task after it:** T-0102 Contract pipeline (normal), then T-0103 Envelope crypto (**high**: wait for Hashir's "go").
- **Last checkpoint:** none yet. M01 halfway checkpoint comes after T-0103.
- **Open findings:** none
- **Open questions:** none. Q-001 is answered.

## Delivery model

Local-first (ADR-029): everything is built and tested on local Docker with mocks; servers arrive only in M22 Deploy, near the end. Local containers keep the production limits.

## Next step

1. S3 has the kickoff brief and the additions (`docs/handoffs/20261018-1522-S1-to-S3.md`). The kickoff brief is written (`docs/sessions/briefs/S3-kickoff.md`, handoff `docs/handoffs/20261018-0244-S1-to-S3.md`). Hashir pastes it into Session 3.
2. S3 builds T-0101.
3. S2 starts M03 (design system) once T-0102 is merged. S1 writes the S2 brief at that point.

## Prerequisites outstanding (Hashir)

| Needed for | Item | Status |
|---|---|---|
| T-0101 | Code review: CodeRabbit plugin/CLI, else `/code-review` (ADR-030) | fallback in place |
| T-0101 CI run | GitHub repo `Hashir592/omnibridge` (gh account Hashir592). Branch protection on a free private repo is not enforced, so the rule is procedural: S3 never merges, Hashir merges after green CI | repo ready |
| M22 (deploy, near the end) | netcup VPS 2000 G12.5 + failover IPv4; VPS 1000 G12.5 (staging) | open |
| M22 | GoDaddy DNS for `omnibridge.co.uk`, `www`, `app`, staging hostnames | open |
| M22 | Backblaze B2 account (EU Central); Scaleway TEM account; UptimeRobot free account | open |
| M06 | Zoho Mail Lite (2 users + aliases); Operator legal name, number, address | open |

## Plan diagram

Lucid: https://lucid.app/lucidchart/f5dc0dc1-254a-47c4-959c-0b27cb5ca1fc/view (pages: build plan A to Z, task loop, what runs on localhost)

## Key files

`CLAUDE.md` · `docs/PRD.md` (v1.3) · `docs/ARCHITECTURE.md` · `docs/DECISIONS.md` · `docs/plan/MODULES.md` · `docs/backlog.json` · `docs/sessions/`
