import { defineConfig, devices } from '@playwright/test';

// Two projects:
// - "chromium": end-to-end tests against the running dev stack (scripts/verify.sh brings it up
//   first). The dev edge uses Caddy's local CA, which the browser does not trust; that is the only
//   reason for ignoreHTTPSErrors, and it applies to these localhost URLs only.
// - "ui": the design mock-up screens (apps/ui) on the Vite dev server with MSW synthetic data,
//   compared against the locked reference screenshots in docs/design/reference (T-0301).
// - "ui-perf": the 10,000-row table frame budget (T-0302), measured on a production build of the
//   UI with the component gallery switched on (VITE_UI_GALLERY=1), because React's development
//   build is several times slower and would measure the wrong thing.
// OB_UI_PORT lets scripts/verify.sh start its own Vite server on a port no developer or other
// session uses, and OB_E2E_OWN_SERVER stops Playwright reusing a server it did not start: the gate
// must test this checkout, never another worktree's dev server on 5173 (F-M01-halfway-01 round 1).
const uiPort = process.env.OB_UI_PORT ?? '5173';
const uiUrl = process.env.OB_UI_URL ?? `http://localhost:${uiPort}`;
const perfPort = String(Number(uiPort) + 1);
const perfUrl = process.env.OB_UI_PERF_URL ?? `http://localhost:${perfPort}`;
const ownServer = !process.env.CI && !process.env.OB_E2E_OWN_SERVER;
// ui-perf is a local benchmark, not a gate (ADR-054, FA-18): it runs only when asked for, with
//   OB_UI_PERF=1 npx playwright test --project ui-perf
// or against an already-running perf build by setting OB_UI_PERF_URL.
// The gate checks render counts in a unit test instead (kit/table/DataTable.test.tsx).
const perf = process.env.OB_UI_PERF === '1' || !!process.env.OB_UI_PERF_URL;
const vite = 'node ../../node_modules/vite/bin/vite.js';

export default defineConfig({
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      testDir: 'tests/e2e',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.OB_APP_URL ?? 'https://localhost:8443',
        ignoreHTTPSErrors: true,
      },
    },
    {
      name: 'ui',
      testDir: 'apps/ui/e2e',
      // One reference image per screen and platform: font rasterising differs between Windows
      // (local runs) and Linux (CI), so each platform is compared with its own image.
      snapshotPathTemplate: 'docs/design/reference/{arg}-{platform}{ext}',
      expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
      testIgnore: '**/*.perf.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: uiUrl, viewport: { width: 1440, height: 900 } },
    },
    // Only on request, and left out when OB_UI_URL points at an outside server without a perf URL.
    ...(!perf || (process.env.OB_UI_URL && !process.env.OB_UI_PERF_URL)
      ? []
      : [
          {
            name: 'ui-perf',
            testDir: 'apps/ui/e2e',
            testMatch: '**/*.perf.spec.ts',
            // No retries (ADR-046): a pass on retry would hide a first try over the frame budget.
            retries: 0,
            use: {
              ...devices['Desktop Chrome'],
              baseURL: perfUrl,
              viewport: { width: 1440, height: 900 },
            },
          },
        ]),
  ],
  // OB_UI_URL points the ui project at a server that is already running (used to make the Linux
  // reference images from a container); otherwise Playwright starts the Vite dev server itself.
  ...(process.env.OB_UI_URL
    ? {}
    : {
        webServer: [
          {
            command: `${vite} --port ${uiPort} --strictPort`,
            cwd: 'apps/ui',
            url: uiUrl,
            reuseExistingServer: ownServer,
            timeout: 120_000,
          },
          // Production build with the gallery, served by vite preview. It is written to
          // apps/ui/.perf-build (git-ignored), never inside dist, so it cannot be deployed (F-M03-end-02).
          ...(perf && !process.env.OB_UI_PERF_URL
            ? [
                {
                  command: `${vite} build --outDir .perf-build --emptyOutDir && ${vite} preview --outDir .perf-build --port ${perfPort} --strictPort`,
                  cwd: 'apps/ui',
                  env: { VITE_UI_GALLERY: '1' },
                  url: perfUrl,
                  reuseExistingServer: ownServer,
                  timeout: 180_000,
                },
              ]
            : []),
        ],
      }),
});
