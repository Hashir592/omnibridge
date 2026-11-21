/**
 * The eBay governor's shared daily budget (RL-2, EBAY-8, invariant 16): every worker call reserves
 * its calls in db-main before it is sent, per API and US Pacific day, app-wide. A separate code
 * path from the Amazon governor: no shared code, no retry helper (RL-3). eBay is never retried on
 * 429 here: the budget is the limit.
 */
import { providerDay, type TenantContext } from '@omnibridge/core';

/**
 * Daily call limits per API: eBay's published defaults for a new application (developer.ebay.com,
 * API call limits). M15 replaces them with getRateLimits, read hourly (EBAY-8).
 */
export const EBAY_DAILY_CAPS: Readonly<Record<string, number>> = {
  'identity.user_token': 50_000,
  'sell.fulfillment': 100_000,
  'sell.inventory': 2_000_000,
};

/** EBAY-8: non-urgent work stops at 80% of a cap, everything at 95%. */
export const EBAY_THRESHOLDS = { nonUrgentPercent: 80, hardPercent: 95 } as const;

/** db-main app.ebay_budget_daily through app.ebay_budget_reserve, in the caller's tenant context. */
export interface EbayBudgetStore {
  reserve(
    ctx: TenantContext,
    input: {
      channelAccountId: string;
      api: string;
      day: string;
      n: number;
      cap: number;
      percent: 80 | 95;
      now: Date;
    },
  ): Promise<{ reserved: boolean; calls: number; cap: number }>;
}

export type EbayReservation =
  | { ok: true; calls: number; cap: number; crossedNonUrgent: boolean }
  | { ok: false; calls: number; cap: number; retryAt: Date };

/** A refused reservation is tried again after this; a new Pacific day frees the budget. */
const RETRY_MS = 60 * 60_000;

export class EbayGovernor {
  readonly #store: EbayBudgetStore;
  readonly #caps: Readonly<Record<string, number>>;
  readonly #now: () => Date;

  constructor(
    store: EbayBudgetStore,
    caps: Readonly<Record<string, number>> = EBAY_DAILY_CAPS,
    now: () => Date = () => new Date(),
  ) {
    this.#store = store;
    this.#caps = caps;
    this.#now = now;
  }

  /** Reserves `n` calls (default 1) of `api` before they are sent. Refused: send nothing. */
  async reserve(
    ctx: TenantContext,
    input: { channelAccountId: string; api: string; urgent: boolean; n?: number },
  ): Promise<EbayReservation> {
    const cap = this.#caps[input.api];
    if (cap === undefined) throw new Error(`eBay API ${input.api} has no daily cap configured`);
    const n = input.n ?? 1;
    const now = this.#now();
    const percent = input.urgent ? EBAY_THRESHOLDS.hardPercent : EBAY_THRESHOLDS.nonUrgentPercent;
    const result = await this.#store.reserve(ctx, {
      channelAccountId: input.channelAccountId,
      api: input.api,
      day: providerDay('ebay', now),
      n,
      cap,
      percent,
      now,
    });
    if (!result.reserved) {
      return {
        ok: false,
        calls: result.calls,
        cap: result.cap,
        retryAt: new Date(now.getTime() + RETRY_MS),
      };
    }
    const limit = result.cap * EBAY_THRESHOLDS.nonUrgentPercent;
    return {
      ok: true,
      calls: result.calls,
      cap: result.cap,
      crossedNonUrgent: (result.calls - n) * 100 < limit && result.calls * 100 >= limit,
    };
  }
}
