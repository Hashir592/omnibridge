import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { ProviderUnavailable, RateLimited } from './errors.ts';

/** RL-4: parallel requests per carrier or website account (default 4). */
export const CARRIER_CONCURRENCY = 4;

/**
 * The PostgreSQL semaphore (packages/db JobLeaseRepository): at most `cap` holders per scope at
 * once, across every worker, with expiring leases so a dead worker frees its slot.
 */
export interface SlotLimiter {
  acquire(ctx: TenantContext, scopeKey: string, cap: number, holder: string, ttlSeconds: number): Promise<boolean>;
  release(ctx: TenantContext, scopeKey: string, holder: string): Promise<void>;
}

/**
 * Runs `fn` while holding one of the account's slots (RL-4); a fifth caller waits for a free one,
 * polling, and gives up with ProviderUnavailable (retried later) after `maxWaitMs`.
 */
export async function withCarrierSlot<T>(
  limiter: SlotLimiter,
  ctx: TenantContext,
  channelAccountId: string,
  fn: () => Promise<T>,
  options: { cap?: number; pollMs?: number; maxWaitMs?: number; ttlSeconds?: number; provider?: 'evri' | 'dpd' | 'website' } = {},
): Promise<T> {
  const scope = `http:${channelAccountId}`;
  const holder = randomUUID();
  const cap = options.cap ?? CARRIER_CONCURRENCY;
  const ttl = options.ttlSeconds ?? 120;
  const deadline = Date.now() + (options.maxWaitMs ?? 30_000);
  while (!(await limiter.acquire(ctx, scope, cap, holder, ttl))) {
    if (Date.now() > deadline) throw new ProviderUnavailable(options.provider ?? 'evri');
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  }
  try {
    return await fn();
  } finally {
    await limiter.release(ctx, scope, holder);
  }
}

/**
 * The carriers' and website's own backoff on 429 or 5xx (RL-4): a few tries with exponential waits
 * (Retry-After when sent). Only for carriers and the website; the Amazon and eBay governors never
 * import it (RL-3, dependency-cruiser `kit-carrier-backoff-only-carriers`).
 */
export async function carrierBackoff<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const again = err instanceof RateLimited || err instanceof ProviderUnavailable;
      if (!again || attempt >= attempts) throw err;
      const wait =
        err instanceof RateLimited && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : Math.min(options.maxMs ?? 30_000, (options.baseMs ?? 1_000) * 2 ** (attempt - 1));
      await sleep(wait);
    }
  }
}
