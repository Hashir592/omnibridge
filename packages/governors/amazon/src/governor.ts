/**
 * The Amazon governor (RL-1, AMZ-9): token buckets per seller and operation in PostgreSQL, and its
 * own full-jitter backoff on 429. A separate code path from the eBay governor: it shares no code,
 * no retry helper and no import with it (RL-3, invariant 16; dependency-cruiser rules).
 */
import type { TenantContext } from '@omnibridge/core';

/**
 * SP-API usage plans per operation (requests per second and burst), from the operation pages of
 * the Selling Partner API docs. x-amzn-RateLimit-Limit overrides a rate when Amazon sends it.
 */
export const AMAZON_OPERATION_LIMITS: Readonly<Record<string, { rate: number; burst: number }>> = {
  'orders.getOrders': { rate: 0.0167, burst: 20 },
  'orders.getOrder': { rate: 0.5, burst: 30 },
  'orders.getOrderItems': { rate: 0.5, burst: 30 },
  'listings.getListingsItem': { rate: 5, burst: 10 },
  'listings.patchListingsItem': { rate: 5, burst: 10 },
  'feeds.createFeed': { rate: 0.0083, burst: 15 },
  'reports.createReport': { rate: 0.0167, burst: 15 },
  'tokens.createRestrictedDataToken': { rate: 1, burst: 10 },
};
/** An operation not listed yet gets a cautious plan until its own is added. */
const UNKNOWN = { rate: 0.5, burst: 1 };
/** Login with Amazon token calls: not SP-API operations, no usage plan. */
const UNMETERED = new Set(['lwa.token', 'auth']);

export const AMAZON_BACKOFF = { baseMs: 1_000, maxMs: 60_000, attempts: 8 } as const;

export type BucketTake = { ok: true } | { ok: false; waitMs: number };

/** db-main app.amazon_rate_buckets, in the caller's tenant context. */
export interface AmazonBucketStore {
  take(
    ctx: TenantContext,
    input: { channelAccountId: string; operation: string; rate: number; burst: number; now: Date },
  ): Promise<BucketTake>;
  setRate(
    ctx: TenantContext,
    input: { channelAccountId: string; operation: string; rate: number; now: Date },
  ): Promise<void>;
}

export class AmazonGovernor {
  readonly #store: AmazonBucketStore;
  readonly #now: () => Date;

  constructor(store: AmazonBucketStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  /** Spends one token of this seller's bucket for the operation, or says how long to wait. */
  take(ctx: TenantContext, channelAccountId: string, operation: string): Promise<BucketTake> {
    if (UNMETERED.has(operation)) return Promise.resolve({ ok: true });
    const plan = AMAZON_OPERATION_LIMITS[operation] ?? UNKNOWN;
    return this.#store.take(ctx, {
      channelAccountId,
      operation,
      rate: plan.rate,
      burst: plan.burst,
      now: this.#now(),
    });
  }

  /** x-amzn-RateLimit-Limit: Amazon told us this seller's rate for the operation (AMZ-9). */
  learn(ctx: TenantContext, channelAccountId: string, operation: string, rate: number): Promise<void> {
    if (UNMETERED.has(operation) || !(rate > 0)) return Promise.resolve();
    return this.#store.setRate(ctx, { channelAccountId, operation, rate, now: this.#now() });
  }
}

/** Full jitter (AMZ-9): a random wait between 0 and min(60 s, 1 s x 2^retry). */
export function amazonBackoffMs(retry: number, random: () => number = Math.random): number {
  const cap = Math.min(AMAZON_BACKOFF.maxMs, AMAZON_BACKOFF.baseMs * 2 ** retry);
  return Math.floor(random() * cap);
}

/** Eight attempts were rate-limited: the caller requeues the work for later (AMZ-9). */
export class AmazonBackoffSpent extends Error {
  constructor() {
    super('Amazon kept answering 429; requeue');
    this.name = 'AmazonBackoffSpent';
  }
}

/**
 * Runs `fn`, retrying a 429 (an error named RateLimited) with full jitter up to 8 attempts, then
 * throws AmazonBackoffSpent. Any other error is thrown at once.
 */
export async function withAmazonBackoff<T>(
  fn: () => Promise<T>,
  options: {
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    onRateLimit?: (limitPerSecond: number) => Promise<void> | void;
  } = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < AMAZON_BACKOFF.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'RateLimited') throw err;
      const perSecond = (err as Error & { limitPerSecond?: unknown }).limitPerSecond;
      if (typeof perSecond === 'number') await options.onRateLimit?.(perSecond);
      if (attempt === AMAZON_BACKOFF.attempts - 1) break;
      await sleep(amazonBackoffMs(attempt, options.random));
    }
  }
  throw new AmazonBackoffSpent();
}
