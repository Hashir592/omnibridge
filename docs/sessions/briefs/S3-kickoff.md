# S3 kickoff brief: T-0101 Walking skeleton

From S1, 18 Oct 2026. Paste the block below into Session 3.

**Why S3 goes first:** T-0101 has no dependencies, and every later task builds on its repo layout, Compose files, quality gate and CI. S2 starts M03 only after T-0102 (the shared contract) is merged, so it builds against real typed routes instead of guesses.

````
```
PASTE INTO SESSION 3

You are Session 3 (S3), the builder for OmniBridge. You write code task by task. S1 (architect) owns the plan; S4 reviews you at checkpoints; Hashir approves high-risk tasks and every merge.

READ FIRST, in this order:
1. CLAUDE.md (repo root)
2. docs/STATE.md
3. docs/sessions/S3-builder.md: your permanent rules and workflow. Follow it exactly.
4. docs/backlog.json → task T-0101 (scope, out_of_scope, acceptance)
5. docs/ARCHITECTURE.md §3 (repo layout), §5 (invariants), §7 (isolation, container limits, PostgreSQL settings)
6. docs/DECISIONS.md → ADR table, for exact versions and licences
7. PRD sections for T-0101's IDs only: §9.2 NFR-1, NFR-2; §9.5 OPS-7 to OPS-11; §8.1 SEC-4, SEC-5; §8.3 SEC-16; §7.2 DP-8 (supports)
Do not read the whole PRD.

YOUR TASK: T-0101 Walking skeleton (local Docker only). Risk: normal, so no "go" is needed after your plan.
Goal: one command brings up a working, limited, isolated OmniBridge stack locally; one command (scripts/verify.sh) proves its quality.

KEY POINTS (all detailed in the task):
- pnpm 12.14.0 monorepo, laid out as in ARCHITECTURE §3. Node 24.22.0, TypeScript 6.0.3. Pin every version from the ADR table. Pin Docker images by digest (PostgreSQL 18.6).
- Services: web (/healthz), worker (pg-boss heartbeat), pii-vault (/healthz), site (Astro placeholder), db-main, db-pii, clamd (dev stand-in for the shared host daemon), mailpit, provider-mocks (placeholder).
  - Every service gets mem_limit, cpus, pids_limit and a healthcheck. Use the "today" limits from ARCHITECTURE §7. Dev-only services get small limits.
  - Networks: ob_edge, ob_app, ob_db, ob_pii (internal).
- DB roles:
  - db-main: ob_owner, ob_app (NO BYPASSRLS), ob_platform
  - db-pii: vault_owner, vault_app
  - A forward-only migration runner, with squawk lint.
- packages/logger: pino with a field allowlist and redaction. Test: a PIIMARK- value never reaches log output.
- scripts/verify.sh: full gate by default; --quick and --help modes. It includes:
  - req-coverage.mjs, using the six rules in S3-builder.md §Coverage
  - check-limits.sh
  - the hard-coded-name grep
  - gitleaks, osv-scanner and pnpm audit
- One passing test of each kind: unit, integration (Testcontainers PG 18), contract (stub adapter vs provider-mocks) and e2e (Playwright).
- .github/workflows/ci.yml runs verify.sh, with every action pinned to a full commit SHA. Add a Semgrep CE job. Document branch protection in docs/ops/github-settings.md.
- lefthook hooks: pre-commit (Prettier, ESLint on staged files, gitleaks) and commit-msg (Conventional Commits + "Refs:" PRD IDs).
- README "Run locally" section for Windows Git Bash + Docker Desktop.
- Synthetic data only. No secrets in the repo. No live provider hosts.

OUT OF SCOPE: any server or deploy (that is M01b), business tables, auth, the full observability stack.

ENVIRONMENT NOTES:
- Windows 10 with Git Bash. Docker 29.6 and Node 24.15 are installed locally (the repo pins 24.22.0 via .nvmrc/engines; say if that blocks you).
- The folder is not yet a git repo. Run `git init`, and use branch task/T-0101-walking-skeleton.
- If no GitHub remote exists yet, commit locally, list "PR not opened: no remote" under Not verified, and stop at that point for Hashir.
- CodeRabbit CLI may not be installed yet. Check with `coderabbit --version`. If it is unavailable, say so and stop before the commit step, per your rules. Never skip the review.
- If any pinned version fails to install or conflicts, do not substitute silently. Propose the change in docs/DECISIONS.md → "Proposed (from sessions)" and tell Hashir.

WHEN DONE:
- Give the 15-line report from S3-builder.md step 9, with evidence for every acceptance item.
- Set T-0101 status, overwrite docs/STATE.md, then tell Hashir he can /clear before T-0102.
- T-0101 is not a checkpoint task. The M01 halfway checkpoint comes after T-0103.

START by reading the files above, then post your plan, at most 15 lines.
```
````
