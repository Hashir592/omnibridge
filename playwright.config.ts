import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against the running dev stack (scripts/verify.sh brings it up first).
// The dev edge uses Caddy's local CA, which the browser does not trust; that is the only
// reason for ignoreHTTPSErrors, and it applies to these localhost URLs only.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.OB_APP_URL ?? 'https://localhost:8443',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
