import { CAPPED_PROVIDERS, providerDay, type Notifier, type TenantContext } from '@omnibridge/core';
import { AmazonGovernor, withAmazonBackoff } from '@omnibridge/governor-amazon';
import { EbayGovernor } from '@omnibridge/governor-ebay';
import type { CallInput, ProviderGovernor } from '@omnibridge/provider-kit';
import {
  carrierBackoff,
  withCarrierSlot,
  type SlotLimiter,
} from '@omnibridge/provider-kit/carrier';

/** The eBay token call is counted against its identity API (EBAY-8). */
const EBAY_AUTH_API = 'identity.user_token';

/**
 * The rate governors behind the provider kit's one interface (INT-2): the Amazon and eBay
 * governors stay separate packages with nothing shared (RL-3); this file only routes each call to
 * its provider's own rule.
 *
 * - Amazon: a token from the seller's bucket per operation before the call (RL-1); a 429 is backed
 *   off with full jitter by the Amazon governor's own helper, and the rate it reports is learned.
 * - eBay: the app-wide budget is reserved before every call (RL-2, EBAY-8); crossing 80% raises
 *   the platform notice once. Its reservation writes the usage row (RL-5).
 * - Carriers and the website: at most 4 requests at once per account, with their own backoff (RL-4).
 */
export function createProviderGovernor(deps: {
  amazon: AmazonGovernor;
  ebay: EbayGovernor;
  limiter: SlotLimiter;
  notifier: Pick<Notifier, 'raisePlatform'>;
  now?: () => Date;
}): ProviderGovernor {
  const now = deps.now ?? (() => new Date());
  const ctxOf = (input: CallInput): TenantContext => ({
    workspaceId: input.workspaceId,
    companyIds: [],
  });
  return {
    async admit(input) {
      if (input.provider === 'amazon') {
        const take = await deps.amazon.take(ctxOf(input), input.channelAccountId, input.api);
        return take.ok
          ? { ok: true, usageRecorded: false }
          : { ok: false, retryAt: new Date(now().getTime() + take.waitMs) };
      }
      if (input.provider === 'ebay') {
        const api = input.api === 'auth' ? EBAY_AUTH_API : input.api;
        const reserved = await deps.ebay.reserve(ctxOf(input), {
          channelAccountId: input.channelAccountId,
          api,
          urgent: input.urgent,
        });
        if (!reserved.ok) return { ok: false, retryAt: reserved.retryAt };
        if (reserved.crossedNonUrgent) {
          // EBAY-8: one warning per API and Pacific day, to platform admins.
          await deps.notifier.raisePlatform(null, {
            type: 'ebay.api_usage_high',
            record: {
              kind: `ebay_api_${api.replace(/[^a-z0-9]/g, '_')}`.slice(0, 40),
              // eBay's own day (US Pacific), the day the budget counts.
              id: providerDay('ebay', now()),
            },
          });
        }
        return { ok: true, usageRecorded: true };
      }
      return { ok: true, usageRecorded: false };
    },

    run(input, fn) {
      if (input.provider === 'amazon') {
        return withAmazonBackoff(fn, {
          onRateLimit: (rate) =>
            deps.amazon.learn(ctxOf(input), input.channelAccountId, input.api, rate),
        });
      }
      if ((CAPPED_PROVIDERS as readonly string[]).includes(input.provider)) {
        return withCarrierSlot(deps.limiter, ctxOf(input), input.channelAccountId, () =>
          carrierBackoff(fn),
        );
      }
      return fn();
    },
  };
}
