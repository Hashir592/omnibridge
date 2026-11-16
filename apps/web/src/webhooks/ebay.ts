/**
 * eBay Marketplace Account Deletion endpoint (EBAY-2, T-0602). Served by web and, for the early
 * public deploy, by the database-free ebay-endpoint server; the same handlers in both.
 *
 * No eBay data is held yet, so a verified notice leaves only a receipt in the log: the topic, the
 * time and that it was verified, never the user's id, name, token or the notification id. M04
 * wires the real deletion (FA-14: match in the vault, queue only on a hit).
 *
 * The signature check fetches eBay's public key through packages/providers (cached an hour per
 * kid). It is the one named exception to "web makes no provider calls" (invariant 15, ADR-058):
 * eBay needs the answer within 3 seconds, so it cannot wait for the queue. Each call is counted
 * against the eBay governor's daily budget before it is sent (invariant 16); once the budget is
 * spent the notice is answered 412 and eBay sends it again later.
 */
import { ApiError, readSecretFile, requireEnv } from '@omnibridge/core';
import type {
  AnyRoute,
  ebayAccountDeletion,
  ebayAccountDeletionChallenge,
} from '@omnibridge/contract';
import { DailyCallBudget, EBAY_WEBHOOK_DAILY_BUDGET } from '@omnibridge/governor-ebay';
import type { Logger } from '@omnibridge/logger';
import {
  challengeResponse,
  EbayBudgetExhausted,
  ebayPublicKeyFetcher,
  isVerificationToken,
  PublicKeyCache,
  verifyNotification,
  type PublicKeySource,
} from '@omnibridge/provider-ebay';
import type { FastifyRequest } from 'fastify';
import type { RouteHandler } from '../contract.ts';

export interface EbayWebhookOptions {
  /** The verification token given to eBay (32 to 80 characters), a Docker secret. */
  verificationToken: string;
  /** The endpoint URL exactly as subscribed at eBay; it is part of the challenge hash. */
  endpoint: string;
  /** eBay's public keys, cached (PublicKeyCache over ebayPublicKeyFetcher). */
  keys: PublicKeySource;
  logger: Logger;
  /** Requests a minute from one address before 429 (default 60). */
  perMinute?: number;
  now?: () => number;
}

export interface EbayWebhook {
  handlers: {
    ebayAccountDeletionChallenge: RouteHandler<typeof ebayAccountDeletionChallenge>;
    ebayAccountDeletion: RouteHandler<typeof ebayAccountDeletion>;
  };
  verify: (request: FastifyRequest) => Promise<boolean>;
}

/**
 * A fixed one-minute window per client address, counting only what a flood would send: challenge
 * requests and notices that fail verification. eBay's own verified notices are never limited,
 * however many arrive together from its few addresses.
 */
function rateLimiter(perMinute: number, now: () => number) {
  const windows = new Map<string, { start: number; count: number }>();
  const current = (ip: string) => {
    const t = now();
    const w = windows.get(ip);
    if (w !== undefined && t - w.start < 60_000) return w;
    if (windows.size > 10_000) windows.clear();
    const fresh = { start: t, count: 0 };
    windows.set(ip, fresh);
    return fresh;
  };
  return {
    /** Refuses with 429 once the address has used its minute. */
    check(ip: string): void {
      const w = current(ip);
      if (w.count >= perMinute) {
        throw new ApiError({
          status: 429,
          code: 'rate_limited',
          retryAfterSeconds: Math.max(1, Math.ceil((w.start + 60_000 - now()) / 1000)),
        });
      }
    },
    count(ip: string): void {
      current(ip).count += 1;
    },
  };
}

