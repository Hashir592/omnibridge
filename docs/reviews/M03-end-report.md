# M03 end checkpoint report (T-0301 to T-0303)

From S2, 20 Oct 2026. For S4. M03 had no halfway checkpoint (S1, 20 Oct 2026), so this is the only review of the module: up to 2 fix rounds, then S1 (ADR-044). S4 reviews accessibility, permission mirroring, PII handling, contract use, bundle size and render performance on large tables (S2-frontend.md), not taste.

## Tasks done

| Task | Title | PR | Status |
|---|---|---|---|
| T-0301 | Design direction and mock-ups | #7 (rulings #8) | done |
| T-0302 | Design tokens, component kit and app shell | #11 (rulings #13, #16) | done |
| T-0303 | Auth screens | #19 (rulings #20) | done |

All three are normal tier (ADR-043): `verify.sh --quick` locally, `/code-review` (CodeRabbit CLI is not installed, ADR-030), full gate in CI. All three ran in design iteration mode (ADR-037): Hashir reviewed on localhost and said "merge".

## How each was built

**T-0301, mock-ups.** Clickable screens in `apps/ui` (React 19, Vite, Tailwind 4, TanStack Router and Query) on MSW synthetic data: app shell, Home, Orders (500 rows), Order detail and the Shipping desk. Hashir locked the direction on 19/10/2026: petrol accent, graphite sidebar, 56 px rows, numbered pages of 20/50/100, status as icon plus label (ADR-040, ADR-041). Tokens and every override are in `docs/design/README.md`. The API shapes the screens need are mocked in `apps/ui/src/mocks/` and were accepted as design input (PS-011, ADR-042). Two personas (admin; packer with Orders and Shipping for two companies) show permission mirroring. The mock filters lists to permitted companies ("Combined" = permitted only, invariant 4), masks buyers in lists and logs every full PII view (ORD-5).

**T-0302, kit and shell.** Kit components in `apps/ui/src/kit/` on Base UI 1.9.0: button, field, select, combobox, DD/MM/YYYY date picker, dialog, toast, tabs, badge, skeleton (shown only after 300 ms), and the empty, error and permission-denied states. `DataTable` uses TanStack Table 9 and Virtual 3: sticky header, pinned first column, URL-synced filters as chips, a bulk-action bar and numbered pages. A dev-only gallery at `/__ui` holds a 10,000-row table for the perf test. It is in a build only with `VITE_UI_GALLERY=1`, which only the `ui-perf` Playwright project sets (ADR-046). jsdom 30.1.2 runs component tests per file. @testing-library/dom 10.4.2 was added to ADR-028.

**T-0303, auth screens.** Eight screens outside the app shell, in `apps/ui/src/routes/auth/`: sign in, TOTP code, recovery code, MFA set-up (QR and 10 recovery codes), forgot password, reset password (live USR-3 checklist), accept invite and the workspace picker.

- **Frame:** a split screen chosen by Hashir (graphite product panel on the left, form on the right; below 1024 px the panel hides). Form errors are inline text, not tinted boxes.
- **Routing:** routes carry `staticData.bare`. The root then renders them without the shell, and the signed-in app state lives inside the shell only, so auth screens never request a session. Signing in clears the query cache.
- **Mock API:** MSW handlers in `mocks/auth.ts` (PROPOSED SHAPE, synthetic values only). They use existing Problem codes. One message covers both an unknown email and a wrong password. Forgot-password always answers 202. The USR-5 lockout counts failures for unknown emails too, and is fixed at 15 minutes from the 10th failure.
- **QR code:** the route returns it as a module matrix and the UI draws inline SVG, so there is no QR library and no CSP change. The shapes are ADR-048 (PS-016).
- **Screenshot scope (ADR-046):** cut to 4 key screens (Orders, Order detail, Shipping desk tablet, Sign in). The Home, Orders-tablet and Shipping-desktop references were removed; those screens keep axe tests.
- **ui-perf:** rewritten per ADR-046. The hard check is p95 table work per frame over 36 ten-frame windows across 3 runs, under 16 ms; the rAF gap is a warning only.

