import { contractRoutes, mountedPath } from '@omnibridge/contract';
import { createLogger } from '@omnibridge/logger';
import { platformHeaders, sessionHeaders } from '@omnibridge/testkit';
import { describe, expect, it } from 'vitest';
import { buildWebApp, type HealthChecks } from './app.ts';

const logger = createLogger({ service: 'web-test', version: '0', level: 'silent' });

async function healthz(checks: HealthChecks) {
  const app = buildWebApp({ logger, version: '1.2.3', checks });
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  await app.close();
  return { code: res.statusCode, body: res.json<unknown>() };
}

describe('web proxy trust', () => {
  it('[NFR-1] ignores X-Forwarded-For unless a trusted proxy is configured', async () => {
    const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
    const ipOf = async (trustedProxies?: string) => {
      const app = buildWebApp({
        logger,
        version: '1',
        checks,
        ...(trustedProxies ? { trustedProxies } : {}),
      });
      // Routes come only from the contract, so read request.ip in a hook on /healthz.
      let ip = '';
      app.addHook('onRequest', (request, _reply, done) => {
        ip = request.ip;
        done();
      });
      await app.inject({
        method: 'GET',
        url: '/healthz',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      await app.close();
      return ip;
    };
    expect(await ipOf()).toBe('10.0.0.5');
    expect(await ipOf('10.0.0.0/8')).toBe('203.0.113.9');
  });
});

describe('web /healthz', () => {
  it('[NFR-1] reports ok when db-main and db-pii are both healthy', async () => {
    const res = await healthz({
      dbMain: () => Promise.resolve(true),
      dbPii: () => Promise.resolve(true),
    });
    expect(res).toEqual({
      code: 200,
      body: { status: 'ok', db_main: 'ok', db_pii: 'ok', version: '1.2.3' },
    });
  });

  it('[NFR-2] reports degraded with 503 when the PII database is down', async () => {
    const res = await healthz({
      dbMain: () => Promise.resolve(true),
      dbPii: () => Promise.resolve(false),
    });
    expect(res).toEqual({
      code: 503,
      body: { status: 'degraded', db_main: 'ok', db_pii: 'error', version: '1.2.3' },
    });
  });

  it('[NFR-2] a 503 logs the failing dependency by name, with no error text (R2-01)', async () => {
    const lines: string[] = [];
    const captured = createLogger({
      service: 'web-test',
      version: '0',
      destination: {
        write: (line: string) => {
          lines.push(line);
          return 0;
        },
      },
    });
    const app = buildWebApp({
      logger: captured,
      version: '1',
      checks: {
        dbMain: () => Promise.resolve(true),
        dbPii: () => Promise.reject(new Error('connect ECONNREFUSED db-pii:5432 secret-marker')),
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();
    expect(res.statusCode).toBe(503);
    const degraded = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'health.degraded');
    expect(degraded).toEqual([
      expect.objectContaining({
        db_main: 'ok',
        db_pii: 'error',
        msg: 'healthz 503: db_pii failing',
      }),
    ]);
    expect(lines.join('')).not.toContain('secret-marker');
  });

  it('[NFR-2] treats a failing check as an error rather than crashing', async () => {
    const res = await healthz({
      dbMain: () => Promise.reject(new Error('connection refused')),
      dbPii: () => Promise.resolve(true),
    });
    expect(res.code).toBe(503);
    expect(res.body).toMatchObject({ db_main: 'error', db_pii: 'ok' });
  });
});

describe('web authentication until T-0203 (SEC-3)', () => {
  it('[SEC-3] production passes no resolvers: every session and platform route answers 401', async () => {
    const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
    // What main.ts builds today: no session or platform resolver at all.
    const app = buildWebApp({ logger, version: '1', checks });
    const id = '00000000-0000-4000-8000-000000000001';
    // The test headers mean nothing without the stub resolvers.
    const headers = {
      ...sessionHeaders({ workspaceId: id, userId: id, sessionId: 's' }),
      ...platformHeaders(id),
    };
    const closed = contractRoutes.filter((route) => route.auth !== 'public');
    expect(closed.map((r) => r.auth)).toEqual(expect.arrayContaining(['session', 'platform']));
    for (const route of closed) {
      const res = await app.inject({
        method: route.method,
        url: mountedPath(route.path).replace(/:[A-Za-z0-9_]+/g, id),
        headers,
        ...(route.method === 'GET' ? {} : { payload: {} }),
      });
      expect({ route: route.id, status: res.statusCode }).toEqual({ route: route.id, status: 401 });
    }
    await app.close();
  });
});
