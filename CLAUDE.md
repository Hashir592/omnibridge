# OmniBridge

OmniBridge is a multi-tenant SaaS back office for UK sellers on Amazon, eBay and their own website. It covers stock, orders, shipping labels, account health, Amazon Ads, profit and a VAT ledger. It is self-hosted on one shared netcup server in Germany.

## Start of every session

1. Read `docs/STATE.md` first.
2. Read your own rule file in `docs/sessions/`:
   - S2: `S2-frontend.md`
   - S3: `S3-builder.md`
   - S4: `S4-reviewer.md`
   - S5: `S5-security.md`
3. Read **only** these:
   - your task in `docs/backlog.json`
   - the PRD sections that task cites
   - the parts of `docs/ARCHITECTURE.md` that it touches

   Do not read the whole PRD unless your rule file says so.
4. If something you need is not written down, ask Hashir. Do not guess.

## Where things live

| Path | What |
|---|---|
| `docs/PRD.md` | Locked requirements (v1.2). Every requirement has an ID such as `TEN-1`. Owned by S1. |
| `docs/ARCHITECTURE.md` | Decided design and the **invariants**. Owned by S1. |
| `docs/DECISIONS.md` | Questions, ADRs, PRD change proposals. Other sessions add only to "Proposed (from sessions)". |
| `docs/plan/MODULES.md` | Module order and the owner of every ID. Owned by S1. |
| `docs/plan/requirements-index.md` | One line per ID; the coverage checklist. |
| `docs/backlog.json` | Tasks. Only S1 edits it, except that S3 or S2 may change the `status` of their own task. |
| `docs/STATE.md` | Current module, task, status, next step. Overwritten, never appended; under 100 lines. |
| `docs/sessions/` | Permanent rule files per session; `briefs/` holds kickoff briefs. |
| `docs/reviews/` | Checkpoint reports and findings. `security/` holds S5 audits. |
| `docs/handoffs/` | Every message between sessions, as `<YYYYMMDD-HHMM>-S<from>-to-S<to>.md`. |
| `docs/ops/` | Runbooks, secrets register, asset inventory. |
| `apps/` | `web` (API + SPA host), `ui` (React SPA), `worker`, `pii-vault`, `site` (public site). |
| `packages/` | `contract`, `core`, `db`, `pii-db`, `crypto`, `queue`, `governors/*`, `providers/*`, `logger`, `files`, `mail`, `testkit`. |
| `mocks/provider-mocks` | Mock Amazon, Ads, eBay, Evri, DPD and website servers. The only provider endpoints dev and CI may call. |
| `infra/` | Compose files, the shared edge project, host scripts, backup jobs, observability configs. |
| `scripts/verify.sh` | The single quality gate. |

## Quality gate

Run from the repo root (Git Bash on Windows; Docker Desktop must be running):

```bash
scripts/verify.sh
```

It runs:

- install with a frozen lockfile
- lint and format check
- typecheck
- architecture rules (dependency-cruiser)
- unit, integration (real PostgreSQL), contract and end-to-end tests
- build
- secret scan (gitleaks)
- dependency audit
- container-limit check
- hard-coded-name check
- requirement-ID coverage check

It must pass completely before any merge, and **CI is where the full gate runs** (ADR-054). Locally, use `scripts/verify.sh --quick`, plus the integration tests your task touches for high-risk tasks. A task is done only when the full run passes in CI.

## Conventions

