import type { RaiseInput, TenantContext } from '@omnibridge/core';
import { Secret } from '@omnibridge/crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRejected, ProviderUnavailable, RateLimited } from './errors.ts';
import { passThroughGovernor, type ProviderGovernor } from './governor.ts';
import {
  MAX_DEFER_MS,
  MAX_SEND_ATTEMPTS,
  runOutboundSend,
  type OutboundOperation,
  type OutboundPorts,
} from './outbound.ts';
import { AccessTokenCache } from './tokens.ts';

const WS = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
const COMPANY = '00000000-0000-4000-8000-0000000000cc';
const WRITE = '00000000-0000-4000-8000-0000000000ee';
const NOW = new Date('2026-11-21T12:00:00.000Z');

interface Row {
  state: string;
  pausedReason: string | null;
  attempts: number;
  dispatchSeq: number;
  lastError?: string;
}

/** In-memory ports with the db repositories' contracts, and a provider that counts its sends. */
function harness(
  options: {
    governor?: ProviderGovernor;
    send?: () => Promise<Record<string, unknown>>;
    /** A website write, with WEB-5's retries (1 minute up to 24 hours) and its alert. */
    website?: true;
    /** The provider of the write's account, when it is not the write's own. */
    accountProvider?: 'ebay' | 'website';
  } = {},
) {
  const provider = options.website === true ? 'website' : 'ebay';
  const operation = `${provider}.stock_push`;
  const row: Row = { state: 'pending', pausedReason: null, attempts: 0, dispatchSeq: 0 };
  const switches = { maintenance: false, paused: false };
  const sent: unknown[] = [];
  const dispatched: { seq: number; startAfter: Date | undefined }[] = [];
  const raised: RaiseInput[] = [];
  const resolved: string[] = [];
  /** The write id each send was given (the receiver's idempotency key, WEB-2). */
  const keys: (string | undefined)[] = [];
  const usage: { api: string; calls: number }[] = [];
  const ctx: TenantContext = { workspaceId: WS, companyIds: [COMPANY] };
  const op: OutboundOperation<{ levels: { sku: string; quantity: number }[] }> = {
    operation,
    provider,
    api: provider === 'website' ? 'api.stock' : 'sell.inventory',
    ...(options.website === true
      ? {
          retry: { maxAttempts: 13, maxDelayMs: 24 * 60 * 60_000 },
          deadLetterAlert: 'website.delivery_failed',
        }
      : {}),
    payload: z.object({
      levels: z.array(z.object({ sku: z.string(), quantity: z.number().int() })),
    }),
    authenticate: () =>
      Promise.resolve({
        token: new Secret('access'),
        expiresAt: new Date(NOW.getTime() + 7_200_000),
      }),
    send: (...[, payload, write]) => {
      sent.push(payload);
      keys.push(write?.id);
      return options.send?.() ?? Promise.resolve({ accepted: payload.levels.length });
    },
  };
  const ports: OutboundPorts = {
    tenancy: { runWorkspace: (_a, fn) => fn(ctx) },
    writes: {
      get: () =>
        Promise.resolve({
          id: WRITE,
          channelAccountId: ACCOUNT,
          provider,
          operation,
          urgent: false,
          payload: { levels: [{ sku: 'MOCK-SKU-1', quantity: 3 }] },
          state: row.state,
          attempts: row.attempts,
        }),
      gate: () => Promise.resolve({ ...switches }),
      pause: (_c, _id, reason) => {
        row.state = 'pending';
        row.pausedReason = reason;
        return Promise.resolve();
      },
      claim: () => {
        if (row.state !== 'pending') return Promise.resolve(false);
        row.state = 'sending';
        row.pausedReason = null;
        return Promise.resolve(true);
      },
      defer: (_c, _id, input) => {
        row.state = 'pending';
        row.attempts += input.attempted ? 1 : 0;
        row.dispatchSeq += 1;
        if (input.errorCode !== undefined) row.lastError = input.errorCode;
        return Promise.resolve({ dispatchSeq: row.dispatchSeq, attempts: row.attempts });
      },
      sent: () => {
        row.state = 'sent';
        row.attempts += 1;
        return Promise.resolve();
      },
      fail: (_c, _id, input) => {
        row.state = 'failed';
        row.attempts += input.attempted ? 1 : 0;
        row.lastError = input.code;
        return Promise.resolve();
      },
    },
    dispatch: (_c, _w, seq, startAfter) => {
      dispatched.push({ seq, startAfter });
      return Promise.resolve();
    },
    accounts: {
      get: () =>
        Promise.resolve({
          provider: options.accountProvider ?? provider,
          companyId: COMPANY,
          status: 'active',
        }),
    },
    credentials: { read: () => Promise.resolve(new Secret('TOKENMARK-refresh')) },
    health: {
      recordSuccess: () => Promise.resolve({ reauthCleared: false }),
      recordAuthFailure: () => Promise.resolve({ failures: 1, marked: false }),
      recordError: () => Promise.resolve(),
      recordCalls: (_c, input) => {
        usage.push({ api: input.api, calls: input.calls });
        return Promise.resolve();
      },
    },
    notifier: {
      raise: (_c, input) => {
        raised.push(input);
        return Promise.resolve({
          id: 'n',
          version: 1,
          created: true,
          escalated: false,
          reopened: false,
        });
      },
      resolve: (...[, type]) => {
        resolved.push(type);
        return Promise.resolve(true);
      },
      raisePlatform: (_c, input) => {
        raised.push(input);
        return Promise.resolve({
          id: 'p',
          version: 1,
          created: true,
          escalated: false,
          reopened: false,
        });
      },
    },
    tokens: new AccessTokenCache(() => NOW.getTime()),
    governor: options.governor ?? passThroughGovernor,
    now: () => NOW,
  };
  const run = () =>
    runOutboundSend(ports, { [operation]: op }, { workspaceId: WS, writeId: WRITE });
  return { row, switches, sent, dispatched, raised, resolved, keys, usage, run };
}

