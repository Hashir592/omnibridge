import { DailyCallBudget, EBAY_WEBHOOK_DAILY_BUDGET } from '@omnibridge/governor-ebay';
import { createLogger } from '@omnibridge/logger';
import {
  EbayBudgetExhausted,
  ebayPublicKeyFetcher,
  PublicKeyCache,
} from '@omnibridge/provider-ebay';
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

  // ADR-058
  it('[EBAY-2][RL-2] a spent eBay budget answers 412 without reading the key', async () => {
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
        keys: () => Promise.reject(new EbayBudgetExhausted('notification.public_key')),
        logger,
      }),
    });
    const res = await app.inject(notice());
    expect(res.statusCode).toBe(412);
    expect(res.json()).toMatchObject({ code: 'precondition_failed' });
    expect(lines.join('')).toContain('"event":"ebay.budget_exhausted"');
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
    expect((await app.inject(notice())).statusCode).toBe(200);
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
    for (let i = 0; i < 5; i += 1) expect((await app.inject(notice())).statusCode).toBe(200);
    // Bad ones are, and so is the one key fetch the first notice made (counted before it went
    // out, A-003): after it and 1 failure in a minute the address waits.
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

// A-003 (ADR-069): the auditor sent 501 notices with made-up key ids and spent the day's 500
// public-key reads, so eBay's own notices then got 412 until midnight. Anonymous traffic must not
// spend the eBay budget: the limiter counts before any key fetch, an unknown kid is remembered
// for an hour, and uncached fetches are capped per minute in total.
describe('eBay key budget under junk notices (A-003)', () => {
  const withKid = (kid: string) =>
    Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(SAMPLE.signature, 'base64').toString()) as object),
        kid,
      }),
    ).toString('base64');

  function realKeys(now: () => number) {
    const budget = new DailyCallBudget(EBAY_WEBHOOK_DAILY_BUDGET, now);
    const spent: string[] = [];
    const keyReads: string[] = [];
    // eBay as the provider mock answers it: a token, the sample key, 404 for any other kid.
    const fake = (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/oauth2/token')) {
        return Promise.resolve(Response.json({ access_token: 'app-token', expires_in: 7200 }));
      }
      keyReads.push(u);
      return Promise.resolve(
        u.endsWith(`/public_key/${encodeURIComponent(SAMPLE.kid)}`)
          ? Response.json({ key: SAMPLE.key })
          : new Response(null, { status: 404 }),
      );
    };
    const cache = new PublicKeyCache(
      ebayPublicKeyFetcher({
        apiBase: 'http://provider-mocks:8080/ebay',
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-secret',
        budget: (api) => {
          const ok = budget.take(api);
          if (ok) spent.push(api);
          return ok;
        },
        fetch: fake as typeof fetch,
      }),
      now,
    );
    return { cache, spent, keyReads };
  }

  function app(cache: PublicKeyCache, now: () => number, perMinute?: number) {
    const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
    return buildWebApp({
      logger,
      version: '0',
      checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
      ebay: ebayWebhook({
        verificationToken: TOKEN,
        endpoint: ENDPOINT,
        keys: cache.get,
        logger,
        now,
        ...(perMinute === undefined ? {} : { perMinute }),
      }),
    });
  }

  const junk = (kid: string, ip: string) => ({
    ...notice({ 'x-ebay-signature': withKid(kid) }),
    remoteAddress: ip,
  });

  it('[EBAY-2] 501 notices with unknown key ids from many addresses spend at most the per-minute cap', async () => {
    let t = 1_800_000_000_000;
    const now = () => t;
    const { cache, spent } = realKeys(now);
    const web = app(cache, now);
    for (let i = 0; i < 501; i += 1) {
      const res = await web.inject(
        junk(`junk-${String(i)}`, `10.1.${String(i >> 8)}.${String(i & 255)}`),
      );
      expect(res.statusCode).not.toBe(200);
    }
    expect(spent.filter((api) => api === 'notification.public_key').length).toBeLessThanOrEqual(5);
    // The flood holds the fetch cap for its minute at most: then eBay's own notice is verified.
    t += 60_000;
    expect((await web.inject(notice())).statusCode).toBe(200);
    await web.close();
  });

  it('[EBAY-2] an unknown key id is fetched once, then remembered for an hour', async () => {
    let t = 1_800_000_000_000;
    const now = () => t;
    const { cache, keyReads } = realKeys(now);
    const web = app(cache, now);
    for (let i = 0; i < 100; i += 1) {
      await web.inject(junk('same-junk-kid', `10.2.0.${String(i)}`));
    }
    expect(keyReads).toHaveLength(1);
    t += 61 * 60_000;
    await web.inject(junk('same-junk-kid', '10.2.1.1'));
    expect(keyReads).toHaveLength(2);
    await web.close();
  });

  it('[EBAY-2] an address is counted before its key fetch: past its limit it gets 429 and nothing is fetched', async () => {
    const now = () => 1_800_000_000_000;
    const { cache, keyReads } = realKeys(now);
    const web = app(cache, now, 3);
    for (const kid of ['a-1', 'a-2', 'a-3']) {
      expect((await web.inject(junk(kid, '10.3.0.1'))).statusCode).not.toBe(429);
    }
    expect(keyReads).toHaveLength(3);
    expect((await web.inject(junk('a-4', '10.3.0.1'))).statusCode).toBe(429);
    expect(keyReads).toHaveLength(3);
    await web.close();
  });
});
