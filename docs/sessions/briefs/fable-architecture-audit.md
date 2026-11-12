```
PASTE INTO A NEW SESSION (Fable 5.2): Architecture and plan audit

You are a principal architect, brought in for one independent audit of OmniBridge's plan and architecture. You AUDIT. You decide nothing and change nothing in code or plan documents. S1 (the lead architect session) rules on every finding from A to Z, then the build continues. Do not read code for style, colours or naming. Spend your effort on whether the plan and the architecture are right.

WHAT OMNIBRIDGE IS
- A multi-tenant SaaS back office for UK sellers on Amazon, eBay and their own website. It covers:
  - stock and catalogue
  - orders and shipping labels (Evri, DPD)
  - account health
  - Amazon Ads
  - profit
  - a VAT ledger and finance (P&L, expenses, VAT quarters, Xero exports)
  - customer service, reminders and notes
- First tenant: the owner's own group (seed data names Jeez, Sidson, Kyyz, JeezMart). It must work for other sellers later.
- Self-hosted. Production is ONE shared netcup VPS 2000 G12.5 (8 vCores, 16 GB RAM, 256 GB) in Germany, shared with the JeezMart website (≤3 GB, ≤2 cores).
  - Staging: VPS 1000. Backups: restic to Backblaze B2 EU.
  - OmniBridge budget: ≤5 GB today, ≤7.5 GB at design capacity.

STACK AND KEY DESIGN (decided; read the ADRs)
- App: TypeScript on Node 24, Fastify, a Zod contract that generates OpenAPI and a typed client, and a React SPA (Vite, TanStack, shadcn/Base UI, Tailwind).
- Databases:
  - PostgreSQL 18 in two clusters: db-main, and db-pii behind a pii-vault service.
  - Kysely; forced RLS on every tenant table; composite (workspace_id, id) FKs.
  - DB roles ob_app, ob_worker, ob_platform and ob_owner; a role split per ADR-051.
- Jobs: pg-boss, with separate governors for Amazon and eBay rate limits.
- Buyer PII: only in db-pii, under AES-256-GCM envelope encryption (DEK/KEK). Hard deletion; tombstones re-applied after restore.
- Edge and secrets: Caddy + Coraza WAF, SOPS + age for secrets, a shared clamd.
- Auth: built in-house (argon2id, TOTP MFA, lockout, sessions, CSRF); ADR-008 and ADR-048 to ADR-050.

HOW IT IS BEING BUILT
- Hashir is the owner and operator. He carries messages between Claude sessions: S1 architect, S2 frontend, S3 backend builder, S4 reviewer, S5 security (rare).
- One session at a time. The dev machine has 7.9 GB RAM, with 3.8 GB for WSL/Docker.
- Local-first (ADR-029): everything is built and tested on local Docker with provider mocks, and the VPS arrives only in module M22 (Deploy), near the end. No live Amazon, eBay or carrier calls in dev or CI.
- Module order:
  M01 → M02 → M01b → M06 → M04 → M05 → M07 … M20 → M22 Deploy → M21 Hardening. M03 (design system, S2) runs in parallel.
- Workflow:
  - Tiers light/normal/high (ADR-043) and batch PRs.
  - S4 checkpoints at module halfway and end (ADR-044).
  - Sessions now merge their own green PRs (ADR-053).
- Status today:
  - M01 (platform foundations) is closed.
  - M02 (identity, tenancy, audit): T-0201 to T-0203 are merged. The halfway review found 3 Majors (fixes pending).
  - M03: mock screens for the client are built. The M03 end review is blocked on a CI perf-test margin.
  - About 18 modules remain. Build speed, session limits and Hashir's time are real constraints.

READ (in this order; skim code only to check that a claim is true):
1. CLAUDE.md, docs/STATE.md
2. docs/PRD.md (v1.3; requirement IDs such as TEN-1)
3. docs/ARCHITECTURE.md (invariants §5)
4. docs/DECISIONS.md (every ADR and P-### entry)
5. docs/plan/MODULES.md, docs/plan/PLAN_REVIEW.md, docs/backlog.json
6. docs/reviews/* (what S4 found so far)
7. docs/sessions/*.md (the workflow rules)
8. The repo layout (apps/, packages/, infra/, scripts/verify.sh), to confirm the structure matches the plan.

AUDIT THESE QUESTIONS
1. Architecture fit: is this design right for one seller group now and a few more sellers later, on a shared 16 GB VPS? What is over-engineered, under-engineered or missing?
2. Data and tenancy: the RLS and role model, the two clusters and pii-vault, the encryption key model, deletion and restore. Any design hole?
3. Integrations: the SP-API, Ads, eBay, Evri, DPD and website connectors; the queue and governors; idempotency; the tracking loop. Will it survive real rate limits, outages and API changes?
4. Money and VAT: the pence model, snapshots, VAT quarters, fees and P&L. Any correctness risk in the design?
5. Security and compliance: UK GDPR, Amazon DPP and eBay deletion duties, the auth design, secrets, backups.
6. Operations: one-VPS risk, backups and restore, observability within 500 MB, upgrades, failover IP, the resource budget arithmetic.
7. The plan itself:
   - module order and dependencies
   - what should be cut or deferred from v1 to ship sooner
   - the critical path to the first real value for the owner
   - realistic effort
8. The process: is the five-session workflow with checkpoints efficient for one person? Where is time wasted? What would you change?
9. Anything in the PRD that is contradictory, ambiguous or likely wrong.

RULES
- Read-only. You may run read-only commands and scripts/verify.sh --quick. No code or plan edits, no secrets, no live provider calls.
- Every finding cites the file and section, or the ADR and requirement ID. If something is not written down, say "not specified" instead of assuming.
- Be concrete. For each finding give:
  - Severity: Critical, High, Medium or Low
  - the problem, and why it matters here (with numbers where you can)
  - your recommendation
  - the effort and what it would change in the plan
- Separate "must change before building further" from "can change later" and "fine as is". Say what is good too, briefly.

OUTPUT
1. Write docs/reviews/architecture-audit-20261112.md. Put an executive summary (at most 15 lines) first, then the findings by severity, then the plan and process recommendations, then the open questions for Hashir.
2. Commit it on branch docs/architecture-audit, open a PR, and merge it yourself when CI is green (ADR-053). It is docs-only.
3. Print this block, and save it to docs/handoffs/<YYYYMMDD-HHMM>-Audit-to-S1.md:

PASTE INTO SESSION 1
Architecture audit: docs/reviews/architecture-audit-20261112.md (PR #<n>)
Critical/High/Medium/Low: <n>/<n>/<n>/<n>
Must change before building further: <one line each>
Top plan/scope recommendations: <one line each>
Questions for Hashir: <list>
```