## Risks

1. **ui-perf is flaky in CI and does not yet meet "3 CI runs in a row" (T-0303 acceptance).** In 2 of the 3 CI runs since T-0303, the test failed on the first attempt and passed only on Playwright's CI retry:

   | Run | Event | First attempt p95 | Retry |
   |---|---|---|---|
   | 39445910378 | PR #19 | 21.17 ms (fail) | pass |
   | 39447177128 | main, merge of #19 | 17.92 ms (fail) | pass |
   | 39449170642 | main, merge of #20 | pass | – |

   The p95 of passing CI runs is not in the logs: the annotation goes only to the HTML report, which CI does not upload. Locally (Windows, this 7.9 GB host, production build) p95 is 11.0, 11.4 and 14.2 ms, and earlier 14.1 to 15.7 ms. The median rAF gap is 16.7 ms locally. In CI the table work, not the frame rate, is what crosses 16 ms. The budget stays at 16 ms. The fix is to reduce the table's work per frame, or for S1 to rule on the CI runner.

2. **The production build ships MSW in a lazy chunk (130 KB gzip).** `routes/auth/parts.tsx` imports `PASSWORD_RULES` from `mocks/auth.ts`, which also defines the MSW handlers. So the `parts-*.js` chunk, loaded by the code, recovery, MFA set-up, reset and invite screens, contains `msw`. It is not in the initial bundle, and MSW is never started in production (`main.tsx` starts it only in dev). But it is dead weight and mock code in a deployable build. Fix (small, S2): move the auth types and `PASSWORD_RULES` out of `mocks/auth.ts` into a file with no MSW import. A build check that `msw` is absent from `dist` would fit with the M22 `/__ui` check (ADR-046).

3. **Every screen still reads data through the mock layer** (`mocks/api.ts`), not the typed contract client: none of the routes exist yet. This is by design until S3 builds them (ADR-042, ADR-048). The swap is per function in `mockApi` and `authApi`.

4. **Footer links** (Privacy, Terms, Help) point to omnibridge.co.uk pages that M06 builds. They are dead until then (S1 ruling).

## Anything I am unsure of

- Whether shared CI runners can ever hold p95 under 16 ms for 10 rows scrolled per frame without optimising the table. I did not change the table in T-0303.
- Only the Sign-in reference covers the auth frame. The other seven auth screens are covered by axe and flow tests, not screenshots (ADR-046).
- The QR on the mock is a fixed pattern and cannot be scanned. The real matrix comes from the server (ADR-048).

## Test evidence

| What | Command | Result |
|---|---|---|
| Quick gate (T-0303 branch) | `scripts/verify.sh --quick` | passed in 155 s; 56 unit files, 227 tests |
| UI unit and component tests (after review fixes) | `npx vitest run apps/ui` | 11 files, 62 tests passed |
| UI Playwright (screenshots, axe, keyboard, flows) | `npx playwright test --project ui` | 35 passed |
| ui-perf, local, main at `c055911` | `npx playwright test --project ui-perf --retries=0` (3 times) | passed: p95 11.03, 11.37, 14.19 ms; median rAF gap 16.7 ms |
| ui-perf, CI | runs 39445910378, 39447177128, 39449170642 | see Risk 1: 2 first-attempt failures, all green after retry |
| Full gate, CI | the same three runs | success |
| Bundle, production build of main | `vite build` + gzip of the entry chunks | initial JS **169.3 KB gzip** (budget 200 KB); CSS 8.1 KB; all JS 354.4 KB in 23 chunks; no `/__ui` gallery chunk |
| axe on every auth screen and error state | `apps/ui/e2e/auth.spec.ts` | 0 serious or critical |
| Screenshot references | `docs/design/reference/` | orders, order-detail, shipping-tablet, sign-in (Linux + Windows) |

S4 may want to run, beyond `scripts/verify.sh`:

```bash
npx playwright test --project ui-perf --retries=0 --repeat-each=3
```
