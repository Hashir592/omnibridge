/**
 * eBay Marketplace Account Deletion endpoint (EBAY-2, T-0602). Served by web and, for the early
 * public deploy, by the database-free ebay-endpoint server; the same handlers in both.
 *
 * A verified notice (T-0404, AT-10, FA-14): the vault matches the eBay user in every workspace
 * that holds PII, and each workspace with a hit gets one deletion job of those refs only (IDs,
 * never the user's id or name, invariant 7a). No hit, no job. The receipt in the log holds the
 * topic and counts only. Without the vault (the database-free early-deploy server) a notice
 * leaves only the receipt.
 *
 * The signature check fetches eBay's public key through packages/providers (cached an hour per
 * kid). It is the one named exception to "web makes no provider calls" (invariant 15, ADR-058):
 * eBay needs the answer within 3 seconds, so it cannot wait for the queue. Each call is counted
 * against the eBay governor's daily budget before it is sent (invariant 16); once the budget is
 * spent the notice is answered 412 and eBay sends it again later.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ApiError, readSecretFile, requireEnv, type TenantRunner } from '@omnibridge/core';
import type {
  AnyRoute,
  ebayAccountDeletion,
  ebayAccountDeletionChallenge,
} from '@omnibridge/contract';
import { DailyCallBudget, EBAY_WEBHOOK_DAILY_BUDGET } from '@omnibridge/governor-ebay';
import type { ChannelAccountRepository } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { requestDeletion, type JobQueue } from '@omnibridge/queue';
import type { EbayUserMatchCursor, VaultClient } from '@omnibridge/vault-client';
import {
  challengeResponse,
  EbayBudgetExhausted,
  EbayKeyFetchThrottled,
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
  /** AT-10: match in the vault and queue the deletion. Without it, a receipt only. */
  deletion?: EbayDeletionDeps;
  /** Requests a minute from one address before 429 (default 60). */
  perMinute?: number;
  now?: () => number;
}

export interface EbayDeletionDeps {
  vault: Pick<VaultClient, 'ebayUserMatch'>;
  accounts: Pick<ChannelAccountRepository, 'list'>;
  tenancy: TenantRunner;
  queue: Pick<JobQueue, 'send'>;
}

/** The notice's own fields (eBay's schema): read here, never logged or stored. */
function noticeUser(notification: Record<string, unknown>): {
  notificationId: string | undefined;
  userId: string | undefined;
  username: string | undefined;
} {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  const data = (notification.data ?? {}) as Record<string, unknown>;
  return {
    notificationId: text(notification.notificationId),
    userId: text(data.userId),
    username: text(data.username),
  };
}

/**
 * Pages of the vault's eBay user match one notice may take (5,000 refs each, A-001). Past this the
 * notice fails loudly (503, eBay retries; every batch already queued runs once), never silently.
 */
const MAX_MATCH_PAGES = 1_000;

/**
 * Queues the deletion of one eBay user's records: per workspace, only records on that
 * workspace's eBay accounts (an order contact) or eBay-only kinds (messages, feedback), so a
 * same-named buyer on another channel is never touched. Returns counts for the receipt.
 *
 * A-001 (ADR-069): every match is found and queued before the 200. The vault answers in pages of
 * at most 5,000 refs (the most one deletion job holds); each page's batch per workspace is one
 * job, keyed by the notice and a hash of its refs, so a notice sent again queues each exact batch
 * once, and a batch that differs (records deleted since shift the pages) is never skipped.
 */
async function queueEbayDeletion(
  deps: EbayDeletionDeps,
  notice: ReturnType<typeof noticeUser>,
  logger: Logger,
): Promise<{ workspaces: number; records: number }> {
  if (notice.userId === undefined && notice.username === undefined) {
    return { workspaces: 0, records: 0 };
  }
  const key = notice.notificationId ?? randomUUID();
  const hit = new Set<string>();
  let records = 0;
  let cursor: EbayUserMatchCursor | null = null;
  let pages = 0;
  do {
    if (pages === MAX_MATCH_PAGES) {
      logger.error(
        { event: 'ebay.account_deletion.too_large', pages, records },
        'eBay notice matched more records than one notice may queue: not finished',
      );
      throw new ApiError({ status: 503, code: 'service_unavailable' });
    }
    pages += 1;
    const found = await deps.vault.ebayUserMatch({
      ...(notice.userId === undefined ? {} : { user_id: notice.userId }),
      ...(notice.username === undefined ? {} : { username: notice.username }),
      ...(cursor === null ? {} : { cursor }),
    });
    for (const page of found.workspaces) {
      const queued = await queueWorkspaceBatch(deps, page, key);
      if (queued > 0) {
        hit.add(page.workspace_id);
        records += queued;
      }
    }
    cursor = found.next;
  } while (cursor !== null);
  return { workspaces: hit.size, records };
}

