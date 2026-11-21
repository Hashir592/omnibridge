import { createLogger } from '@omnibridge/logger';
import { createAmazonStubAdapter } from '@omnibridge/provider-amazon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockServer } from './server.ts';

describe('amazon stub adapter against provider-mocks', () => {
  let mock: ReturnType<typeof buildMockServer>;
  let baseUrl: string;

  beforeAll(async () => {
    mock = buildMockServer(createLogger({ service: 'mock', version: '0', level: 'silent' }));
    baseUrl = await mock.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await mock.close();
  });

  it('[NFR-1] the adapter parses the mock placeholder response', async () => {
    const adapter = createAmazonStubAdapter({ baseUrl, allowedHosts: ['127.0.0.1'] });
    await expect(adapter.ping()).resolves.toEqual({ ok: true, provider: 'amazon' });
  });

  it('[INT-7] the adapter refuses a host that is not on the mock allowlist', () => {
    expect(() =>
      createAmazonStubAdapter({
        baseUrl: 'https://sellingpartnerapi-eu.amazon.com',
        allowedHosts: ['provider-mocks'],
      }),
    ).toThrow(/not on the allowlist/);
  });
});
