import { defineConfig } from 'astro/config';

// Public site (ADR-003b): a static build served by static-web-server. Real pages arrive in M06.
// Telemetry is disabled with ASTRO_TELEMETRY_DISABLED=1 wherever it builds (OPS-11).
export default defineConfig({
  output: 'static',
});
