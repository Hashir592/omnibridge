import { createLogger } from '@omnibridge/logger';
import { describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };

/** CSP header → { directive: [sources] } */
function parseCsp(header: string): Record<string, string[]> {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0])
      .map(([name, ...sources]) => [name ?? '', sources]),
  );
}

describe('security headers (SEC-2)', () => {
  it('[SEC-2] CSP header present and blocks inline script', async () => {
    const app = buildWebApp({ logger, version: '0', checks });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = parseCsp(res.headers['content-security-policy'] ?? '');

    expect(csp['default-src']).toEqual(["'self'"]);
    // Inline <script> and eval need 'unsafe-inline'/'unsafe-eval' (or a hash/nonce): none allowed.
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['script-src-attr']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    for (const sources of Object.values(csp)) {
      expect(sources).not.toContain("'unsafe-inline'");
      expect(sources).not.toContain("'unsafe-eval'");
    }
    await app.close();
  });

  it('[SEC-2] HSTS, Referrer-Policy and nosniff are set on every response', async () => {
    const app = buildWebApp({ logger, version: '0', checks });
    for (const url of ['/healthz', '/no-such-route']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
    await app.close();
  });
});
