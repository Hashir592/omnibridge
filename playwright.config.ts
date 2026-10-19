import { defineConfig, devices } from '@playwright/test';

// Two projects:
// - "chromium": end-to-end tests against the running dev stack (scripts/verify.sh brings it up
//   first). The dev edge uses Caddy's local CA, which the browser does not trust; that is the only
//   reason for ignoreHTTPSErrors, and it applies to these localhost URLs only.
// - "ui": the design mock-up screens (apps/ui) on the Vite dev server with MSW synthetic data,
//   compared against the locked reference screenshots in docs/design/reference (T-0301).
const uiUrl = process.env.OB_UI_URL ?? 'http://localhost:5173';

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
      use: { ...devices['Desktop Chrome'], baseURL: uiUrl, viewport: { width: 1440, height: 900 } },
    },
  ],
  // OB_UI_URL points the ui project at a server that is already running (used to make the Linux
  // reference images from a container); otherwise Playwright starts the Vite dev server itself.
  ...(process.env.OB_UI_URL
    ? {}
    : {
        webServer: {
          command: 'node ../../node_modules/vite/bin/vite.js --port 5173 --strictPort',
          cwd: 'apps/ui',
          url: uiUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