/** One page's matches in one workspace: its eBay records only, queued as one deletion job. */
function queueWorkspaceBatch(
  deps: EbayDeletionDeps,
  hit: Awaited<ReturnType<VaultClient['ebayUserMatch']>>['workspaces'][number],
  noticeKey: string,
): Promise<number> {
  return deps.tenancy.runWorkspace({ workspaceId: hit.workspace_id }, async (ctx) => {
    const ebayAccounts = new Set(
      (await deps.accounts.list(ctx)).filter((a) => a.provider === 'ebay').map((a) => a.id),
    );
    const mine = hit.matches
      .filter(
        (m) =>
          m.kind !== 'buyer_contact' ||
          (m.channel_account_id !== null && ebayAccounts.has(m.channel_account_id)),
      )
      .map((m) => m.pii_ref);
    if (mine.length > 0) {
      // The notice and the exact refs, hashed: a fixed 64 characters, whatever the notice id's
      // length (idempotency keys hold at most 200).
      const batch = createHash('sha256')
        .update(noticeKey)
        .update('\0')
        .update([...mine].sort().join(','))
        .digest('hex');
      // The request's own workspace transaction carries the job (A-002).
      await requestDeletion(deps.queue, ctx, {
        trigger: 'ebay_account_deletion',
        scope: { type: 'refs', pii_refs: mine },
        idempotencyKey: batch,
      });
    }
    return mine.length;
  });
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
 * requests, notices that make us fetch a key (counted before the fetch, A-003) and notices that
 * fail verification. eBay's own verified notices with a known key are never limited, however
 * many arrive together from its few addresses.
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
    // A-003 (ADR-069): checked before verifying, and a notice that makes us fetch a key is
    // counted before the fetch goes out, so a flood of forged notices cannot spend the eBay
    // budget. The key cache also remembers unknown kids and caps uncached fetches a minute.
    limit.check(request.ip);
    const header = request.headers['x-ebay-signature'];
    // Set when the address was counted before a key fetch, so a failure is not counted twice.
    const charge = { counted: false };
    const keys = (kid: string) =>
      options.keys(kid, () => {
        limit.count(request.ip);
        charge.counted = true;
      });
    let ok: boolean;
    try {
      ok = await verifyNotification(
        request.body,
        typeof header === 'string' ? header : undefined,
        keys,
      );
    } catch (err) {
      if (err instanceof EbayKeyFetchThrottled) {
        // Nothing was sent: 503, and eBay retries once the minute has passed.
        options.logger.warn(
          { event: 'ebay.public_key_throttled' },
          'eBay public key fetch limit reached this minute',
        );
        throw new ApiError({ status: 503, code: 'service_unavailable' });
      }
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
      if (!charge.counted) limit.count(request.ip);
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
      ebayAccountDeletion: async ({ body }) => {
        const queued =
          options.deletion === undefined
            ? undefined
            : await queueEbayDeletion(
                options.deletion,
                noticeUser(body.notification),
                options.logger,
              );
        // The receipt: no identifier of the eBay user or of the notice (EBAY-2, invariant 5).
        options.logger.info(
          {
            event: 'ebay.account_deletion.received',
            topic: body.metadata.topic,
            verified: true,
            // Records queued for deletion (the logger keeps counts, never ids of the user).
            ...(queued === undefined ? {} : { count: queued.records }),
          },
          'eBay account deletion notice received',
        );
        return { status: 200, body: null };
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
export function ebayWebhookFromEnv(
  logger: Logger,
  deletion?: EbayDeletionDeps,
): EbayWebhook | undefined {
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
    ...(deletion === undefined ? {} : { deletion }),
  });
}