- **Branches:** `task/<task-id>-<short-slug>`, for example `task/T-0101-walking-skeleton`.
- **Commits:** Conventional Commits, with the PRD IDs in a footer, for example `feat(auth): lock account after 10 failures` followed by `Refs: USR-5, AT-3`.
- **Merging:** only through a pull request to `main`. Merging needs no wait for Hashir: the session that opened it merges it itself (`gh pr merge --merge --delete-branch`) once CI is green and its tier's checks passed (ADR-053, Hashir 12 Nov 2026). If CI is red, it fixes the branch and then merges. Never merge on red, never force-push, never push to `main`. Hashir's "go" before implementing a high-risk task stays.
- **Tests:** every test title cites the IDs it proves, for example `it('[VAT-3] rounds once per rate group', …)`. Write tests **first** for money, VAT, deletion, tenancy and permissions.
- **Task IDs:** a task's `prd_ids` lists only IDs its module owns. IDs it only helps with go in `supports` (ADR-027).
- **Handoffs:** a message for another session is printed in chat as a fenced block headed exactly `PASTE INTO SESSION <N>`. It is also saved to `docs/handoffs/<YYYYMMDD-HHMM>-S<from>-to-S<to>.md`. Sessions never talk directly; Hashir carries the messages. When a ruling changes a session's rule file or files it uses, S1 sends that session a short note.
- **Showing Hashir work (his rule, 20 Oct 2026):** when anything is ready on localhost, give the working links unasked, as an ordered table in click-through order: link, what to enter, what he should see. State synthetic demo values (mock emails, passwords, 6-digit codes) inline in chat; never "open a file to find them". Never show a real secret.
- **Proposals:** to change the PRD, ARCHITECTURE, MODULES or backlog, write a proposal under "Proposed (from sessions)" in `docs/DECISIONS.md`. Keep working within your current scope. Only S1 edits those files.
- **Units:** money is integer pence. Times are stored in UTC and shown in Europe/London. UI dates use DD/MM/YYYY.

## Invariants (summary; the numbered list with checks is `docs/ARCHITECTURE.md` §5, and code and reviews cite those numbers)

- Every tenant table has `workspace_id`, forced row-level security and composite `(workspace_id, id)` foreign keys.
- The app connects as `ob_app`, which has no BYPASSRLS. Every request runs in one transaction, and every job in short ones (never across a provider call), with `SET LOCAL app.workspace_id` / `app.company_ids`. Every repository call takes a `TenantContext`.
- Every contract route declares `auth`, `tab`, `adminOnly` and company scoping. The route walker proves isolation on every route.
- "Combined" means the user's **permitted** companies only.
- No PII in job payloads, job results, idempotency records or webhook inboxes: IDs and `pii_ref` only (ARCHITECTURE 7a).
- Buyer PII exists only in `db-pii`, behind `pii-vault`. It never appears in db-main, logs, metrics, error events, exports, emails, notifications or main backups.
- pii-vault access is capability-scoped: ingest, read-full (logged), mask, search, delete. Masked strings are never stored.
- PII fields are encrypted with AES-256-GCM, using per-workspace data keys under a master key that never sits in a database, an image or a backup.
- Deletion is a hard DELETE plus VACUUM. Tombstones are re-applied after every restore. Label files are PII and are never backed up.
- Money is `bigint` pence with no floats. Rounding is half-up only where the PRD says. Order-line snapshots (VAT, COGS) are immutable.
- Provider APIs are called only from `packages/providers`, through the queue and governors. Web handlers make no provider calls except OAuth code exchanges.
- The Amazon and eBay governors are separate code paths with no shared retry helper. The eBay budget is counted **before** each send.
- Every job carries the workspace, channel account, idempotency key and attempt count. Handlers are idempotent.
- The kill switch and maintenance switch are checked in the outbound pipeline, just before each write.
- Every OmniBridge container has memory, CPU and PID limits, and joins only OmniBridge networks.
- Migrations are forward-only and expand/contract, and must be safe with the previous app version still running.

## Never

- Never use real customer data. Never put production secrets, tokens or keys in the repo, chat, logs or test fixtures. Never call live Amazon, Ads, eBay, Evri or DPD endpoints from development or CI.
- Never put buyer PII anywhere except the PII database.
- Never hard-code a workspace, company or account name. Jeez, Sidson, Kyyz and JeezMart exist only in seed files.
- Never add a dependency without an ADR line in `docs/DECISIONS.md` giving its version, licence, reason, and RAM if it is a service.
- Never weaken, skip or delete a test, or disable a lint or type rule, to get a green build.
- Never work outside the current task's scope. Note follow-ups instead.
- Never scrape or automate a marketplace or carrier website.

## When in doubt

Write the uncertainty down in your report. If it blocks you, stop and ask Hashir. S1 settles design disputes.
