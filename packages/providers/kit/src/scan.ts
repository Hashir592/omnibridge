import type { Provider, TenantContext } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import type { AccessToken, ListingInfo, Page } from './adapters.ts';
import {
  AuthFailed,
  isProviderError,
  ProviderParserError,
  providerErrorCode,
  RateLimited,
} from './errors.ts';
import { parserRecordKind } from './parser.ts';
import type { SyncPorts } from './sync.ts';

/** A scan that reads more pages than this stops without concluding (nothing is marked ended). */
const MAX_SCAN_PAGES = 500;

/** One complete listing read of one account (CAT-5): every page, no cursor. */
export interface ListingScan {
  readonly provider: Provider;
  /** The API name usage is counted under (RL-5). */
  readonly api: string;
  /** The API name of the token call; `auth` when left out. */
  readonly authApi?: string;
  authenticate(credential: Secret): Promise<AccessToken>;
  fetchPage(token: AccessToken, page?: string): Promise<Page<ListingInfo>>;
  /** Stores one page in its own short transaction (upsert by account and external SKU). */
  sinkPage(
    ctx: TenantContext,
    channelAccountId: string,
    items: readonly ListingInfo[],
    startedAt: Date,
  ): Promise<void>;
  /** After the last page of a complete scan, in the same transaction as the health record. */
  complete(ctx: TenantContext, channelAccountId: string, startedAt: Date): Promise<void>;
}

export type ScanResult =
  { skipped: 'disconnected' } | { pages: number; listings: number; complete: boolean };

/**
 * Reads every page of an account's listings (CAT-5) through the governor, with short transactions
 * only (invariant 3): each page is stored as it arrives, and a scan that reached the last page
 * concludes (listings it did not see have ended). Failures are recorded as account health and
 * notices like the sync's, then rethrown for the job.
 */
export async function runListingScan(
  ports: Omit<SyncPorts, 'cursors'>,
  scan: ListingScan,
  job: { workspaceId: string; channelAccountId: string },
): Promise<ScanResult> {
  const now = ports.now ?? (() => new Date());
  const actor = { workspaceId: job.workspaceId };
  const accountId = job.channelAccountId;
  const start = await ports.tenancy.runWorkspace(actor, async (ctx) => {
    const account = await ports.accounts.get(ctx, accountId, now());
    if (account === undefined || account.status === 'disconnected') return undefined;
    const credential = await ports.credentials.read(ctx, accountId, scan.provider);
    return credential === undefined ? undefined : { account, credential };
  });
  if (start === undefined) return { skipped: 'disconnected' };
  const { account, credential } = start;
  const startedAt = now();

  const calls = new Map<string, number>();
  const input = (api: string) => ({
    workspaceId: job.workspaceId,
    channelAccountId: accountId,
    provider: scan.provider,
    api,
    urgent: false,
  });
  let held: RateLimited | undefined;
  const governed = async (api: string) => {
    const decision = (await ports.governor?.admit(input(api))) ?? {
      ok: true,
      usageRecorded: false,
    };
    if (!decision.ok) {
      held = new RateLimited(scan.provider, {
        retryAfterMs: Math.max(0, decision.retryAt.getTime() - now().getTime()),
        daily: scan.provider === 'ebay',
      });
      throw held;
    }
    if (!decision.usageRecorded) calls.set(api, (calls.get(api) ?? 0) + 1);
  };
  const fetchPage = (access: AccessToken, page: string | undefined) =>
    ports.governor === undefined
      ? scan.fetchPage(access, page)
      : ports.governor.run(input(scan.api), () => scan.fetchPage(access, page));
  const auth = { refreshed: false, issued: false };
  const token = async () => {
    const got = await ports.tokens.get(accountId, async () => {
      auth.issued = true;
      await governed(scan.authApi ?? 'auth');
      return scan.authenticate(credential);
    });
    auth.refreshed ||= got.refreshed;
    return got.token;
  };
  const recordCalls = async (ctx: TenantContext) => {
    for (const [api, n] of calls) {
      await ports.health.recordCalls(
        ctx,
        { channelAccountId: accountId, provider: scan.provider, api, calls: n },
        now(),
      );
    }
    calls.clear();
  };

  try {
    let page: string | undefined;
    let pages = 0;
    let listings = 0;
    do {
      let result: Page<ListingInfo>;
      try {
        const access = await token();
        await governed(scan.api);
        result = await fetchPage(access, page);
      } catch (err) {
        // One 401 with a cached token may just be an early expiry: renew once and retry.
        if (!(err instanceof AuthFailed) || err.revoked || auth.issued) throw err;
        ports.tokens.invalidate(accountId);
        const access = await token();
        await governed(scan.api);
        result = await fetchPage(access, page);
      }
      pages += 1;
      listings += result.items.length;
      await ports.tenancy.runWorkspace(actor, async (ctx) => {
        await scan.sinkPage(ctx, accountId, result.items, startedAt);
        await recordCalls(ctx);
      });
      page = result.next;
    } while (page !== undefined && pages < MAX_SCAN_PAGES);
    const complete = page === undefined;
    await ports.tenancy.runWorkspace(actor, async (ctx) => {
      if (complete) await scan.complete(ctx, accountId, startedAt);
      const { reauthCleared } = await ports.health.recordSuccess(ctx, accountId, now(), {
        tokenRefreshed: auth.refreshed,
      });
      if (reauthCleared) {
        await ports.notifier.resolve(ctx, 'channel.auth_lost', {
          kind: 'channel_account',
          id: accountId,
        });
      }
      await recordCalls(ctx);
    });
    return { pages, listings, complete };
  } catch (err) {
    await ports.tenancy.runWorkspace(actor, async (ctx) => {
      if (err instanceof AuthFailed) {
        ports.tokens.invalidate(accountId);
        const { marked } = await ports.health.recordAuthFailure(ctx, accountId, now(), {
          revoked: err.revoked,
        });
        if (marked) {
          await ports.notifier.raise(ctx, {
            type: 'channel.auth_lost',
            record: { kind: 'channel_account', id: accountId },
            signal: err.revoked ? 'native' : 'derived',
            companyId: account.companyId,
            channelAccountId: accountId,
          });
        }
      } else if (isProviderError(err) && err !== held) {
        await ports.health.recordError(ctx, accountId, providerErrorCode(err), now());
      }
      await recordCalls(ctx);
    });
    if (err instanceof ProviderParserError) {
      await ports.notifier.raisePlatform(null, {
        type: 'platform.report_failure',
        record: {
          kind: parserRecordKind({ provider: err.provider, name: err.parser }),
          id: String(err.version),
        },
      });
    }
    throw err;
  }
}
