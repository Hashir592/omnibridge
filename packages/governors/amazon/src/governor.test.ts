import type { TenantContext } from '@omnibridge/core';
import { describe, expect, it } from 'vitest';
import {
  AMAZON_BACKOFF,
  AmazonBackoffSpent,
  amazonBackoffMs,
  AmazonGovernor,
  type AmazonBucketStore,
  withAmazonBackoff,
} from './governor.ts';

const ctx: TenantContext = { workspaceId: '00000000-0000-4000-8000-000000000001', companyIds: [] };
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';

/** A rate-limited error as the provider kit throws it (matched by name: no shared code, RL-3). */
const limited = (limitPerSecond?: number) =>
  Object.assign(new Error('rate limited'), { name: 'RateLimited', limitPerSecond });

describe('Amazon governor (RL-1, AMZ-9)', () => {
  it('[RL-1] full jitter: each wait is random between 0 and min(60 s, 1 s x 2^retry)', () => {
    expect(AMAZON_BACKOFF).toEqual({ baseMs: 1_000, maxMs: 60_000, attempts: 8 });
    expect(amazonBackoffMs(0, () => 0.999)).toBeLessThan(1_000);
    expect(amazonBackoffMs(3, () => 0.5)).toBe(4_000);
    expect(amazonBackoffMs(10, () => 1)).toBe(60_000);
    expect(amazonBackoffMs(10, () => 0)).toBe(0);
  });

  it('[RL-1] a 429 storm backs off with full jitter and recovers when it passes', async () => {
    const waits: number[] = [];
    let calls = 0;
    const learned: number[] = [];
    const result = await withAmazonBackoff(
      () => {
        calls += 1;
        return calls <= 3 ? Promise.reject(limited(0.0167)) : Promise.resolve('ok');
      },
      {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
        random: () => 0.5,
        onRateLimit: (perSecond) => {
          learned.push(perSecond);
        },
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(waits).toEqual([500, 1_000, 2_000]);
    // x-amzn-RateLimit-Limit is used when it is sent (AMZ-9).
    expect(learned).toEqual([0.0167, 0.0167, 0.0167]);
  });

  it('[RL-1] after 8 attempts it stops so the work is requeued; other errors pass straight through', async () => {
    let calls = 0;
    const err = await withAmazonBackoff(
      () => {
        calls += 1;
        return Promise.reject(limited());
      },
      { sleep: () => Promise.resolve(), random: () => 0 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmazonBackoffSpent);
    expect(calls).toBe(8);
    await expect(
      withAmazonBackoff(() => Promise.reject(new Error('boom')), { sleep: () => Promise.resolve() }),
    ).rejects.toThrow('boom');
  });

  it('[RL-1] buckets are per seller and operation, with the documented rate; an unknown operation is limited too', async () => {
    const takes: { operation: string; rate: number; burst: number }[] = [];
    const store: AmazonBucketStore = {
      take: (_ctx, input) => {
        takes.push({ operation: input.operation, rate: input.rate, burst: input.burst });
        return Promise.resolve(input.operation === 'orders.getOrders' ? { ok: false, waitMs: 59_880 } : { ok: true });
      },
      setRate: () => Promise.resolve(),
    };
    const governor = new AmazonGovernor(store);
    expect(await governor.take(ctx, ACCOUNT, 'orders.getOrders')).toEqual({ ok: false, waitMs: 59_880 });
    expect(await governor.take(ctx, ACCOUNT, 'listings.patchListingsItem')).toEqual({ ok: true });
    expect(await governor.take(ctx, ACCOUNT, 'something.new')).toEqual({ ok: true });
    // LWA token calls are not SP-API operations: no bucket.
    expect(await governor.take(ctx, ACCOUNT, 'lwa.token')).toEqual({ ok: true });
    expect(takes).toEqual([
      { operation: 'orders.getOrders', rate: 0.0167, burst: 20 },
      { operation: 'listings.patchListingsItem', rate: 5, burst: 10 },
      { operation: 'something.new', rate: 0.5, burst: 1 },
    ]);
  });
});
