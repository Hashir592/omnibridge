import {
  londonDate,
  pence,
  type Notifier,
  type TenantContext,
  type TenantRunner,
} from '@omnibridge/core';
import { randomUUID } from 'node:crypto';
import {
  effectiveDispatch,
  type Connection,
  type IncomingOrder,
  type OrderIngest,
  type OrderIngestPorts,
  type OrderReads,
  type StoredOrderPii,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import type { BuyerDetails, ChannelOrder, SyncStream } from '@omnibridge/provider-kit';
import {
  ordersGroupRecomputeJob,
  ordersOrphanSweepJob,
  ordersPiiExpiryJob,
  ordersSyncAccountsJob,
  requestDeletion,
  syncPollJob,
  type JobHandler,
  type JobQueue,
  type PhasedHandler,
  type SyncStreamName,
} from '@omnibridge/queue';
import { VaultError, type VaultClient } from '@omnibridge/vault-client';
import { hasDeliveryAddress } from '@omnibridge/vault-client/schemas';
import { sendMappingChanged } from './catalogue.ts';

/*
 * M10 order ingest in the worker (T-1001: ORD-4, DEL-1, FA-10, FA-16). Vault first: buyer details
 * go to pii-vault with no transaction open, then the order goes to db-main in the sync job's
 * transaction, keyed by channel account and external order ID on both sides. If the db-main write
 * fails, the vault record is an orphan the nightly sweep expires; it already carries the 90-day
 * backstop (PRD 7.3), so it can never outlive that.
 */

const DAY_MS = 86_400_000;
/** PRD 7.3: PII of an order never dispatched or cancelled goes at most 90 days after placement. */
export const PII_HARD_LIMIT_MS = 90 * DAY_MS;
/**
 * FA-10: a vault record younger than this may belong to an ingest still writing db-main, or to a
 * sync job still retrying (its retries end well inside a day). Older ones with no order go.
 */
const ORPHAN_GRACE_MS = DAY_MS;

/**
 * DEL-1, PRD 7.3: when an order's buyer record must be gone, used at ingest and by the expiry job.
 * Delivery (or dispatch when delivery is unknown) plus the workspace's PII window, and never past
 * placement + 90 days, whatever the dates say; an order not yet dispatched keeps that limit. A
 * date in the future counts as now.
 */
export function piiExpiryDate(input: {
  placedAt: Date;
  shippedAt: Date | null;
  retentionDays: number;
  now: Date;
}): Date {
  const limit = input.placedAt.getTime() + PII_HARD_LIMIT_MS;
  if (input.shippedAt === null) return new Date(limit);
  const shipped = Math.min(input.shippedAt.getTime(), input.now.getTime());
  return new Date(Math.min(shipped + input.retentionDays * DAY_MS, limit));
}

/** The expiry of an order as the channel reports it now (see effectiveDispatch for its dates). */
export function piiDeleteAfter(
  order: Pick<
    ChannelOrder,
    'placedAt' | 'shipBy' | 'state' | 'dispatchedAt' | 'deliveredAt' | 'updatedAt'
  >,
  retentionDays: number,
  now: Date,
  storedUnshipped = false,
): Date {
  return piiExpiryDate({
    placedAt: order.placedAt,
    shippedAt: order.deliveredAt ?? effectiveDispatch(order, storedUnshipped),
    retentionDays,
    now,
  });
}

export interface OrderStreamDeps {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  ingest: Pick<OrderIngest, 'piiState' | 'apply'>;
  /** The worker's token: `ingest` (and `subjects` for the sweep). */
  vault: Pick<VaultClient, 'ingest' | 'replace'>;
  logger: Logger;
  now?: () => Date;
}

/**
 * The prepare and sink of an order stream (eBay and website). `prepare` runs between the page
 * reads and the sink's transaction, with no transaction open (invariant 3): one vault ingest per
 * new order that has buyer details, idempotent per order (ADR-079 3). The items it returns carry
 * the pii_ref or the reason there is none, and never the details themselves.
 */
export function orderIngestStream(
  deps: OrderStreamDeps,
): Pick<SyncStream<ChannelOrder>, 'prepare' | 'sink'> {
  const now = deps.now ?? (() => new Date());
  return {
    prepare: async (job, items) => {
      if (items.length === 0) return items;
      const actor = { workspaceId: job.workspaceId };
      const { orders, provider, retentionDays } = await deps.tenancy.runWorkspace(actor, (ctx) =>
        deps.ingest.piiState(
          ctx,
          job.channelAccountId,
          items.map((o) => o.externalId),
        ),
      );
      const out: ChannelOrder[] = [];
      for (const order of items) {
        out.push({ ...order, buyer: null, pii: await vaultFirst(order) });
      }
      return out;

      async function vaultFirst(order: ChannelOrder): Promise<NonNullable<ChannelOrder['pii']>> {
        // Settled already (a record, a deletion, a refusal or a cancellation): a deleted record is
        // never brought back by a later poll.
        const stored = orders.get(order.externalId);
        if (stored?.settled === true) return corrected(order, stored);
        if (order.buyer === null || order.state === 'cancelled') return { kind: 'none' };
        // DP-5: nothing is kept of a buyer who has not paid, and nothing is settled until there
        // is somewhere to send the parcel. A later poll asks again.
        if (order.state === 'pending_payment' || !hasDeliveryAddress(order.buyer)) {
          return { kind: 'none' };
        }
        const deleteAfter = piiDeleteAfter(
          {
            ...order,
            dispatchedAt: stored?.dispatchedAt ?? order.dispatchedAt,
            deliveredAt: stored?.deliveredAt ?? order.deliveredAt,
          },
          retentionDays,
          now(),
          stored !== undefined && stored.dispatchedAt === null,
        );
        // FA-16: an order already past its PII window (a backfill at cutover) is stored with no
        // vault record at all.
        if (deleteAfter.getTime() <= now().getTime()) return { kind: 'none' };
        const cap = now().getTime() + PII_HARD_LIMIT_MS;
        try {
          const { pii_ref } = await deps.vault.ingest({
            workspace_id: job.workspaceId,
            kind: 'buyer_contact',
            channel_account_id: job.channelAccountId,
            subject_type: 'order',
            subject_id: `${job.channelAccountId}:${order.externalId}`,
            delete_after: new Date(Math.min(deleteAfter.getTime(), cap)).toISOString(),
            placed_at: order.placedAt.toISOString(),
            source_updated_at: order.updatedAt.toISOString(),
            ...(provider === undefined ? {} : { channel: provider }),
            fields: givenFields(order.buyer),
          });
          return { kind: 'stored', piiRef: pii_ref };
        } catch (err) {
          // ADR-068: the buyer was deleted by an eBay notice; the order is kept without them.
          if (err instanceof VaultError && err.code === 'buyer_deleted') {
            deps.logger.info(
              {
                event: 'orders.buyer_refused',
                workspaceId: job.workspaceId,
                channelAccountId: job.channelAccountId,
              },
              'buyer deleted by an eBay notice: order stored without customer details',
            );
            return { kind: 'refused' };
          }
          throw err;
        }
      }

      /**
       * ORD-4: an address the channel corrects before dispatch reaches the one record, in place.
       * Only for an order that is paid and waiting on both sides; the vault refuses an older
       * update, a masked or partial block, and a record that is gone.
       */
      async function corrected(
        order: ChannelOrder,
        stored: StoredOrderPii,
      ): Promise<NonNullable<ChannelOrder['pii']>> {
        const waiting =
          order.state === 'awaiting_dispatch' &&
          (stored.status === 'awaiting_dispatch' || stored.status === 'label_created') &&
          stored.dispatchedAt === null &&
          (order.paidAt ?? stored.paidAt) !== null;
        if (!waiting || stored.piiRef === null || !stored.live) return { kind: 'unchanged' };
        if (order.buyer === null || !hasDeliveryAddress(order.buyer)) return { kind: 'unchanged' };
        try {
          const { changed } = await deps.vault.replace({
            workspace_id: job.workspaceId,
            pii_ref: stored.piiRef,
            subject_id: `${job.channelAccountId}:${order.externalId}`,
            placed_at: order.placedAt.toISOString(),
            source_updated_at: order.updatedAt.toISOString(),
            ...(provider === undefined ? {} : { channel: provider }),
            fields: givenFields(order.buyer),
          });
          return { kind: changed ? 'replaced' : 'unchanged' };
        } catch (err) {
          // ADR-068: the buyer's account was deleted: its record is on its way out, not corrected.
          if (err instanceof VaultError && err.code === 'buyer_deleted') {
            return { kind: 'unchanged' };
          }
          throw err;
        }
      }
    },
    sink: (ctx, channelAccountId, items) =>
      deps.ingest.apply(ctx, channelAccountId, items.map(toIncoming)),
  };
}

/** The buyer block with its blank values left out. */
function givenFields(buyer: BuyerDetails): Record<string, string> {
  return Object.fromEntries(
    Object.entries(buyer).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '',
    ),
  );
}

