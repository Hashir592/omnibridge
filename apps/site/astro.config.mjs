import { defineConfig } from 'astro/config';

// Public site (ADR-003b, T-0601): a static build served by static-web-server. Telemetry is
// disabled with ASTRO_TELEMETRY_DISABLED=1 wherever it builds (OPS-11).
export default defineConfig({
  output: 'static',
  site: 'https://omnibridge.co.uk',
  build: {
    // Styles always as files of our own, so the Content-Security-Policy needs no inline styles.
    inlineStylesheets: 'never',
    format: 'directory',
  },
});