describe('the outbound send path (SAFE-2, SAFE-3, INT-2)', () => {
  it('[WEB-5][AT-14] a website write that keeps failing backs off from 1 minute up to 24 hours, then is dead-lettered with one alert', async () => {
    const h = harness({
      website: true,
      send: () => Promise.reject(new ProviderUnavailable('website', 503)),
    });
    const waits: number[] = [];
    for (let n = 0; n < 30 && h.row.state !== 'failed'; n += 1) {
      const result = await h.run();
      const last = h.dispatched.at(-1);
      if ('deferred' in result && last?.startAfter !== undefined) {
        waits.push((last.startAfter.getTime() - NOW.getTime()) / 60_000);
      }
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1440]);
    // The dead letter: the write stays, failed, with its code, after its 13th attempt.
    expect(h.row).toMatchObject({ state: 'failed', attempts: 13 });
    expect(h.row.lastError).toBeDefined();
    const alerts = h.raised.filter((r) => r.type === 'website.delivery_failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      record: { kind: 'channel_account', id: ACCOUNT },
      companyId: COMPANY,
      channelAccountId: ACCOUNT,
    });
  });

  it('[WEB-5] a website write the receiver refuses is dead-lettered at once with its alert; a sent one clears it', async () => {
    const refused = harness({
      website: true,
      send: () => Promise.reject(new ProviderRejected('website', 'website.refused')),
    });
    expect(await refused.run()).toEqual({ failed: 'website.refused' });
    expect(refused.raised.map((r) => r.type)).toEqual(['website.delivery_failed']);
    const ok = harness({ website: true });
    expect(await ok.run()).toEqual({ sent: true });
    expect(ok.resolved).toEqual(['website.delivery_failed']);
  });

  it('[WEB-6] a website write is sent only for a website account: any other is refused before a send', async () => {
    const h = harness({ website: true, accountProvider: 'ebay' });
    expect(await h.run()).toEqual({ failed: 'outbound.wrong_provider' });
    expect(h.sent).toEqual([]);
  });

  it('[WEB-2] every attempt of one write is sent with the same write id, the receiver idempotency key', async () => {
    let calls = 0;
    const h = harness({
      website: true,
      send: () =>
        calls++ === 0
          ? Promise.reject(new ProviderUnavailable('website', 503))
          : Promise.resolve({}),
    });
    await h.run();
    await h.run();
    expect(h.keys).toEqual([WRITE, WRITE]);
  });

  it('[SAFE-2] a write to a paused account is not sent and spends no attempt; once resumed it is sent once', async () => {
    const h = harness();
    h.switches.paused = true;
    expect(await h.run()).toEqual({ paused: 'kill_switch' });
    expect(h.sent).toEqual([]);
    expect(h.row).toMatchObject({ state: 'pending', pausedReason: 'kill_switch', attempts: 0 });
    // Unpaused (the resume re-dispatches it).
    h.switches.paused = false;
    expect(await h.run()).toEqual({ sent: true });
    expect(h.sent).toHaveLength(1);
    expect(h.row).toMatchObject({ state: 'sent', attempts: 1 });
    // Sent is final: a stray second job sends nothing.
    expect(await h.run()).toEqual({ skipped: 'sent' });
    expect(h.sent).toHaveLength(1);
  });

  it('[SAFE-3] maintenance holds every write, whatever its account', async () => {
    const h = harness();
    h.switches.maintenance = true;
    expect(await h.run()).toEqual({ paused: 'maintenance' });
    expect(h.sent).toEqual([]);
    expect(h.row.attempts).toBe(0);
  });

  it('[SAFE-2] the switches are read at send time, so turning one on after the write was queued stops it', async () => {
    const h = harness();
    // Queued while all was clear; the switch goes on before the worker gets to it.
    h.switches.paused = true;
    await h.run();
    expect(h.sent).toEqual([]);
  });

  it('[INT-2] every write passes the governor before it is sent; a refusal waits without spending an attempt', async () => {
    const order: string[] = [];
    let allow = false;
    const governor: ProviderGovernor = {
      admit: (input) => {
        order.push(`admit:${input.api}`);
        return Promise.resolve(
          allow
            ? { ok: true, usageRecorded: true }
            : { ok: false, retryAt: new Date(NOW.getTime() + 3_600_000) },
        );
      },
      run: (input, fn) => {
        order.push(`run:${input.api}`);
        return fn();
      },
    };
    const h = harness({ governor });
    expect(await h.run()).toEqual({ deferred: 'rate_limit' });
    expect(h.sent).toEqual([]);
    expect(h.row.attempts).toBe(0);
    expect(h.dispatched).toEqual([{ seq: 1, startAfter: new Date(NOW.getTime() + 3_600_000) }]);
    allow = true;
    expect(await h.run()).toEqual({ sent: true });
    expect(order.slice(1)).toEqual(['admit:auth', 'admit:sell.inventory', 'run:sell.inventory']);
  });

  it('[INT-2] a failure that may pass later is retried with backoff, and fails for good after the attempt limit', async () => {
    const h = harness({ send: () => Promise.reject(new ProviderUnavailable('ebay', 503)) });
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i += 1) {
      expect(await h.run()).toEqual({ deferred: 'retry' });
      expect(h.row.attempts).toBe(i);
    }
    expect(await h.run()).toEqual({ failed: 'provider.unavailable' });
    expect(h.row).toMatchObject({ state: 'failed', attempts: MAX_SEND_ATTEMPTS });
    // Each retry waits longer.
    const waits = h.dispatched.map((d) => (d.startAfter?.getTime() ?? 0) - NOW.getTime());
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
  });

  it('[RL-4] a Retry-After of a week defers the write by the 60-minute ceiling, not a week', async () => {
    const h = harness({
      send: () => Promise.reject(new RateLimited('website', { retryAfterMs: 7 * 86_400_000 })),
    });
    expect(await h.run()).toEqual({ deferred: 'retry' });
    expect(h.dispatched.at(-1)?.startAfter).toEqual(new Date(NOW.getTime() + MAX_DEFER_MS));
  });

  it('[INT-2] a write whose attempts were spent by dead workers is given up, never sent again', async () => {
    const h = harness({});
    h.row.attempts = MAX_SEND_ATTEMPTS;
    expect(await h.run()).toEqual({ failed: 'outbound.attempts_exhausted' });
    expect(h.sent).toEqual([]);
    expect(h.row).toMatchObject({ state: 'failed', attempts: MAX_SEND_ATTEMPTS });
  });

  it("[INT-2] eBay's own daily limit waits an hour at a time without spending an attempt", async () => {
    const h = harness({ send: () => Promise.reject(new RateLimited('ebay', { daily: true })) });
    for (let i = 0; i < MAX_SEND_ATTEMPTS + 2; i += 1) {
      expect(await h.run()).toEqual({ deferred: 'rate_limit' });
    }
    expect(h.row).toMatchObject({ state: 'pending', attempts: 0 });
    expect(h.dispatched.at(-1)?.startAfter).toEqual(new Date(NOW.getTime() + 3_600_000));
  });

  it('[RL-5] usage is written with the result of every send, the failed ones too, unless the governor already wrote it', async () => {
    const ok = harness({});
    expect(await ok.run()).toEqual({ sent: true });
    // The token call and the write, each under its own API name.
    expect(ok.usage).toEqual([
      { api: 'auth', calls: 1 },
      { api: 'sell.inventory', calls: 1 },
    ]);
    const failed = harness({ send: () => Promise.reject(new ProviderUnavailable('ebay', 503)) });
    expect(await failed.run()).toEqual({ deferred: 'retry' });
    expect(failed.usage).toEqual([
      { api: 'auth', calls: 1 },
      { api: 'sell.inventory', calls: 1 },
    ]);
    // eBay's reservation wrote the row itself (RL-2): not counted twice.
    const reserved = harness({
      governor: {
        admit: () => Promise.resolve({ ok: true, usageRecorded: true }),
        run: (_i, fn) => fn(),
      },
    });
    expect(await reserved.run()).toEqual({ sent: true });
    expect(reserved.usage).toEqual([]);
  });

  it('[INT-2] a rejection is final at once, with its stable code', async () => {
    const h = harness({ send: () => Promise.reject(new ProviderRejected('ebay', 'ebay.25001')) });
    expect(await h.run()).toEqual({ failed: 'provider.rejected' });
    expect(h.row).toMatchObject({ state: 'failed', attempts: 1, lastError: 'provider.rejected' });
  });
});
