import { londonDate, type TenantContext } from '@omnibridge/core';
import type { CatalogueRepository, Connection, MappingChange } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { sendMappingChanged } from '@omnibridge/order-ingest';
import {
  AuthFailed,
  EgressRefused,
  ProviderParserError,
  runListingScan,
  type ChannelAdapter,
  type ScanResult,
  type SyncPorts,
} from '@omnibridge/provider-kit';
import {
  listingsDiscoverAccountsJob,
  listingsDiscoverJob,
  PermanentJobError,
  type JobHandler,
  type JobQueue,
  type PhasedHandler,
} from '@omnibridge/queue';

/**
 * CAT-6: what reacts to a listing's mapping changing. M09 back-fills stock movements and resets a
 * remapped listing's mode; M10 fills write-once snapshots. Each listener is idempotent: the job
 * may run again after a failure.
 */
export interface ListingMappedListener {
  readonly name: string;
  onMapped(ctx: TenantContext, change: MappingChange): Promise<void>;
}

/** CAT-5: what reacts to listings that a complete scan no longer found (M09: manual settings). */
export interface ListingsEndedListener {
  onEnded(ctx: TenantContext, listingIds: readonly string[]): Promise<void>;
}

type MappedPayload = {
  listing_id: string;
  master_sku_id: string | null;
  previous_master_sku_id: string | null;
};

/** catalogue.listing_mapped: runs every listener in the job's one transaction (CAT-6). */
export function listingMappedHandler(deps: {
  listeners: readonly ListingMappedListener[];
}): JobHandler<MappedPayload> {
  return async ({ ctx, payload }) => {
    const change: MappingChange = {
      listingId: payload.listing_id,
      masterSkuId: payload.master_sku_id,
      previousMasterSkuId: payload.previous_master_sku_id,
    };
    for (const listener of deps.listeners) await listener.onMapped(ctx, change);
    return { listeners: deps.listeners.map((l) => l.name) };
  };
}

/** The mapped event of one change (CAT-6): shared with the order ingest step. */
export { sendMappingChanged };

/**
 * A scan stops reading this long after it starts, well inside listings.discover's 30-minute job
 * expiry, so the retry of an expired job never runs beside it (F-M08-end-01).
 */
export const DISCOVERY_MAX_RUN_MS = 25 * 60_000;

/** Builds an adapter when a job needs it: app secrets are read then, not at boot. */
export type DiscoveryAdapters = Partial<
  Record<'ebay', () => Promise<Pick<ChannelAdapter, 'authenticate' | 'listListings'>>>
>;

/**
 * The channels with a listing read. A website has none (WEB-4): it sends its products itself
 * (WEB-3 `POST /products`), and that call reconciles them.
 */
const SCAN_APIS: Record<'ebay', { api: string; authApi?: string }> = {
  ebay: { api: 'sell.inventory', authApi: 'identity.user_token' },
};

/**
 * listings.discover (CAT-5): one complete listing scan of one account. The scan runs in `prepare`
 * in short transactions of its own (invariant 3): each page is upserted by (account, external
 * SKU), new listings are matched on the exact code, and each auto-mapping sends the CAT-6 event.
 * A complete scan marks listings it did not see as ended.
 */
