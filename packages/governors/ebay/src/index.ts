/**
 * eBay count-before-send budget governor (RL-2, invariant 16). Must share no code with the Amazon
 * governor.
 *
 * Today it holds the in-process daily budget of the one eBay call made outside the worker: the
 * account deletion webhook's public key read (ADR-058). One process serves that webhook in each
 * deployment (web, or the early ebay-endpoint server), so its count is the whole app's. M07 adds
 * the shared budget in db-main for the worker's calls (EBAY-8, EBAY-9).
 */
export const PACKAGE_NAME = '@omnibridge/governor-ebay';

/**
 * Calls a day per API for the webhook's key read. Far under eBay's own limits, so a day counted
 * in UTC here and in Pacific time at eBay can never add up past them. A key is cached an hour per
 * kid and an application token for about two, so a normal day uses a few dozen.
 */
export const EBAY_WEBHOOK_DAILY_BUDGET = {
  'identity.app_token': 100,
  'notification.public_key': 500,
} as const;

/** A hard daily budget per API, counted before each call is sent (RL-2). */
export class DailyCallBudget<Api extends string> {
  readonly #limits: Readonly<Record<Api, number>>;
  readonly #now: () => number;
  readonly #used = new Map<Api, number>();
  #day = '';

  constructor(limits: Readonly<Record<Api, number>>, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  /**
   * Counts one call to `api`, before it is sent. False when today's budget is spent: then the
   * call must not be sent, and nothing is counted.
   */
  take(api: Api): boolean {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#used.clear();
    }
    const used = this.#used.get(api) ?? 0;
    if (used >= this.#limits[api]) return false;
    this.#used.set(api, used + 1);
    return true;
  }
}

export {
  EBAY_DAILY_CAPS,
  EBAY_THRESHOLDS,
  EbayGovernor,
  type EbayBudgetStore,
  type EbayReservation,
} from './budget.ts';
