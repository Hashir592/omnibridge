import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@omnibridge/logger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';
import { loadSpa } from './spa.ts';

// ADR-060: the API lives under /api, the SPA owns every other page path.

const logger = createLogger({ service: 'web-test', version: '0', level: 'silent' });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const INDEX = '<!doctype html><title>OmniBridge</title><div id="root"></div>';

function builtUi(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ob-ui-'));
  mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets', 'fonts', 'inter-x1.woff2'), 'woff2');
  return dir;
}

describe('web serves the SPA beside the API (ADR-060)', () => {
  const app = buildWebApp({ logger, version: '1', checks, spa: loadSpa(builtUi()) });
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  it('[NFR-1] GET /users with Accept text/html returns index.html, revalidated each load', async () => {
    const res = await get('/users', { accept: 'text/html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe(INDEX);
    // The security headers still apply to the page (SEC-2).
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('[NFR-1] any page path, deep or with a query, gets index.html whatever the Accept', async () => {
    for (const url of ['/', '/users/usr_1', '/invite/abc', '/reset-password?token=x']) {
      const res = await get(url, { accept: 'application/json' });
      expect({ url, status: res.statusCode, body: res.body }).toEqual({
        url,
        status: 200,
        body: INDEX,
      });
    }
  });

  it('[NFR-1] /assets/ files are served with immutable caching', async () => {
    const js = await get('/assets/index-abc123.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const font = await get('/assets/fonts/inter-x1.woff2');
    expect(font.headers['content-type']).toBe('font/woff2');
  });

  it('[SEC-3] GET /api/users is the API: JSON 401 without a session, never the page', async () => {
    const res = await get('/api/users', { accept: 'text/html' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('[SEC-3] unknown /api/** and non-page paths answer the JSON 404 envelope', async () => {
    const cases = [
      { method: 'GET', url: '/api/nope' },
      { method: 'GET', url: '/api' },
      { method: 'GET', url: '/api/healthz' },
      { method: 'GET', url: '/%61pi/nope' },
      { method: 'GET', url: '/assets/missing.js' },
      { method: 'GET', url: '/assets/..%2F..%2Fpackage.json' },
      { method: 'GET', url: '/webhooks/unknown' },
      { method: 'GET', url: '/connect/ebay/elsewhere' },
      { method: 'GET', url: '/healthz/x' },
      { method: 'POST', url: '/users' },
    ] as const;
    for (const { method, url } of cases) {
      const res = await app.inject({ method, url, headers: { accept: 'text/html' } });
      expect({ url, method, status: res.statusCode, type: res.headers['content-type'] }).toEqual({
        url,
        method,
        status: 404,
        type: 'application/problem+json; charset=utf-8',
      });
      expect(res.json()).toMatchObject({ status: 404, code: 'not_found' });
    }
  });

  it('[NFR-1] /healthz and the eBay webhook path still answer at the root', async () => {
    expect((await get('/healthz')).json()).toMatchObject({ status: 'ok' });
    // No eBay secrets here, so the challenge answers 503 exactly as before (EBAY-2).
    const challenge = await get('/webhooks/ebay/account-deletion?challenge_code=abc');
    expect(challenge.statusCode).toBe(503);
    expect(challenge.headers['content-type']).toContain('application/problem+json');
  });
});

describe('web without a built SPA (tests, contract generator)', () => {
  it('[SEC-3] every unknown path answers the JSON 404', async () => {
    const app = buildWebApp({ logger, version: '1', checks });
    const res = await app.inject({ method: 'GET', url: '/users' });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});