/** A parsed channel order, without its buyer, as db-main's ingest takes it (pence as bigint). */
export function toIncoming(o: ChannelOrder): IncomingOrder {
  return {
    externalId: o.externalId,
    rawStatus: o.status.slice(0, 100) || 'unknown',
    state: o.state,
    updatedAt: o.updatedAt,
    placedAt: o.placedAt,
    paidAt: o.paidAt,
    shipBy: o.shipBy,
    dispatchedAt: o.dispatchedAt,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
    discount: pence(BigInt(o.discountPence)),
    shipping: pence(BigInt(o.shippingPence)),
    channelTotal: o.totalPence === null ? null : pence(BigInt(o.totalPence)),
    shipToCountry: o.shipToCountry,
    fba: o.fba,
    lines: o.lines.map((l) => ({
      lineId: l.lineId,
      sku: l.sku,
      quantity: l.quantity,
      title: l.title,
      linePrice: pence(BigInt(l.linePricePence)),
    })),
    refunds: o.refunds.map((r) => ({
      refundId: r.refundId,
      refundedAt: r.refundedAt,
      amount: pence(BigInt(r.amountPence)),
      lines:
        r.lines === null
          ? null
          : r.lines.map((l) => ({
              lineId: l.lineId,
              quantity: l.quantity,
              amount: pence(BigInt(l.amountPence)),
            })),
    })),
    // A sink without the prepare step (a test) stores the order with no customer details.
    pii: o.pii ?? { kind: 'none' },
  };
}

