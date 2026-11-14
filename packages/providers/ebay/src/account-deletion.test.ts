import { describe, expect, it, vi } from 'vitest';
import {
  challengeResponse,
  ebayPublicKeyFetcher,
  isVerificationToken,
  PublicKeyCache,
  verifyNotification,
} from './account-deletion.ts';
import { EBAY_SDK_SAMPLE } from './sample.ts';

const SAMPLE = EBAY_SDK_SAMPLE;

const keyOf = (kid: string) =>
  Promise.resolve(kid === SAMPLE.kid ? SAMPLE.key : Promise.reject(new Error('unknown kid')));

describe('eBay marketplace account deletion (EBAY-2)', () => {
  it("[EBAY-2] challenge hash matches eBay's sample", () => {
    // The inputs of the challenge test in eBay's SDK; the hash is SHA-256 hex of
    // challengeCode + verificationToken + endpoint, in that order.
    expect(
      challengeResponse(
        '71745723-d031-455c-bfa5-f90d11b4f20a',
        '71745723-d031-455c-bfa5-f90d11b4f20a',
        'http://www.testendpoint.com/webhook',
      ),
    ).toBe('048de9ffd0e35021fefc0388d5c52e0f475324f582f3778ca81a53354ccbbc97');
  });

  it('[EBAY-2] the verification token is 32 to 80 letters, digits, _ or -', () => {
    expect(isVerificationToken('a'.repeat(32))).toBe(true);
    expect(isVerificationToken('A1_-'.repeat(20))).toBe(true);
    expect(isVerificationToken('a'.repeat(31))).toBe(false);
    expect(isVerificationToken('a'.repeat(81))).toBe(false);
    expect(isVerificationToken(`${'a'.repeat(32)}!`)).toBe(false);
  });

  it("[EBAY-2] eBay's signed sample verifies; a changed message or header does not", async () => {
    expect(await verifyNotification(SAMPLE.message, SAMPLE.signature, keyOf)).toBe(true);
    const changed = {
      ...SAMPLE.message,
      notification: { ...SAMPLE.message.notification, publishAttemptCount: 2 },
    };
    expect(await verifyNotification(changed, SAMPLE.signature, keyOf)).toBe(false);
    expect(await verifyNotification(SAMPLE.message, undefined, keyOf)).toBe(false);
    expect(await verifyNotification(SAMPLE.message, 'not base64 json', keyOf)).toBe(false);
    const otherKid = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(SAMPLE.signature, 'base64').toString()),
        kid: 'x',
      }),
    ).toString('base64');
    expect(await verifyNotification(SAMPLE.message, otherKid, keyOf)).toBe(false);
  });

  it('[EBAY-2] public keys are cached per kid for an hour', async () => {
    let now = 0;
    const fetchKey = vi.fn(keyOf);
    const cache = new PublicKeyCache(fetchKey, () => now);
    expect(await cache.get(SAMPLE.kid)).toBe(SAMPLE.key);
    now += 59 * 60_000;
    await cache.get(SAMPLE.kid);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    await cache.get(SAMPLE.kid);
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it('[EBAY-2] the key fetcher takes an application token, then reads the key for the kid', async () => {
    const calls: string[] = [];
    const fake = vi.fn((url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/identity/v1/oauth2/token')) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.authorization).toMatch(/^Basic /);
        return Promise.resolve(Response.json({ access_token: 'app-token', expires_in: 7200 }));
      }
      return Promise.resolve(
        Response.json({ algorithm: 'ECDSA', digest: 'SHA1', key: SAMPLE.key }),
      );
    });
    const fetchKey = ebayPublicKeyFetcher({
      apiBase: 'http://provider-mocks:8080/ebay',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      fetch: fake as typeof fetch,
    });
    expect(await fetchKey(SAMPLE.kid)).toBe(SAMPLE.key);
    await fetchKey(SAMPLE.kid);
    expect(calls).toEqual([
      'POST http://provider-mocks:8080/ebay/identity/v1/oauth2/token',
      `GET http://provider-mocks:8080/ebay/commerce/notification/v1/public_key/${SAMPLE.kid}`,
      `GET http://provider-mocks:8080/ebay/commerce/notification/v1/public_key/${SAMPLE.kid}`,
    ]);
  });
});