export function listingsDiscoverHandler(deps: {
  ports: Omit<SyncPorts, 'cursors'>;
  adapters: DiscoveryAdapters;
  catalogue: Pick<CatalogueRepository, 'upsertDiscovered' | 'beginScan' | 'concludeScan'>;
  queue: Pick<JobQueue, 'send'>;
  ended?: ListingsEndedListener;
  /** CAT-6: after a complete scan, order lines that missed a mapping event get it again. */
  lateMapped?: (ctx: TenantContext, channelAccountId: string) => Promise<unknown>;
  /** How long one scan may read before it stops unconcluded; default 25 minutes. */
  maxRunMs?: number;
  /** INV-7 (M09): after a complete scan, compare each listing's channel quantity with its target. */
  reconcile?: (workspaceId: string, channelAccountId: string, scanStartedAt: Date) => Promise<void>;
  logger: Logger;
}): PhasedHandler<Record<string, never>, ScanResult> {
  const now = deps.ports.now ?? (() => new Date());
  return {
    prepare: async (job) => {
      const channelAccountId = job.envelope.channel_account_id;
      if (channelAccountId === undefined) throw new PermanentJobError('listings.no_account');
      const workspaceId = job.envelope.workspace_id;
      const account = await deps.ports.tenancy.runWorkspace({ workspaceId }, (ctx) =>
        deps.ports.accounts.get(ctx, channelAccountId, now()),
      );
      if (account === undefined) return { skipped: 'disconnected' };
      const provider = account.provider;
      if (provider !== 'ebay') return { skipped: 'disconnected' };
      const factory = deps.adapters[provider];
      if (factory === undefined) return { skipped: 'disconnected' };
      const adapter = await factory();
      // Set when this scan concluded: reconciliation then runs after it, in short transactions
      // of its own (one per SKU), never inside the scan's (F-M09-T0901-03).
      let concludedAt: Date | undefined;
      try {
        const result = await runListingScan(
          deps.ports,
          {
            provider,
            ...SCAN_APIS[provider],
            authenticate: (credential) => adapter.authenticate(credential),
            fetchPage: (token, page) => adapter.listListings(token, page),
            sinkPage: async (ctx, accountId, items, startedAt) => {
              const { autoMapped } = await deps.catalogue.upsertDiscovered(
                ctx,
                accountId,
                provider,
                items,
                startedAt,
              );
              for (const change of autoMapped) {
                await sendMappingChanged(deps.queue, ctx, change, 'auto');
              }
            },
            begin: (ctx, accountId, startedAt) =>
              deps.catalogue.beginScan(ctx, accountId, startedAt),
            complete: async (ctx, accountId, startedAt) => {
              // Only the newest scan of the account concludes (F-M08-end-01): an older one that a
              // retry overlapped ends nothing and reconciles nothing.
              const ended = await deps.catalogue.concludeScan(ctx, accountId, startedAt, now());
              if (ended === undefined) return false;
              if (ended.length > 0) await deps.ended?.onEnded(ctx, ended);
              await deps.lateMapped?.(ctx, accountId);
              concludedAt = startedAt;
              return true;
            },
          },
          {
            workspaceId,
            channelAccountId,
            deadline: new Date(now().getTime() + (deps.maxRunMs ?? DISCOVERY_MAX_RUN_MS)),
          },
        );
        if (concludedAt !== undefined) {
          // The scan itself concluded: a reconcile failure is logged, never a reason to read
          // every page from the provider again. The next nightly run reconciles.
          try {
            await deps.reconcile?.(workspaceId, channelAccountId, concludedAt);
          } catch (err) {
            deps.logger.error(
              { event: 'stock.reconcile_failed', workspaceId, channelAccountId, err },
              'reconciliation failed after a complete listing scan',
            );
          }
        }
        return result;
      } catch (err) {
        if (err instanceof ProviderParserError) {
          deps.logger.error(
            {
              event: 'provider.parser_failed',
              workspaceId,
              channelAccountId,
              provider: err.provider,
              parser: err.parser,
              parserVersion: err.version,
              fieldPath: err.path,
            },
            'provider answer failed its parser',
          );
          throw new PermanentJobError('provider.parser_failed');
        }
        if (err instanceof EgressRefused) throw new PermanentJobError('provider.egress_refused');
        if (err instanceof AuthFailed) throw new PermanentJobError('provider.auth_failed');
        throw err;
      }
    },
    commit: (_job, result) => Promise.resolve(result),
  };
}

/** The sales channels discovery reads (Amazon joins with its seller id in M18). */
const DISCOVERED: readonly Connection['provider'][] = ['ebay'];

/**
 * listings.discover_accounts: one listings.discover job per connected eBay account of
 * the workspace, once per London day (CAT-5 "daily").
 */
export function listingsDiscoverAccountsHandler(deps: {
  connections: { list(ctx: TenantContext, now: Date): Promise<readonly Connection[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: () => Date;
}): JobHandler<Record<string, never>> {
  const now = deps.now ?? (() => new Date());
  return async ({ ctx }) => {
    const day = londonDate(now());
    let sent = 0;
    for (const account of await deps.connections.list(ctx, now())) {
      if (!DISCOVERED.includes(account.provider) || account.status === 'disconnected') continue;
      await deps.queue.send(listingsDiscoverJob, {
        ctx,
        channelAccountId: account.id,
        idempotencyKey: `listings.discover:${account.id}:${day}`,
        payload: {},
      });
      sent += 1;
    }
    return { sent };
  };
}

/** Daily: one listings.discover_accounts job per workspace. */
export async function sweepListingsDiscover({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const day = londonDate(now);
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(listingsDiscoverAccountsJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `listings.discover_accounts:${day}`,
      payload: {},
    });
  }
  return ids.length;
}
