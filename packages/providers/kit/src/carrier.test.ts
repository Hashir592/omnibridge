import type { TenantContext } from '@omnibridge/core';
import { describe, expect, it } from 'vitest';
import {
  carrierBackoff,
  CARRIER_CONCURRENCY,
  withCarrierSlot,
  type SlotLimiter,
} from './carrier.ts';
import { ProviderRejected, ProviderUnavailable, RateLimited } from './errors.ts';

const ctx: TenantContext = { workspaceId: '00000000-0000-4000-8000-000000000001', companyIds: [] };
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';

/** The PostgreSQL semaphore's contract, in memory. */
function memoryLimiter(): SlotLimiter {
  const held = new Set<string>();
  return {
    acquire: (_c, _s, cap, holder) => {
      if (held.size >= cap) return Promise.resolve(false);
      held.add(holder);
      return Promise.resolve(true);
    },
    release: (_c, _s, holder) => {
      held.delete(holder);
      return Promise.resolve();
    },
  };
}

describe('carrier and website concurrency cap (RL-4)', () => {
  it('[RL-4] at most 4 requests run at once per account; a fifth waits for a free slot, then runs', async () => {
    expect(CARRIER_CONCURRENCY).toBe(4);
    const limiter = memoryLimiter();
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const call = () =>
      withCarrierSlot(
        limiter,
        ctx,
        ACCOUNT,
        async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise<void>((resolve) => releases.push(resolve));
          running -= 1;
          return 'done';
        },
        { pollMs: 5 },
      );
    const five = [call(), call(), call(), call(), call()];
    await new Promise((r) => setTimeout(r, 30));
    expect(running).toBe(4);
    // The fifth is still waiting; one finishes and it starts.
    releases.shift()?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(running).toBe(4);
    for (const release of releases.splice(0)) release();
    await new Promise((r) => setTimeout(r, 30));
    for (const release of releases.splice(0)) release();
    expect(await Promise.all(five)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(peak).toBe(4);
  });

  it('[RL-4] a carrier 429 or 5xx is retried with growing waits; a rejection is not', async () => {
    const waits: number[] = [];
    let n = 0;
    const result = await carrierBackoff(
      () => {
        n += 1;
        if (n === 1) return Promise.reject(new RateLimited('evri', { retryAfterMs: 1_500 }));
        if (n === 2) return Promise.reject(new ProviderUnavailable('evri', 502));
        return Promise.resolve('ok');
      },
      {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(result).toBe('ok');
    expect(waits).toEqual([1_500, 2_000]);
    await expect(
      carrierBackoff(() => Promise.reject(new ProviderRejected('evri', 'evri.invalid')), {
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toBeInstanceOf(ProviderRejected);
  });
});
