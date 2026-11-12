# GitHub settings

Repository: `Hashir592/omnibridge` (private). Written by S3 in T-0101. Implements SEC-16 and Q-001.

## Merge rule for `main` (procedural)

A free private repository cannot enforce branch protection or rulesets, so the rule is kept by
process:

1. Nobody pushes to `main`. The only direct push was the one-time docs bootstrap commit
   (`docs: bootstrap planning documents from S1`), which Hashir approved.
2. Every change reaches `main` through a pull request from a `task/<task-id>-<slug>` branch.
3. **The session that opens a pull request merges it itself** (ADR-053, Hashir 12 Nov 2026), and only after:
   - the `ci / verify (full gate)` check is green, and the `ci / semgrep (code scan)` check is green;
   - the task's tier checks passed (ADR-043). S4 checkpoints remain the review evidence.
4. If CI is red, the session fixes the branch, then merges. Hashir can still stop or revert any PR.
5. Merge with "Squash and merge" or "Create a merge commit"; never with a force push.
6. Delete the task branch after merging.

## Optional upgrade: enforce it

On **GitHub Pro** (or a Team organisation), add a branch ruleset for `main` so the rule above is
enforced instead of procedural:

- Restrict deletions; block force pushes.
- Require a pull request before merging, with 1 approval, dismiss stale approvals on new pushes,
  and require approval of the most recent push.
- Require status checks to pass, with the branch up to date: `verify (full gate)` and
  `semgrep (code scan)`.
- Require conversation resolution.
- Do not allow bypass (including administrators).

## Other repository settings

- **Actions → General:** allow GitHub-authored actions only plus the pinned SHAs in
  `.github/workflows/ci.yml`; workflow permissions "Read repository contents".
- **Actions minutes:** a free private repo gets 2,000 minutes a month. CI cancels superseded runs,
  caches the pnpm store and Playwright browsers, and runs Semgrep only on pull requests.
- **Secret scanning / push protection:** turn on if the plan offers it; gitleaks runs in the
  pre-commit hook and in the full gate regardless.
- **Dependabot alerts:** on. Dependency updates still go through a task and an ADR line.
