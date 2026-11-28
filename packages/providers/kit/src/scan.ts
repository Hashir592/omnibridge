import type { Provider, TenantContext } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import type { AccessToken, ListingInfo, Page } from './adapters.ts';
import { callSession } from './session.ts';
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
  /** In the scan's first transaction: records that a scan of the account started. */
  begin?(ctx: TenantContext, channelAccountId: string, startedAt: Date): Promise<void>;
  /**
   * After the last page of a complete scan, in the same transaction as the health record.
   * Answers whether it concluded (false when a newer scan of the account started meanwhile).
   */
  complete(ctx: TenantContext, channelAccountId: string, startedAt: Date): Promise<boolean>;
}

export type ScanResult =
  | { skipped: 'disconnected' }
  | { pages: number; listings: number; complete: boolean; concluded: boolean };

/**
 * Reads every page of an account's listings (CAT-5) through the governor, with short transactions
 * only (invariant 3): each page is stored as it arrives, and a scan that reached the last page
 * concludes (listings it did not see have ended). Failures are recorded as account health and
 * notices like the sync's, then rethrown for the job.
 */
export async function runListingScan(
  ports: Omit<SyncPorts, 'cursors'>,
  scan: ListingScan,
  job: {
    workspaceId: string;
    channelAccountId: string;
    /**
     * Stop reading pages at this time, without concluding, so a scan never outlives its job and
     * overlaps the retry (F-M08-end-01). The next scan reads everything again.
     */
    deadline?: Date;
  },
): Promise<ScanResult> {
  const now = ports.now ?? (() => new Date());
  const actor = { workspaceId: job.workspaceId };
  const accountId = job.channelAccountId;
  const startedAt = now();
  const start = await ports.tenancy.runWorkspace(actor, async (ctx) => {
    const account = await ports.accounts.get(ctx, accountId, now());
    if (account === undefined || account.status === 'disconnected') return undefined;
    const credential = await ports.credentials.read(ctx, accountId, scan.provider);
    if (credential === undefined) return undefined;
    await scan.begin?.(ctx, accountId, startedAt);
    return { account, credential };
  });
  if (start === undefined) return { skipped: 'disconnected' };
  const { account, credential } = start;

  const session = callSession(ports, {
    workspaceId: job.workspaceId,
    channelAccountId: accountId,
    companyId: account.companyId,
    provider: scan.provider,
    ...(scan.authApi === undefined ? {} : { authApi: scan.authApi }),
    credential,
    authenticate: (c) => scan.authenticate(c),
  });

  try {
    let page: string | undefined;
    let pages = 0;
    let listings = 0;
    do {
      const result: Page<ListingInfo> = await session.call(scan.api, (access) =>
        scan.fetchPage(access, page),
      );
      pages += 1;
      listings += result.items.length;
      await ports.tenancy.runWorkspace(actor, async (ctx) => {
        await scan.sinkPage(ctx, accountId, result.items, startedAt);
        await session.recordCalls(ctx, { clear: true });
      });
      page = result.next;
    } while (
      page !== undefined &&
      pages < MAX_SCAN_PAGES &&
      (job.deadline === undefined || now().getTime() < job.deadline.getTime())
    );
    const complete = page === undefined;
    let concluded = false;
    await ports.tenancy.runWorkspace(actor, async (ctx) => {
      // An empty answer is more likely a provider hiccup than every listing ending at once:
      // only a scan that found something concludes (the listings it did not see have ended).
      if (complete && listings > 0) concluded = await scan.complete(ctx, accountId, startedAt);
      await session.succeeded(ctx);
    });
    return { pages, listings, complete, concluded };
  } catch (err) {
    await ports.tenancy.runWorkspace(actor, (ctx) => session.failed(ctx, err));
    await session.reportParser(err);
    throw err;
  }
}
