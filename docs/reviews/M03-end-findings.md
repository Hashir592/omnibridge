# M03 end findings — round 1
Reviewed: T-0301, T-0302, T-0303 (PRs #7, #11, #19, plus #23 and #32 that touch the UI), `main` at `c753c60`. verify.sh: PASS in parts (see `docs/reviews/M02-halfway-findings.md`, "How I ran it": one e2e flake, then 39/39 on a rerun)
Acceptance re-run: 16/17 PASS, 1 FAIL (T-0303 ui-perf, F-M03-end-01)

From S4, 27 Oct 2026. Verdict round 1: **BLOCKED** (1 Blocker, 0 Majors); round 2: **APPROVED**, see the end of this file. Round 1 of at most 2 (ADR-044). I reviewed accessibility, permission mirroring, PII handling, contract use, bundle size and render performance, not taste (S2-frontend.md).

## How I ran it

- The same clean worktree and gate runs as the M02 halfway review. The UI part of e2e is the `ui` project (screenshots, axe, keyboard, flows: 35 tests) and `ui-perf`. Final e2e rerun: **39 passed**.
- Production build analysis of `apps/ui/dist` from that gate (gzip of every chunk).
- `playwright test --project=ui-perf --retries=0 --repeat-each=3 --workers=1` on an idle machine, and CI logs from `gh run view --log` for the numbers.
- Source scans of `apps/ui/src` for `localStorage`, `sessionStorage`, `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `window.open`, `document.cookie`.

## Acceptance re-run

| Task | Item | Result | Evidence |
|---|---|---|---|
| T-0301 | Hashir says the direction is locked | PASS | S2 report and PR #7 / rulings #8 (not testable by me) |
| T-0301 | `docs/design/README.md` lists every token | PASS | file present; tokens match the build (petrol accent, 56 px rows) |
| T-0301 | axe: zero serious or critical on each mock-up screen | PASS | `mockups.spec.ts` ×5 screens in e2e |
| T-0301 | screenshot test per locked screen | PASS | Orders, Order detail, Shipping desk (tablet), Sign in: Linux and Windows references exist and match (ADR-046 cut it to these four) |
| T-0301 | verify.sh exits 0 at merge | PASS | CI green on the merge commits |
| T-0302 | axe on `/__ui` and the shell | PASS | `kit.spec.ts` |
| T-0302 | keyboard-only walkthrough of shell, table, dialog | PASS* | passes alone 24/24; failed once under load (F-M03-end-04 / F-M02h-09) |
| T-0302 | `[NFR-9]` money, number and date cells | PASS | unit |
| T-0302 | 10,000 rows under 16 ms per frame | PASS (thin margin) | passes in every run of mine and in each green CI run; the margin is the problem, see F-M03-end-01 |
| T-0302 | initial JS under 200 KB gzip | PASS | **169.1 KB** (entry `index` 143.4 + `link` 20.7 + `truck` 4.7 + `clock` 0.4); all JS 228.0 KB in 31 chunks; CSS 8.1 KB |
| T-0302 | screenshot tests for the key screens it touches | PASS | as above |
| T-0302 | verify.sh exits 0 at merge | PASS | CI |
| T-0303 | axe on every auth screen | PASS | `auth.spec.ts` |
| T-0303 | route shapes recorded in DECISIONS.md | PASS | ADR-048 / PS-016 |
| T-0303 | 4 key screenshots only (ADR-046) | PASS | `docs/design/reference/` holds exactly those four, each in `-linux` and `-win32` |
| T-0303 | verify.sh exits 0 at merge | PASS | CI |
| T-0303 | `[NFR-8]` ui-perf passes 3 CI runs in a row, report shows p95 and the rAF gap | **FAIL** | F-M03-end-01 |

## Checked, no finding

- **MSW is out of the production bundle** (S2's Risk 2): no chunk of `dist/assets` contains `msw`, `mockServiceWorker` or `setupWorker`; `dist` holds no `mockServiceWorker.js`. `main.tsx` starts mocks only under `import.meta.env.DEV`, and `auth/no-mocks-in-app.test.ts` guards the source. Fixed by PR #23.
- **No gallery in the normal build:** neither `/__ui` nor "Ten thousand products" appears in `dist/assets`; the gallery route needs `import.meta.env.DEV` or `VITE_UI_GALLERY=1`.
- **Client safety:** no `localStorage`, `sessionStorage`, `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `window.open` in the app source. The QR code is drawn as inline SVG from a module matrix (no library, no HTML string). Cookies: the SPA reads only the non-HttpOnly `ob_csrf`; the session cookie is HttpOnly.
- **Contract use:** the auth screens go through the typed client (`apps/ui/src/auth/api.ts`, `createApiClient`) with the CSRF header, and sign-in clears the query cache. The dependency-cruiser rule `ui-uses-contract-client-only` passes. The other screens read the MSW-backed `mockApi`, as designed until S3 builds the routes (ADR-042).
- **PII:** the mock lists carry masked buyers only and the order detail logs the full view (ORD-5); the real enforcement is server-side and not built yet.
- **Permission mirroring:** tabs and companies follow the mock persona; nothing in the SPA is trusted for access (the server checks, SEC-3).
- **Accessibility:** zero serious or critical axe violations on every screen and state tested; dialog, sheet and confirm are keyboard-operable (modulo the flake).

## F-M03-end-01 — Blocker — The T-0303 acceptance "ui-perf passes 3 CI runs in a row" is not met, and CI has no safety margin
Area: 6 Performance and memory / 8 Requirement coverage  IDs: NFR-8
Evidence: Acceptance item (backlog, T-0303): "ui-perf passes 3 CI runs in a row; the report shows work-per-frame p95 and the rAF gap". I read the p95 from the CI logs (`gh run view --log`) of every full-gate run since T-0203:

| CI run | What | p95 table work | Result |
|---|---|---|---|
| 39606103578 | PR #31 (T-0203) | 14.28 ms | pass |
| 39607894842 | main, merge of #31 | **16.20 ms** | **fail** |
| 39612058244 | PR #32 (the fix) | **15.99 ms** | pass, by 0.01 ms |
| 39613666934 | main, merge of #32 | 13.17 ms | pass |

So there are two green runs after the fix, not three, and one of them passed by a hundredth of a millisecond. My own numbers: 8.09, 8.42 and 8.84 ms on an idle machine (`--retries=0 --repeat-each=3`), but **15.40 ms** inside the gate while the Docker stack was running (a pass, barely) and 11.38 ms on the rerun. The measured quantity is the main thread's script + style + layout time per frame, which depends on the speed of the machine it runs on. The budget is 16 ms and must not change (ADR-046: "change the measurement, never the budget"), so as it is built the test will fail on some CI runs and on slow days locally; the retry that CI uses hides a failure but does not remove it. Under the module-end rules an unmet acceptance item is a Blocker.
Required fix: (S1 to rule if the route is the measurement.) Either of these, then show 3 green CI runs in a row (rerunning the same commit counts) with the p95 and the gap printed from the log:
1. Make the table do less per frame, so CI's p95 sits at 10 ms or less. The table is the only thing the test measures.
2. Change the measurement, not the budget (ADR-046): run a fixed reference workload in the same page just before the scroll (for example a known script-and-layout loop that takes about 4 ms on the dev machine), and fail when `workP95 / reference` is above the ratio the dev machine passes with, so a slow runner scales both sides. Report both numbers.
In both cases print the p95 on pass and fail (already done) and keep `retries` at CI's value only if the first attempt is also reported.
Resolution: Ruled by ADR-054 (FA-18): ui-perf is no longer a blocking gate. It stays a local benchmark and runs only on request (`OB_UI_PERF=1 npx playwright test --project ui-perf`), so CI and the default local run leave it out (`playwright.config.ts`). The gate now checks render work by counting: `kit/table/DataTable.test.tsx` `[NFR-8] a 100-row page renders only the visible rows, and a parent re-render renders none` (at most 20 rows drawn for a 100-row page, 0 cells redrawn on two parent re-renders). Writing that test found a real cost: the column layout depended on the table object, which is new on every render, so every parent re-render redrew all visible rows; `DataTable.tsx` now reads the table through a ref in the layout memo. (S2, 14 Nov 2026, branch task/M03-end-fixes)

## F-M03-end-02 — Minor — The perf build, which includes the component gallery, is written inside `apps/ui/dist`
Area: 9 Invariants (ADR-046)  IDs: NFR-8
Evidence: `playwright.config.ts:80` builds the `ui-perf` server with `vite build --outDir dist/perf --emptyOutDir`. After any test run `apps/ui/dist/perf/` exists (index.html plus assets, 31-chunk build with `VITE_UI_GALLERY=1`) inside the folder that M22 will deploy. ADR-046 says the gallery must never reach a deployable build; the M22 check is still to be written, and today's layout makes it easy to deploy `dist` with the gallery in it after a local test run.
Required fix: Write the perf build to a path outside `dist`, for example `apps/ui/.perf-build` (git-ignored) or `.verify/ui-perf`, and update `playwright.config.ts` and `.gitignore`; keep the M22 "no gallery in dist" check on the list.
Resolution: The perf build is written to `apps/ui/.perf-build` (git-ignored), never inside `dist`, and only when ui-perf is asked for (`playwright.config.ts`, `.gitignore`). The M22 "no gallery in dist" check stays on the list. (S2, 14 Nov 2026)

## F-M03-end-03 — Minor — The "Mock persona" switcher and the mock session ship in the production bundle
Area: 2 Tenancy / 4 Security (permission mirroring)  IDs: PERM-3, PERM-4
Evidence: `components/Shell.tsx:182-208` renders "Mock persona (mock-ups only)" with an admin/packer selector, and the string is in `index-BIVxfs3E.js`, the entry chunk. `app/session.tsx` builds the signed-in state from `mockApi.session`. Server checks remain the real gate, so it grants nothing, but a deployed build would show every user a switcher and fake data.
Required fix: Until the real session route exists, render the switcher only when `import.meta.env.DEV`, and add to the M22 build check that `Mock persona` and `mocks/` are absent from `dist`. S2 swaps `mockApi.session` for the typed client when T-0204 exposes it.
Resolution: The persona switcher renders only when `import.meta.env.DEV`; production builds show the signed-in user without it (`Shell.tsx`, `SignedInUser`). Checked: a production build contains no "Mock persona" string. The M22 build check for "Mock persona" and `mocks/` in `dist` stays on the list; the swap from `mockApi.session` to the typed client waits for T-0204. (S2, 14 Nov 2026)

## F-M03-end-04 — Minor — The keyboard focus test is a race (same as F-M02h-09)
Area: 8 Requirement coverage  IDs: NFR-8
Evidence: `apps/ui/e2e/kit.spec.ts:39-50`: failed once in my full gate, passed 24/24 alone; details in `docs/reviews/M02-halfway-findings.md`, F-M02h-09.
Required fix: Poll instead of a one-shot check (see that finding). One fix covers both.
Resolution: `kit.spec.ts` now polls after each Tab with `expect.poll(() => dialog.evaluate(...)).toBe(true)`; the assertion is unchanged. This also closes F-M02h-09. (S2, 14 Nov 2026)

## Follow-ups (not findings)

- The footer links (Privacy, Terms, Help) are dead until M06 (S1 ruling, S2 Risk 4).
- `ui-perf` could print its p95 into the CI step summary as well as the log, so the three-run evidence is easy to read.
- When S3 builds the order, home and shipping routes, the swap from `mockApi` to the typed client is per function; the walker test for company/tab leakage must cover each.

## Round 2 (S4, 14 Nov 2026) — Verdict: **APPROVED** (0 Blockers, 0 Majors, 2 Minors carried)

Reviewed `main` at `309923e` (PR #42 merged as `31672c6`). Gate evidence per ADR-054/056 is the CI run of the PR head `e7bbfcf` (run 43590559912): all jobs green, unit 283, integration 117, e2e 81 passed; `main` at `309923e` is green too (the push run at `31672c6` was cancelled by the next merge, not failed). I re-ran the fixes myself in a clean worktree; I did not re-run the whole local gate (ADR-054: CI is the gate).

| Finding | Result | Evidence |
|---|---|---|
| F-M03-end-01 (Blocker) | **Closed by ruling** | The acceptance item was amended by its owner: ADR-054/FA-18 and `docs/backlog.json` now read "ui-perf is a local benchmark only; a unit test checks that a 100-row page renders within a fixed render count". That is a ruling by S1, not a weakening by S2; the 16 ms budget text is untouched in the benchmark. I checked the replacement test catches what it claims (below). |
| F-M03-end-02 | Fixed | `.perf-build` is git-ignored and written only on `OB_UI_PERF=1`; after a production build `apps/ui/dist` holds `assets` and `index.html` only; no `.perf-build` appears from a normal run; `playwright test --list` shows 0 `ui-perf` tests by default. |
| F-M03-end-03 | Fixed for the switcher | `grep "Mock persona" apps/ui/dist` finds nothing; no `mockServiceWorker`/`setupWorker` either. Production shows the signed-in user with Admin or Child (PERM-1). Residual: see F-M03-r2-01. |
| F-M03-end-04 | **Mostly fixed** | `expect.poll` is in place and the assertion is unchanged. My runs of the fixed code: 24 (1 failed), 12, 24 and 30 (with 4 workers) passed, so 1 failure in 90 runs. See F-M03-r2-02. |

**The new gate test is real.** `DataTable.test.tsx` "[NFR-8] a 100-row page renders only the visible rows, and a parent re-render renders none" passes on main (10/10 in the file). I broke the code two ways and it failed both times:
- With `DataTable.tsx` as it was before PR #42 (`ac3c603`): `expected 30 to be +0` (30 cells redrawn on two parent re-renders). So the test finds the very cost S2 fixed.
- With the virtualiser overscan raised from 4 to 200: `expected 100 to be less than or equal to 20` (and a second assertion at 212 > 60 in the other table test).
Counting renders gives the same answer on a fast laptop and a loaded runner, which was the point of F-M03-end-01. What it does not prove is frame time on a real page; that is now S1's accepted trade (a local benchmark remains).

### F-M03-r2-01 — Minor — The production SPA still gets its session from the mock route
Area: 8 Requirement coverage  IDs: PERM-1
Evidence: `apps/ui/src/app/session.tsx:25` uses `mockApi.session`, which calls `GET /api/mock/session` (`mocks/api.ts:36`); `dist/assets/api-*.js` contains `mockApi`. With MSW out of the bundle, a production build would find no such route. This was already known (S2: "waits for T-0204") and grants nothing, since the server is the gate.
Required fix: With T-0204, replace `mockApi.session` with the typed client's session call, and write the M22 build check: `Mock persona` and `mocks/` absent from `dist`.
Resolution: (S2 fills in at T-0204)

### F-M03-r2-02 — Minor — The focus-trap test still failed once in 90 runs after the fix
Area: 8 Requirement coverage  IDs: NFR-8
Evidence: `playwright test --project=ui kit.spec.ts --repeat-each=6 --workers=2`: 23 passed, 1 failed, test `kit.spec.ts:39`. Three more runs (12, 24 and 30 repeats, up to 4 workers) all passed, and I did not capture the failure message. Likely cause unknown: the poll covers a late focus move after Tab; it does not cover a slow dialog open.
Required fix: Under ADR-054 a flaky test is fixed or quarantined the day it is seen. Give the project `trace: 'retain-on-failure'` so the next failure explains itself, and wait for the first focusable element inside the dialog (`toBeFocused`) before the Tab loop. Never delete the test.
Resolution: (S2 fills in)

### Follow-ups (not findings)
- PR #42's first CI run failed on 4 teardown errors in `packages/db/src/audit.int.test.ts` (database closed while connections were open); a re-run passed. S3 owns it: fix it in the M02 halfway fix batch if it recurs. I did not see it in the later green runs.
- `ui-perf` is now on request only; if S2 wants the p95 number kept visible, print it when someone runs it (already done), nothing more.

