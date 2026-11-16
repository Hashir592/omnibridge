import { createLogger } from '@omnibridge/logger';
import {
  ebayPublicKeyFetcher,
  PublicKeyCache,
  verifyNotification,
} from '@omnibridge/provider-ebay';
import { EBAY_SDK_SAMPLE as SAMPLE } from '@omnibridge/provider-ebay/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMockServer } from './server.ts';

describe('eBay adapter against the provider mocks (EBAY-2)', () => {
  const app = buildMockServer(createLogger({ service: 't', version: '0', level: 'silent' }));
  let base = '';

  beforeAll(async () => {
    base = `${await app.listen({ host: '127.0.0.1', port: 0 })}/ebay`;
  });
  afterAll(async () => {
    await app.close();
  });

  it("[EBAY-2] the key fetcher gets a token, reads the key, and eBay's sample verifies", async () => {
    const keys = new PublicKeyCache(
      ebayPublicKeyFetcher({
        apiBase: base,
        clientId: 'synthetic',
        clientSecret: 'synthetic',
        budget: () => true,
      }),
    );
    expect(await verifyNotification(SAMPLE.message, SAMPLE.signature, keys.get)).toBe(true);
    await expect(keys.get('unknown-kid')).rejects.toThrow(/HTTP 404/);
  });
});