/** The jobs and notices of the ingest, inside its transaction (IDs only, invariant 7a). */
export function orderIngestPorts(
  queue: Pick<JobQueue, 'send'>,
  notices: { notifier: Pick<Notifier, 'raisePlatform'>; logger: Logger },
): OrderIngestPorts {
  return {
    totalMismatch: async (ctx, input) => {
      notices.logger.warn(
        {
          event: 'orders.total_mismatch',
          workspaceId: ctx.workspaceId,
          channelAccountId: input.channelAccountId,
          orderId: input.orderId,
        },
        'order pence do not add up to the total the channel states',
      );
      // One open notice per account: the rule for reading its amounts needs a look (T-1501).
      await notices.notifier.raisePlatform(ctx, {
        type: 'platform.report_failure',
        record: { kind: 'order_total', id: input.channelAccountId },
      });
    },
    lateMapped: async (ctx, input) => {
      const change = {
        listingId: input.listingId,
        masterSkuId: input.masterSkuId,
        previousMasterSkuId: null,
      };
      await sendMappingChanged(queue, ctx, change, `late:${input.key}`);
    },
    cancelPii: async (ctx, input) => {
      await requestDeletion(queue, ctx, {
        trigger: 'cancellation',
        scope: { type: 'subjects', subject_type: 'order', subject_ids: [input.piiSubject] },
        idempotencyKey: `cancel:${input.orderId}`,
      });
    },
    shortenPii: async (ctx, input) => {
      await queue.send(ordersPiiExpiryJob, {
        ctx,
        idempotencyKey: `orders.pii_expiry:${input.orderId}:${input.reason}`,
        payload: { order_id: input.orderId, reason: input.reason },
      });
    },
    regroup: async (ctx, input) => {
      // One per sync page that stored orders; the job runs one account at a time.
      await queue.send(ordersGroupRecomputeJob, {
        ctx,
        channelAccountId: input.channelAccountId,
        idempotencyKey: `orders.group_recompute:${input.channelAccountId}:${randomUUID()}`,
        payload: {},
      });
    },
  };
}

