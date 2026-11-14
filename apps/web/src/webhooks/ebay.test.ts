import { createLogger } from '@omnibridge/logger';
import { PublicKeyCache } from '@omnibridge/provider-ebay';
import { EBAY_SDK_SAMPLE as SAMPLE } from '@omnibridge/provider-ebay/testing';
import { describe, expect, it } from 'vitest';
import { buildWebApp } from '../app.ts';
import { ebayWebhook } from './ebay.ts';

const TOKEN = 'synthetic-verification-token-0123456789abcdef';
const ENDPOINT = 'https://app.omnibridge.test/webhooks/ebay/account-deletion';
const PATH = '/webhooks/ebay/account-deletion';

function server(opts: { keyDelayMs?: number; perMinute?: number; configured?: boolean } = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    version: '0',
    destination: { write: (line: string) => lines.push(line) },
  });
  const keys = new PublicKeyCache(async (kid) => {
    await new Promise((resolve) => setTimeout(resolve, opts.keyDelayMs ?? 0));
    if (kid !== SAMPLE.kid) throw new Error('unknown kid');
    return SAMPLE.key;
  });
  const app = buildWebApp({
    logger,
    version: '0',
    checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
    ...(opts.configured === false
      ? {}
      : {
          ebay: ebayWebhook({
            verificationToken: TOKEN,
            endpoint: ENDPOINT,
            keys: keys.get,
            logger,
            ...(opts.perMinute === undefined ? {} : { perMinute: opts.perMinute }),
          }),
        }),
  });
  return { app, log: () => lines.join('') };
}

const notice = (headers: Record<string, string> = { 'x-ebay-signature': SAMPLE.signature }) => ({
  method: 'POST' as const,
  url: PATH,
  headers: { 'content-type': 'application/json', ...headers },
  payload: JSON.stringify(SAMPLE.message),
});

describe('eBay account deletion endpoint (EBAY-2)', () => {
  it('[EBAY-2] a key that cannot be fetched answers 503, so eBay retries', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'test',
      version: '0',
      destination: { write: (line: string) => lines.push(line) },
    });
    const app = buildWebApp({
      logger,
      version: '0',
      checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
      ebay: ebayWebhook({
        verificationToken: TOKEN,
        endpoint: ENDPOINT,
        keys: () => Promise.reject(new Error('eBay public key: HTTP 401')),
        logger,
      }),
    });
    expect((await app.inject(notice())).statusCode).toBe(503);
    expect(lines.join('')).toContain('"event":"ebay.public_key_unavailable"');
    await app.close();
  });

  it('[EBAY-2] the challenge answers with the hash, as JSON with no byte-order mark', async () => {
    const { app } = server();
    const res = await app.inject({ method: 'GET', url: `${PATH}?challenge_code=abc123` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.rawPayload[0]).toBe('{'.charCodeAt(0));
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(`abc123${TOKEN}${ENDPOINT}`).digest('hex');
    expect(res.json()).toEqual({ challengeResponse: expected });
    await app.close();
  });

  it('[EBAY-2] bad signature rejected; good one answered 200 in under 3 s', async () => {
    // A slow first key fetch (eBay's API) still answers well inside the 3 seconds.
    const { app } = server({ keyDelayMs: 500 });
    const started = performance.now();
    const good = await app.inject(notice());
    expect(good.statusCode).toBeGreaterThanOrEqual(200);
    expect(good.statusCode).toBeLessThan(300);
    expect(performance.now() - started).toBeLessThan(3_000);

    const tampered = {
      ...notice(),
      payload: JSON.stringify({
        ...SAMPLE.message,
        notification: { ...SAMPLE.message.notification, publishAttemptCount: 9 },
      }),
    };
    expect((await app.inject(tampered)).statusCode).toBe(412);
    expect((await app.inject(notice({}))).statusCode).toBe(412);
    expect((await app.inject(notice({ 'x-ebay-signature': 'bm9wZQ==' }))).statusCode).toBe(412);
    await app.close();
  });

  it('[EBAY-2] no PII or identifiers are kept: the receipt logs only the topic', async () => {
    const { app, log } = server();
    expect((await app.inject(notice())).statusCode).toBe(204);
    const text = log();
    expect(text).toContain('"event":"ebay.account_deletion.received"');
    expect(text).toContain('"topic":"MARKETPLACE_ACCOUNT_DELETION"');
    const data = SAMPLE.message.notification.data;
    for (const id of [
      data.username,
      data.userId,
      data.eiasToken,
      SAMPLE.message.notification.notificationId,
    ]) {
      expect({ id, logged: text.includes(id) }).toEqual({ id, logged: false });
    }
    await app.close();
  });

  it('[EBAY-2] no CSRF token is needed, nothing is accepted unconfigured, and floods are cut', async () => {
    const off = server({ configured: false });
    expect((await off.app.inject(notice())).statusCode).toBe(401);
    expect(
      (await off.app.inject({ method: 'GET', url: `${PATH}?challenge_code=x` })).statusCode,
    ).toBe(503);
    await off.app.close();

    const { app } = server({ perMinute: 2 });
    // eBay's own verified notices are never limited, however many come from one address.
    for (let i = 0; i < 5; i += 1) expect((await app.inject(notice())).statusCode).toBe(204);
    // Bad ones are: after 2 failures in a minute the address waits.
    expect((await app.inject(notice({}))).statusCode).toBe(412);
    expect((await app.inject(notice({}))).statusCode).toBe(412);
    const third = await app.inject(notice({}));
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    // A notice bigger than 64 KB is refused before it is read.
    const big = await app.inject({
      ...notice(),
      payload: JSON.stringify({ ...SAMPLE.message, pad: 'x'.repeat(70_000) }),
    });
    expect(big.statusCode).toBe(413);
    await app.close();
  });
});
