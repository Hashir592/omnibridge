import { pence, type Notifier, type TenantContext, type TenantRunner } from '@omnibridge/core';
import {
  effectiveDispatch,
  type IncomingOrder,
  type MappingChange,
  type OrderIngest,
  type OrderIngestPorts,
  type StoredOrderPii,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import type { BuyerDetails, ChannelOrder, SyncStream } from '@omnibridge/provider-kit';
import {
  listingMappedJob,
  ordersGroupRecomputeJob,
  ordersPiiExpiryJob,
  requestDeletion,
  type JobQueue,
} from '@omnibridge/queue';
import { VaultError, type VaultClient } from '@omnibridge/vault-client';
import { hasDeliveryAddress } from '@omnibridge/vault-client/schemas';

/*
 * The order ingest step (M10, T-1001: ORD-4, DEL-1, FA-10, FA-16), shared by the worker's order
 * polls and the web app's website push (T-1101, ADR-054 FA-04). Vault first: buyer details go to
 * pii-vault with no transaction open, then the order goes to db-main in the caller's transaction,
 * keyed by channel account and external order ID on both sides. If the db-main write fails, the
 * vault record is an orphan the nightly sweep expires; it already carries the 90-day backstop
 * (PRD 7.3), so it can never outlive that. It calls no provider: it holds no HTTP client.
 */

/** The mapped event of one change, sent in the caller's transaction (CAT-6). */
export function sendMappingChanged(
  queue: Pick<JobQueue, 'send'>,
  ctx: TenantContext,
  change: MappingChange,
  key: string,
) {
  return queue.send(listingMappedJob, {
    ctx,
    idempotencyKey: `listing_mapped:${change.listingId}:${key}`,
    payload: {
      listing_id: change.listingId,
      master_sku_id: change.masterSkuId,
      previous_master_sku_id: change.previousMasterSkuId,
    },
  });
}

const DAY_MS = 86_400_000;
/** PRD 7.3: PII of an order never dispatched or cancelled goes at most 90 days after placement. */
export const PII_HARD_LIMIT_MS = 90 * DAY_MS;
/** ORD-9: group recomputes asked for in one minute are one job. */
const REGROUP_SLOT_MS = 60_000;
/** Longer than a transaction that stores orders takes (one chunk of a poll). */
const REGROUP_SETTLE_MS = 30_000;

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
            dispatchedAt: knownDispatch(order, stored),
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

/**
 * When the order left, for a record not stored yet. The stored date stands: a later update never
 * restarts a window that has passed. A real date earlier than a stored stand-in counts instead.
 */
function knownDispatch(
  order: Pick<ChannelOrder, 'dispatchedAt'>,
  stored: StoredOrderPii | undefined,
): Date | null {
  if (stored === undefined || stored.dispatchedAt === null) return order.dispatchedAt;
  const real = stored.dispatchEstimated ? order.dispatchedAt : null;
  return real !== null && real < stored.dispatchedAt ? real : stored.dispatchedAt;
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
    cancelRequested: o.cancelRequested,
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
  now: () => Date = () => new Date(),
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
        // The first real dispatch date is a job of its own: the stand-in's key is taken.
        idempotencyKey: `orders.pii_expiry:${input.orderId}:${input.reason}${input.real === true ? ':real' : ''}`,
        payload: { order_id: input.orderId, reason: input.reason },
      });
    },
    regroup: async (ctx, input) => {
      // One per account and minute, run after that minute has ended and every transaction that
      // shares its key has committed, so no change under the key is missed.
      const slot = Math.floor(now().getTime() / REGROUP_SLOT_MS);
      await queue.send(ordersGroupRecomputeJob, {
        ctx,
        channelAccountId: input.channelAccountId,
        idempotencyKey: `orders.group_recompute:${input.channelAccountId}:${String(slot)}`,
        startAfter: new Date((slot + 1) * REGROUP_SLOT_MS + REGROUP_SETTLE_MS),
        payload: {},
      });
    },
  };
}
