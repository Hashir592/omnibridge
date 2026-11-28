import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { ProviderUnavailable, RateLimited, SlotsFull } from './errors.ts';

/** RL-4: parallel requests per carrier or website account (default 4). */
export const CARRIER_CONCURRENCY = 4;

/**
 * The PostgreSQL semaphore (packages/db JobLeaseRepository): at most `cap` holders per scope at
 * once, across every worker, with expiring leases so a dead worker frees its slot.
 */
export interface SlotLimiter {
  acquire(
    ctx: TenantContext,
    scopeKey: string,
    cap: number,
    holder: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  release(ctx: TenantContext, scopeKey: string, holder: string): Promise<void>;
}

/** How long a full account is left alone before its work is tried again (RL-4). */
export const SLOTS_FULL_RETRY_MS = 15_000;

/**
 * Runs `fn` while holding one of the account's slots (RL-4); a fifth caller waits for a free one,
 * polling, for at most `maxWaitMs` (5 s). Still full, it throws SlotsFull: a governor wait, tried
 * again later with no attempt spent (ADR-079 2), never a failure.
 */
export async function withCarrierSlot<T>(
  limiter: SlotLimiter,
  ctx: TenantContext,
  channelAccountId: string,
  fn: () => Promise<T>,
  options: {
    cap?: number;
    pollMs?: number;
    maxWaitMs?: number;
    ttlSeconds?: number;
    provider?: 'evri' | 'dpd' | 'website';
    now?: () => Date;
  } = {},
): Promise<T> {
  const scope = `http:${channelAccountId}`;
  const holder = randomUUID();
  const cap = options.cap ?? CARRIER_CONCURRENCY;
  const ttl = options.ttlSeconds ?? 120;
  const now = options.now ?? (() => new Date());
  const deadline = Date.now() + (options.maxWaitMs ?? 5_000);
  while (!(await limiter.acquire(ctx, scope, cap, holder, ttl))) {
    if (Date.now() > deadline) {
      const at = now();
      throw new SlotsFull(
        options.provider ?? 'evri',
        new Date(at.getTime() + SLOTS_FULL_RETRY_MS),
        at,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  }
  try {
    return await fn();
  } finally {
    await limiter.release(ctx, scope, holder);
  }
}

/** The longest wait the backoff sleeps in place, holding the account's slot (F-M07-T0702-01). */
export const CARRIER_MAX_WAIT_MS = 10_000;

/**
 * The carriers' and website's own backoff on 429 or 5xx (RL-4): a few tries with exponential waits
 * (Retry-After when sent). Only for carriers and the website; the Amazon and eBay governors never
 * import it (RL-3, dependency-cruiser `kit-carrier-backoff-only-carriers`).
 *
 * It runs inside `withCarrierSlot`, whose lease (120 s) is never renewed, and inside an outbound
 * claim that the sweep treats as stale after 10 minutes. So it never sleeps longer than `maxMs`
 * (default 10 s): a provider that asks for a longer Retry-After gets its RateLimited back at once,
 * and runOutboundSend defers the write until then with no slot or claim held. Worst case of one
 * run, with the default 3 attempts and the client's 15 s timeout: 3 x 15 s + 2 x 10 s = 65 s, under
 * both the lease and the stale-claim limit.
 */
export async function carrierBackoff<T>(
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    baseMs?: number;
    maxMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const maxMs = options.maxMs ?? CARRIER_MAX_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const again = err instanceof RateLimited || err instanceof ProviderUnavailable;
      if (!again || attempt >= attempts) throw err;
      const asked = err instanceof RateLimited ? err.retryAfterMs : undefined;
      // A longer Retry-After than the in-place cap goes back to the caller to defer (RL-4).
      if (asked !== undefined && asked > maxMs) throw err;
      const wait = asked ?? Math.min(maxMs, (options.baseMs ?? 1_000) * 2 ** (attempt - 1));
      await sleep(wait);
    }
  }
}
