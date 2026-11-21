import type { RaiseInput } from '@omnibridge/core';
import { AmazonGovernor, type AmazonBucketStore } from '@omnibridge/governor-amazon';
import { EbayGovernor, type EbayBudgetStore } from '@omnibridge/governor-ebay';
import { RateLimited, type CallInput } from '@omnibridge/provider-kit';
import type { SlotLimiter } from '@omnibridge/provider-kit/carrier';
import { describe, expect, it } from 'vitest';
import { createProviderGovernor } from './governor.ts';

const WS = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
const call = (provider: CallInput['provider'], api: string): CallInput => ({
  workspaceId: WS,
  channelAccountId: ACCOUNT,
  provider,
  api,
  urgent: false,
});

/** The governors over in-memory stores with the db repositories' contracts. */
function governors(now: Date) {
  const rates: { operation: string; rate: number }[] = [];
  const buckets: AmazonBucketStore = {
    take: () => Promise.resolve({ ok: true }),
    setRate: (_c, input) => {
      rates.push({ operation: input.operation, rate: input.rate });
      return Promise.resolve();
    },
  };
  const calls = new Map<string, number>();
  const budget: EbayBudgetStore = {
    reserve: (_c, input) => {
      const key = `${input.api}|${input.day}`;
      const used = (calls.get(key) ?? 0) + input.n;
      calls.set(key, used);
      return Promise.resolve({ reserved: true, calls: used, cap: input.cap });
    },
  };
  let held = 0;
  let peak = 0;
  const limiter: SlotLimiter = {
    acquire: (_c, _s, cap) => {
      if (held >= cap) return Promise.resolve(false);
      held += 1;
      peak = Math.max(peak, held);
      return Promise.resolve(true);
    },
    release: () => {
      held -= 1;
      return Promise.resolve();
    },
  };
  const raised: RaiseInput[] = [];
  const governor = createProviderGovernor({
    amazon: new AmazonGovernor(buckets, () => now),
    ebay: new EbayGovernor(budget, { 'sell.inventory': 10 }, () => now),
    limiter,
    notifier: {
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
    now: () => now,
  });
  return { governor, rates, raised, peak: () => peak };
}

describe('the worker governor (RL-1, RL-2, RL-4, EBAY-8)', () => {
  it('[RL-1] an Amazon 429 carrying x-amzn-RateLimit-Limit teaches the seller bucket that rate', async () => {
    const g = governors(new Date('2026-11-21T12:00:00.000Z'));
    let n = 0;
    const result = await g.governor.run(call('amazon', 'listings.patchListingsItem'), () => {
      n += 1;
      return n === 1
        ? Promise.reject(new RateLimited('amazon', { limitPerSecond: 2 }))
        : Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(g.rates).toEqual([{ operation: 'listings.patchListingsItem', rate: 2 }]);
  });

  it("[EBAY-8] the 80% notice is keyed by eBay's US Pacific day, once", async () => {
    // 07:00 UTC on 21 Nov is still 20 Nov in California.
    const g = governors(new Date('2026-11-21T07:00:00.000Z'));
    for (let i = 0; i < 9; i += 1) await g.governor.admit(call('ebay', 'sell.inventory'));
    expect(g.raised).toHaveLength(1);
    expect(g.raised[0]?.record).toEqual({ kind: 'ebay_api_sell_inventory', id: '2026-11-20' });
  });

  it('[RL-4] website calls run inside the account cap of 4', async () => {
    const g = governors(new Date('2026-11-21T12:00:00.000Z'));
    const releases: (() => void)[] = [];
    const runs = Array.from({ length: 6 }, () =>
      g.governor.run(
        call('website', 'api.stock'),
        () => new Promise<void>((resolve) => releases.push(resolve)),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(releases).toHaveLength(4);
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((r) => setTimeout(r, 150));
    }
    await Promise.all(runs);
    expect(g.peak()).toBe(4);
  });
});