/**
 * orders.group_recompute (ORD-9, C3.2). With no transaction open, the vault's `match` capability
 * says which of the account's awaiting orders share a buyer and delivery address (order subjects
 * only, never PII); then, in the job's transaction, db-main links them under an advisory lock.
 */
export function ordersGroupRecomputeHandler(deps: {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  reads: Pick<OrderReads, 'groupCandidates' | 'applyGroups'>;
  vault: Pick<VaultClient, 'match'>;
}): PhasedHandler<Record<string, never>, [string, string][]> {
  return {
    prepare: async (job) => {
      const workspaceId = job.envelope.workspace_id;
      const accountId = job.envelope.channel_account_id;
      if (accountId === undefined) return [];
      const candidates = await deps.tenancy.runWorkspace({ workspaceId }, (ctx) =>
        deps.reads.groupCandidates(ctx, accountId),
      );
      // Match keys are exact, so "shares a key with" is a class: one vault call per buyer.
      const classes = new Map<string, string>();
      for (const c of candidates) {
        if (classes.has(c.piiSubject)) continue;
        classes.set(c.piiSubject, c.piiSubject);
        const { subject_ids } = await deps.vault.match(workspaceId, c.piiRef);
        for (const s of subject_ids) if (!classes.has(s)) classes.set(s, c.piiSubject);
      }
      return [...classes.entries()];
    },
    commit: async (job, classes) => {
      const accountId = job.envelope.channel_account_id;
      if (accountId === undefined) return { groups: 0 };
      return deps.reads.applyGroups(job.ctx, accountId, new Map(classes));
    },
  };
}

/**
 * orders.pii_expiry (DEL-1, ADR-068): the buyer record of a dispatched or delivered order goes at
 * that date plus the PII window. The vault call runs with no transaction open; the vault journals
 * the change off-site. A date already past moves to now, so the next hourly run deletes it.
 */
export function ordersPiiExpiryHandler(deps: {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  ingest: Pick<OrderIngest, 'piiExpiryOf' | 'retentionDays'>;
  vault: Pick<VaultClient, 'setExpiry'>;
  now?: () => Date;
}): PhasedHandler<{ order_id: string; reason: 'dispatch' | 'delivery' }, { updated: number }> {
  const now = deps.now ?? (() => new Date());
  return {
    prepare: async (job) => {
      const actor = { workspaceId: job.envelope.workspace_id };
      const [target, days] = await deps.tenancy.runWorkspace(actor, async (ctx) => {
        const rows = await deps.ingest.piiExpiryOf(ctx, [job.payload.order_id]);
        return [rows[0], await deps.ingest.retentionDays(ctx)] as const;
      });
      if (target === undefined) return { updated: 0 };
      // The job is queued only once dispatch or delivery is known, so `shipped` is set.
      const due = piiExpiryDate({
        placedAt: target.placedAt,
        shippedAt: target.deliveredAt ?? target.dispatchedAt ?? now(),
        retentionDays: days,
        now: now(),
      });
      const at = Math.min(
        Math.max(due.getTime(), now().getTime()),
        now().getTime() + PII_HARD_LIMIT_MS,
      );
      return deps.vault.setExpiry({
        workspace_id: job.envelope.workspace_id,
        pii_refs: [target.piiRef],
        delete_after: new Date(at).toISOString(),
        reason: job.payload.reason,
      });
    },
    commit: (_job, result) => Promise.resolve(result),
  };
}

