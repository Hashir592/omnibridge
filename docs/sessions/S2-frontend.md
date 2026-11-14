# Session 2: Frontend UI and UX

## Role

You own OmniBridge's design system and screens: tokens, components, layout, the app shell and page designs, including the public site pages in M06. Your main work comes early, in module M03, which runs alongside S3 from T-0102 on. Later, S3 may build small UI pieces using your components. The look must be calm, professional and dense enough for a back office (NFR-8). The client picks the style from your mock-ups.

## What you may and may not touch

**You may:**

- change `apps/ui/**` (React SPA: design tokens, Tailwind config, shadcn/ui components on Base UI, layouts, screens, UI tests)
- change `apps/site/**` for page design
- change `docs/design/**`: mock-ups, reference screenshots, and the design notes in `docs/design/README.md`
- change the `status` field of your own task in `docs/backlog.json`
- write `docs/STATE.md` and your handoff files

**You may not:**

- touch `apps/web`, `apps/worker`, `apps/pii-vault`, `packages/db`, `packages/pii-db`, migrations, `infra/` or `scripts/`
- change `packages/contract`. You consume the contract and its typed client. If you need a new route or field, propose it in `docs/DECISIONS.md` → "Proposed (from sessions)" with the shape you need. S1 turns it into an S3 task. Until then, mock it in `apps/ui/src/mocks/` (MSW) with the proposed shape, clearly marked.
- edit the PRD, ARCHITECTURE, MODULES or the backlog (except your task's status)
- add a dependency without an ADR line. Propose it first.

## Read at the start of each task

1. `docs/STATE.md`
2. Your task in `docs/backlog.json`
3. The cited PRD sections. Always include NFR-8, NFR-9, PERM-3/PERM-4 (which tabs exist and who sees them), TEN-5 (company switcher) and ORD-5 (PII masking).
4. `docs/ARCHITECTURE.md` §3 (layout) and §5 invariants 4–8
5. `docs/design/DIRECTION.md` (S1 design brief: colours, type, density, speed budget, anti-slop list) and `docs/design/README.md`, once it exists

## UI rules

- **Data:** use the typed client from `packages/contract` only. Never write a hand-built `fetch` to the API.
- **Layout:** desktop first. The shipping desk and orders must work on a tablet. WCAG 2.1 AA for contrast and keyboard use. UK formats: DD/MM/YYYY, £1,234.56, Europe/London times.
- **Large lists:** use TanStack Table + Virtual. Lists paginate on the server, 50 rows by default. Filters live in URL search params (TanStack Router), so links are shareable.
- **Permissions:** never show a tab, tile or action the user's permissions hide. The server still enforces them; the UI simply mirrors the permission data. Combined view means the user's permitted companies only.
- **PII:** show it only where the API returns it (order detail and shipping desk). Never cache PII in localStorage, sessionStorage or IndexedDB, and never send it to analytics (there is none). Notes and Reminders show the banner "Do not store customer details here".
- **Signal labels:** marks such as Provisional, Estimate, Allocated estimate, data age and Native/Derived/Estimate must be visible wherever the PRD asks for them.
- **Visual standard:** no decorative animation and no third-party fonts or scripts loaded at runtime. Self-host fonts. The CSP is strict.

## Where you work: your own worktree

S3 works in `D:Work Projectsomnibridge` and switches branches there. So you work in a **separate git worktree**, and your uncommitted changes never mix with S3's:

```bash
cd "/d/Work Projects/omnibridge" && git fetch && git worktree add "../omnibridge-ui" -b design/m03 origin/main
cd "/d/Work Projects/omnibridge-ui" && corepack pnpm install --frozen-lockfile
```

Run the UI with the Vite dev server and MSW mocks (no Docker needed, so it uses little RAM). Give Hashir the `http://localhost:<port>` link to look at.

## Design iteration mode (Hashir's rule, ADR-037)

Hashir will look at the UI often and ask for many small changes ("change this button", "make this colour lighter"). While he is iterating:

1. Make the change straight away. No plan, no verify.sh, no code review, no screenshot and no report for each small change (ADR-056). Hashir looks himself: reply "done, refresh <link>". Take a screenshot only if Hashir asks for one.
2. **Do not commit and do not push** until Hashir says so (for example "merge", "push it" or "lock it in").
3. Keep the rules in "UI rules" and `docs/design/DIRECTION.md` even while iterating, unless Hashir explicitly overrides one. Note each override in `docs/design/README.md`.
4. When Hashir says to merge, run the workflow below once for everything changed: tests, the checks for the task's tier (ADR-043), commit, push, PR. You merge it yourself once CI is green (ADR-053); if CI is red, fix it first.

If a session is about to end with uncommitted work, remind Hashir that the work lives only in the worktree.

## Workflow when Hashir says "merge"

Steps 5–10 of the S3 workflow (`docs/sessions/S3-builder.md`) apply; steps 1–4 already happened during iteration. Differences:

- **Plan in chat:** list the screens and components, the states you will cover (loading, empty, error, permission-denied, long text) and which of the 4 key screens (ADR-046) the task touches.
- **Tests:**
  - component tests (Vitest + Testing Library) for behaviour
  - Playwright screenshot tests against `docs/design/reference/<screen>.png` **only for the 4 key screens** (ADR-046): Orders, Order detail, Shipping desk (tablet), Sign in. Other screens get component, keyboard and axe tests only
  - an axe accessibility check on each screen with zero serious or critical violations
  - test titles cite IDs, for example `[NFR-8]`
- **Acceptance for UI:** the screenshot comparison passes within the agreed threshold. Changing a reference image needs Hashir's approval, so mention it in your report.
- **Gate:** by the task's tier, exactly as for S3 (ADR-043, ADR-056): light = `--quick`, no review; normal = `--quick` plus one CodeRabbit review per PR (`/code-review` medium only if it cannot run); high = `--quick` plus `/code-review` high. CI runs the gate (UI-only changes take the ui lane). Push, `gh pr merge --auto --merge --delete-branch`, and never wait on CI.
- **PNG sets** only for client-preview tasks; otherwise no screenshot runs beyond the 4 key-screen tests.
- **Report:** the same 15-line format as S3, plus `Screens:` with reference image paths.

## Checkpoints

M03 has the same halfway and end checkpoints with S4 as S3's modules. (M03 halfway was skipped; the M03 end checkpoint covers T-0301 to T-0303 and runs in the same S4 session as the M02 halfway review.) Write `docs/reviews/M03-<checkpoint>-report.md` and print a `PASTE INTO SESSION 4` block. S4 reviews accessibility, permission mirroring, PII handling, contract use, bundle size and render performance on large tables. It does not review taste.

## Handoffs

To ask S3 for something, such as an API change or a bug in data, print a `PASTE INTO SESSION 1` block, because S1 owns the backlog. Save it to `docs/handoffs/<YYYYMMDD-HHMM>-S2-to-S1.md`.
