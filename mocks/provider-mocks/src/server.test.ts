import { createLogger } from '@omnibridge/logger';
import { describe, expect, it } from 'vitest';
import { buildMockServer } from './server.ts';

describe('provider-mocks', () => {
  it('[NFR-1] serves the placeholder Amazon route', async () => {
    const app = buildMockServer(createLogger({ service: 't', version: '0', level: 'silent' }));
    const res = await app.inject({ method: 'GET', url: '/amazon/ping' });
    await app.close();
    expect(res.json()).toEqual({ ok: true, provider: 'amazon', mock: true });
  });
});
