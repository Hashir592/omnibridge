import { createLogger } from '@omnibridge/logger';
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
      app.get('/ip', (request) => ({ ip: request.ip }));
      const res = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      await app.close();
      return res.json<{ ip: string }>().ip;
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

  it('[NFR-2] treats a failing check as an error rather than crashing', async () => {
    const res = await healthz({
      dbMain: () => Promise.reject(new Error('connection refused')),
      dbPii: () => Promise.resolve(true),
    });
    expect(res.code).toBe(503);
    expect(res.body).toMatchObject({ db_main: 'error', db_pii: 'ok' });
  });
});