export function ebayWebhook(options: EbayWebhookOptions): EbayWebhook {
  if (!isVerificationToken(options.verificationToken)) {
    throw new Error('EBAY verification token must be 32 to 80 letters, digits, _ or -');
  }
  const limit = rateLimiter(options.perMinute ?? 60, options.now ?? Date.now);
  const verify = async (request: FastifyRequest): Promise<boolean> => {
    // Checked before verifying, so a flood of bad notices cannot make us fetch keys from eBay.
    limit.check(request.ip);
    const header = request.headers['x-ebay-signature'];
    let ok: boolean;
    try {
      ok = await verifyNotification(
        request.body,
        typeof header === 'string' ? header : undefined,
        options.keys,
      );
    } catch (err) {
      if (err instanceof EbayBudgetExhausted) {
        // The governor refused before sending (ADR-058): 412, and eBay retries later.
        options.logger.warn(
          { event: 'ebay.budget_exhausted' },
          `eBay daily budget spent (${err.api}): public key not read`,
        );
        throw new ApiError({ status: 412, code: 'precondition_failed' });
      }
      // Not the sender's fault: answer 503 so eBay retries, and say what failed.
      options.logger.error(
        { event: 'ebay.public_key_unavailable', err },
        'eBay public key could not be fetched',
      );
      throw new ApiError({ status: 503, code: 'service_unavailable' });
    }
    if (!ok) {
      limit.count(request.ip);
      options.logger.warn(
        { event: 'ebay.account_deletion.rejected' },
        'eBay notice: bad signature',
      );
    }
    return ok;
  };
  return {
    verify,
    handlers: {
      ebayAccountDeletionChallenge: ({ query, request }) => {
        limit.check(request.ip);
        limit.count(request.ip);
        return Promise.resolve({
          status: 200,
          body: {
            challengeResponse: challengeResponse(
              query.challenge_code,
              options.verificationToken,
              options.endpoint,
            ),
          },
          headers: { 'cache-control': 'no-store' },
        });
      },
      ebayAccountDeletion: ({ body }) => {
        // The receipt: no identifier of the eBay user or of the notice (EBAY-2, invariant 5).
        options.logger.info(
          { event: 'ebay.account_deletion.received', topic: body.metadata.topic, verified: true },
          'eBay account deletion notice received',
        );
        return Promise.resolve({ status: 204, body: null });
      },
    },
  };
}

const unavailable = () =>
  Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' }));

/** The handlers of both routes; without an endpoint configured they answer 503. */
export function ebayHandlers(ebay: EbayWebhook | undefined): EbayWebhook['handlers'] {
  return (
    ebay?.handlers ?? {
      ebayAccountDeletionChallenge: unavailable,
      ebayAccountDeletion: unavailable,
    }
  );
}

/** The signed-webhook check for the contract: only the eBay notice, anything else fails. */
export function webhookVerifier(ebay: EbayWebhook) {
  return (request: FastifyRequest, route: AnyRoute): Promise<boolean> =>
    route.id === 'ebayAccountDeletion' ? ebay.verify(request) : Promise.resolve(false);
}

/**
 * The endpoint from the environment, or undefined when it is not configured (then it answers
 * 503 and 401). EBAY_VERIFICATION_TOKEN_FILE, EBAY_CLIENT_ID_FILE and EBAY_CLIENT_SECRET_FILE are
 * Docker secrets (SEC-5); EBAY_ENDPOINT_URL is the URL as subscribed at eBay; EBAY_API_BASE is
 * https://api.ebay.com in production and the provider mocks in dev and CI (ADR-011).
 */
export function ebayWebhookFromEnv(logger: Logger): EbayWebhook | undefined {
  if (!process.env.EBAY_VERIFICATION_TOKEN_FILE) return undefined;
  const budget = new DailyCallBudget(EBAY_WEBHOOK_DAILY_BUDGET);
  const keys = new PublicKeyCache(
    ebayPublicKeyFetcher({
      apiBase: requireEnv('EBAY_API_BASE'),
      clientId: readSecretFile('EBAY_CLIENT_ID'),
      clientSecret: readSecretFile('EBAY_CLIENT_SECRET'),
      budget: (api) => budget.take(api),
    }),
  );
  return ebayWebhook({
    verificationToken: readSecretFile('EBAY_VERIFICATION_TOKEN'),
    endpoint: requireEnv('EBAY_ENDPOINT_URL'),
    keys: keys.get,
    logger,
  });
}
