import { createLogger } from '@omnibridge/logger';
import { describe, expect, it } from 'vitest';
import { buildVaultApp } from './app.ts';

const logger = createLogger({ service: 'vault-test', version: '0', level: 'silent' });

describe('pii-vault /healthz', () => {
  it('[NFR-2] reports db-pii status', async () => {
    const up = buildVaultApp({ logger, version: '1', dbPii: () => Promise.resolve(true) });
    const ok = await up.inject({ method: 'GET', url: '/healthz' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: 'ok', db_pii: 'ok', version: '1' });

    const down = buildVaultApp({
      logger,
      version: '1',
      dbPii: () => Promise.reject(new Error('x')),
    });
    const bad = await down.inject({ method: 'GET', url: '/healthz' });
    expect(bad.statusCode).toBe(503);
    expect(bad.json()).toEqual({ status: 'degraded', db_pii: 'error', version: '1' });
  });
});