/**
 * orders.orphan_sweep (FA-10): vault order records older than a day that no order points at
 * are expired now, so the next hourly run deletes them through the one deletion service.
 * IDs only; one short read per page, no transaction across a vault call.
 */
export function ordersOrphanSweepHandler(deps: {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  ingest: Pick<OrderIngest, 'knownPiiRefs'>;
  vault: Pick<VaultClient, 'subjects' | 'setExpiry'>;
  logger: Logger;
  now?: () => Date;
  /** How old a vault record must be before it can be an orphan (default a day). */
  graceMs?: number;
}): PhasedHandler<Record<string, never>, { orphans: number }> {
  const now = deps.now ?? (() => new Date());
  const grace = deps.graceMs ?? ORPHAN_GRACE_MS;
  return {
    prepare: async (job) => {
      const workspaceId = job.envelope.workspace_id;
      const before = new Date(now().getTime() - grace).toISOString();
      let after: string | undefined;
      let orphans = 0;
      for (let page = 0; page < 1000; page += 1) {
        const res = await deps.vault.subjects({
          workspace_id: workspaceId,
          subject_type: 'order',
          created_before: before,
          limit: 500,
          ...(after === undefined ? {} : { after }),
        });
        const refs = res.records.map((r) => r.pii_ref);
        const known = await deps.tenancy.runWorkspace({ workspaceId }, (ctx) =>
          deps.ingest.knownPiiRefs(ctx, refs),
        );
        const lost = refs.filter((r) => !known.has(r));
        if (lost.length > 0) {
          await deps.vault.setExpiry({
            workspace_id: workspaceId,
            pii_refs: lost,
            delete_after: now().toISOString(),
            reason: 'orphan',
          });
          orphans += lost.length;
        }
        if (res.next === null) break;
        after = res.next;
      }
      if (orphans > 0) {
        deps.logger.warn(
          { event: 'orders.orphans_expired', workspaceId, count: orphans },
          'vault order records with no order expired',
        );
      }
      return { orphans };
    },
    commit: (_job, result) => Promise.resolve(result),
  };
}

/** The order stream of each sales channel (Amazon's arrives with its seller ID in M18). */
const ORDER_STREAMS: Partial<Record<Connection['provider'], SyncStreamName>> = {
  ebay: 'ebay.orders',
  website: 'website.orders',
};

/** The 5-minute slot of a time, for the poll keys (CAP-6: new orders within 5 minutes). */
export function pollSlot(at: Date): string {
  const slot = Math.floor(at.getTime() / (5 * 60_000)) * 5 * 60_000;
  return new Date(slot).toISOString().slice(0, 16);
}

/** orders.sync_accounts: one sync.poll per connected eBay and website account, per slot. */
export function ordersSyncAccountsHandler(deps: {
  connections: { list(ctx: TenantContext, now: Date): Promise<readonly Connection[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: () => Date;
}): JobHandler<Record<string, never>> {
  const now = deps.now ?? (() => new Date());
  return async ({ ctx }) => {
    const slot = pollSlot(now());
    let sent = 0;
    for (const account of await deps.connections.list(ctx, now())) {
      const stream = ORDER_STREAMS[account.provider];
      if (stream === undefined || account.status === 'disconnected') continue;
      await deps.queue.send(syncPollJob, {
        ctx,
        channelAccountId: account.id,
        idempotencyKey: `sync.poll:${stream}:${account.id}:${slot}`,
        payload: { stream },
      });
      sent += 1;
    }
    return { sent };
  };
}

/** Every 5 minutes: one orders.sync_accounts job per workspace. */
export async function sweepOrdersSync({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(ordersSyncAccountsJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `orders.sync_accounts:${pollSlot(now)}`,
      payload: {},
    });
  }
  return ids.length;
}

/** Nightly: one orders.orphan_sweep job per workspace (FA-10). */
export async function sweepOrderOrphans({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(ordersOrphanSweepJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `orders.orphan_sweep:${londonDate(now)}`,
      payload: {},
    });
  }
  return ids.length;
}
