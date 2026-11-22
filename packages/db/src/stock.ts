import { randomUUID } from 'node:crypto';
import {
  listingTarget,
  remainingAllocation,
  type Notifier,
  type StockMode,
  type TenantContext,
} from '@omnibridge/core';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { ChannelProvider, MainDb } from './schema.ts';
import { withBoundTenant, withTenantTransaction } from './tenant.ts';

/*
 * The stock engine (T-0901: INV-1 to INV-10, AT-4, AT-27; ADR-078 5). One rule for every change:
 * lock the component's stock row, insert the movement under its unique key, and only when the
 * insert happened move on hand and reserved, then recompute every affected listing's target and
 * queue a write where the target changed. So a repeated event moves stock once (FA-10), two
 * movements of one SKU never interleave, and pushes go through the M07 outbound path only.
 */

/** The channels M09 writes stock to. Amazon joins with its seller ID in M18. */
const PUSHED: readonly ChannelProvider[] = ['ebay', 'website'];

export type StockRefusal =
  | 'not_found'
  | 'bundle'
  | 'version_conflict'
  | 'fba'
  | 'not_this_sku'
  | 'manual_qty_required'
  | 'reason_text_required';

/** A stock rule refused the change. Web answers 409 (404 for not_found). */
export class StockRefused extends Error {
  readonly code: StockRefusal;

  constructor(code: StockRefusal) {
    super(`Stock change refused: ${code}`);
    this.name = 'StockRefused';
    this.code = code;
  }
}

/** The outbound path (M07 OutboundQueue.enqueue): the write and its job, in the caller's tx. */
export interface StockPushQueue {
  enqueue(
    ctx: TenantContext,
    input: {
      channelAccountId: string;
      provider: ChannelProvider;
      operation: string;
      urgent: boolean;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    },
  ): Promise<{ id: string; created: boolean }>;
}

/** CAT-6: the order lines of a listing that moved no stock while it was unmapped (M10). */
export interface UnmappedDemand {
  openLines(
    ctx: TenantContext,
    listingId: string,
  ): Promise<
    readonly {
      orderLineId: string;
      quantity: number;
      dispatched: boolean;
      companyId: string | null;
    }[]
  >;
}

/** An order line event on a listing (M10 reserve and release, M12 dispatch). */
export interface OrderLineMove {
  orderLineId: string;
  listingId: string;
  /** In the listing's own units: packs for a bundle listing. */
  quantity: number;
  companyId?: string | null;
}

export interface AllocationPush {
  listingId: string;
  result: 'queued' | 'unchanged' | 'held';
}

export interface AllocationChange {
  listingId: string;
  mode: StockMode;
  manualQty: number | null;
}

export interface StockMovement {
  id: string;
  at: Date;
  skuId: string;
  sku: string;
  kind: string;
  onHandChange: number;
  reservedChange: number;
  onHandAfter: number;
  reason: 'damaged' | 'count_correction' | 'lost' | 'other' | null;
  note: string | null;
  supplier: string | null;
  sourceKind: 'order_line' | 'refund_line' | 'user' | 'stock_take' | 'allocation' | 'remap';
  actorUserId: string | null;
  /** INV-5: who moved it; null for a removed user. */
  actorName: string | null;
  /** The movement's order is in a company this user can see (or there is no order). */
  companyVisible: boolean;
  /** INV-5: the order's reference, or null when there is none or its company is not visible. */
  orderRef: string | null;
  pushes: { pending: number; sent: number; held: number; failed: number };
}

type PushResult = 'pending' | 'sent' | 'held' | 'failed';

export interface StockListingView {
  id: string;
  channelAccountId: string;
  /** Null when the user cannot see the account's company (ARCHITECTURE 6.1). */
  channelAccountName: string | null;
  provider: ChannelProvider;
  externalSku: string;
  externalId: string;
  title: string | null;
  fulfilment: 'mfn' | 'fba' | null;
  buffer: number;
  bufferOverride: boolean;
  target: number | null;
  cappedByStock: boolean;
  lastSentQty: number | null;
  channelQty: number | null;
  mode: StockMode;
  manual: { qty: number; sold: number; setAt: Date; setBy: string | null } | null;
  syncFailed: boolean;
  lastPush: { at: Date; result: PushResult } | null;
}

export interface StockRowView {
  skuId: string;
  sku: string;
  title: string;
  active: boolean;
  bundle: { componentId: string; componentSku: string; packSize: number } | null;
  onHand: number | null;
  reserved: number;
  available: number;
  oversold: boolean;
  syncFailed: boolean;
  syncMode: 'auto' | 'manual' | 'mixed';
  listingCount: number;
  fbaCount: number;
  lastMovementAt: Date | null;
}

export interface StockDetailView extends StockRowView {
  version: number;
  listings: StockListingView[];
  allocation: { allocated: number; available: number };
  bundles: { id: string; sku: string; packSize: number; available: number }[];
}

export interface MovementFilter {
  skuId?: string;
  kind?: string;
  source?: 'order' | 'user' | 'system';
  /** London days, inclusive. */
  from?: string;
  to?: string;
}

interface Level {
  on_hand: string;
  reserved: string;
  version: string;
}

interface SkuRef {
  id: string;
  component: string;
  pack: number;
}

interface TargetRow {
  id: string;
  channel_account_id: string;
  provider: ChannelProvider;
  external_sku: string;
  fulfilment: 'mfn' | 'fba' | null;
  stock_mode: StockMode;
  manual_qty: string | null;
  manual_sold: string;
  last_queued_qty: string | null;
  pending_write_id: string | null;
  push_seq: string;
  pack: string | null;
  buffer: string;
  paused: boolean | null;
  /** FA-16: the account's writes are held until its first clean reconciliation. */
  held: boolean | null;
}

const n = (v: string | number | null | undefined): number => Number(v ?? 0);
const nOrNull = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** Whole units only: the engine works in safe integers (quantities, never money). */
function units(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError('stock quantities are whole units');
  return value;
}

export class StockEngine {
  readonly #db: Kysely<MainDb>;
  readonly #pushes: StockPushQueue;
  readonly #notifier: Pick<Notifier, 'raise' | 'resolve'>;
  readonly #demand: UnmappedDemand | undefined;
  readonly #now: () => Date;

  constructor(
    db: Kysely<MainDb>,
    deps: {
      pushes: StockPushQueue;
      notifier: Pick<Notifier, 'raise' | 'resolve'>;
      /** M10's open order lines of a listing; none until M10. */
      demand?: UnmappedDemand;
      now?: () => Date;
    },
  ) {
    this.#db = db;
    this.#pushes = deps.pushes;
    this.#notifier = deps.notifier;
    this.#demand = deps.demand;
    this.#now = deps.now ?? (() => new Date());
  }

  // ---- Order line movements (INV-3; M10 and M12 call these) -------------------------------------

  /**
   * Order placed: reserve. Returns `oversold` when it took available below 0 (INV-6): the line is
   * flagged by the caller and the Oversold notice is raised here. A line on an unmapped listing
   * moves nothing (CAT-6); mapping it later back-fills the movement.
   */
  async reserve(
    ctx: TenantContext,
    move: OrderLineMove,
  ): Promise<{ applied: boolean; oversold: boolean; unmapped: boolean }> {
    return this.#tx(ctx, async (trx, ctx) => {
      const sku = await this.#listingSku(trx, ctx, move.listingId);
      if (sku === undefined) return { applied: false, oversold: false, unmapped: true };
      const qty = units(move.quantity) * sku.pack;
      const now = this.#now();
      const moved = await this.#move(trx, ctx, sku.component, {
        kind: 'reserve',
        sourceKind: 'order_line',
        sourceId: move.orderLineId,
        orderLineId: move.orderLineId,
        onHand: 0,
        reserved: qty,
        listingId: move.listingId,
        companyId: move.companyId ?? null,
        now,
      });
      if (moved === undefined) return { applied: false, oversold: false, unmapped: false };
      // The listing that sold: its channel counted down on its own (C7.1), and manual_sold grows.
      await sql`
        UPDATE app.listings
           SET last_order_at = ${now},
               manual_sold = CASE WHEN stock_mode = 'manual'
                                  THEN manual_sold + ${move.quantity} ELSE manual_sold END,
               -- Only when no write is on its way: a waiting write still carries the old number
               -- and would land after the sale, so the recompute must replace it.
               last_queued_qty = CASE
                 WHEN last_queued_qty IS NULL THEN NULL
                 WHEN EXISTS (SELECT 1 FROM app.outbound_writes w
                               WHERE w.workspace_id = app.listings.workspace_id
                                 AND w.id = app.listings.pending_write_id
                                 AND w.state IN ('pending', 'sending')) THEN last_queued_qty
                 ELSE greatest(0, last_queued_qty - ${move.quantity}) END,
               updated_at = ${now}
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${move.listingId}::uuid`.execute(
        trx,
      );
      const oversold = moved.onHandAfter - moved.reservedAfter < 0;
      if (oversold) {
        await this.#notifier.raise(ctx, {
          type: 'inventory.oversold',
          record: { kind: 'order_line', id: move.orderLineId },
          ...(move.companyId ? { companyId: move.companyId } : {}),
        });
      }
      await this.#recompute(trx, ctx, sku.component, moved.id, now);
      await this.#allocationUsedUp(trx, ctx, move.listingId);
      return { applied: true, oversold, unmapped: false };
    });
  }

  /**
   * Order cancelled: the line's own live reservation is released, wherever it is now (a remap
   * moves it). No live reservation (never reserved, already released or dispatched): nothing
   * changes. manual_sold goes back down, never below 0 (C7.1).
   */
  async release(ctx: TenantContext, move: OrderLineMove): Promise<{ applied: boolean }> {
    return this.#orderMove(ctx, move, 'release', async (trx, now) => {
      await sql`
        UPDATE app.listings
           SET manual_sold = CASE
                 WHEN stock_mode = 'manual' AND EXISTS (
                   SELECT 1 FROM app.stock_movements m
                    WHERE m.workspace_id = app.listings.workspace_id
                      AND m.source_kind = 'order_line' AND m.source_id = ${move.orderLineId}
                      AND m.kind = 'reserve' AND m.created_at >= app.listings.manual_set_at)
                 THEN greatest(0, manual_sold - ${move.quantity})
                 ELSE manual_sold END,
               updated_at = ${now}
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${move.listingId}::uuid`.execute(
        trx,
      );
    });
  }

  /**
   * Order dispatched (INV-3): on hand down, and the line's own live reservation released. A line
   * with no live reservation (first seen shipped, or cancelled first) moves on hand only, so other
   * orders' reserved units are never taken (F-M09-T0901-01).
   */
  async dispatch(ctx: TenantContext, move: OrderLineMove): Promise<{ applied: boolean }> {
    return this.#orderMove(ctx, move, 'dispatch');
  }

  /** A refund with "return to stock": on hand up (INV-3). */
  async returnToStock(
    ctx: TenantContext,
    move: { refundLineId: string; listingId: string; quantity: number; companyId?: string | null },
  ): Promise<{ applied: boolean }> {
    return this.#tx(ctx, async (trx, ctx) => {
      const sku = await this.#listingSku(trx, ctx, move.listingId);
      if (sku === undefined) return { applied: false };
      const now = this.#now();
      const moved = await this.#move(trx, ctx, sku.component, {
        kind: 'return',
        sourceKind: 'refund_line',
        sourceId: move.refundLineId,
        onHand: units(move.quantity) * sku.pack,
        reserved: 0,
        listingId: move.listingId,
        companyId: move.companyId ?? null,
        now,
      });
      if (moved === undefined) return { applied: false };
      await this.#recompute(trx, ctx, sku.component, moved.id, now);
      return { applied: true };
    });
  }

  // ---- Movements by hand (INV-3) ---------------------------------------------------------------

  /** Stock-in: on hand up. The form's client_ref is the key, so a resend changes nothing. */
  async stockIn(
    ctx: TenantContext,
    skuId: string,
    input: {
      quantity: number;
      supplier?: string;
      notes?: string;
      clientRef: string;
      userId: string | null;
    },
  ): Promise<StockMovement> {
    return this.#userMove(ctx, skuId, input.clientRef, 'stock_in', {
      onHand: units(input.quantity),
      note: input.notes ?? null,
      supplier: input.supplier ?? null,
      userId: input.userId,
    });
  }

  /** An adjustment with a required reason; `other` needs text (INV-3). */
  async adjust(
    ctx: TenantContext,
    skuId: string,
    input: {
      delta: number;
      reason: 'damaged' | 'count_correction' | 'lost' | 'other';
      text?: string;
      clientRef: string;
      userId: string | null;
    },
  ): Promise<StockMovement> {
    if (input.reason === 'other' && (input.text ?? '').trim() === '') {
      throw new StockRefused('reason_text_required');
    }
    return this.#userMove(ctx, skuId, input.clientRef, 'adjust', {
      onHand: units(input.delta),
      reason: input.reason,
      note: input.text ?? null,
      userId: input.userId,
    });
  }

  /**
   * A stock-take: each SKU's on hand becomes the counted number; one stock_take movement per
   * changed SKU, keyed by the import, so a repeat changes nothing. Returns how many changed.
   */
  async stockTake(
    ctx: TenantContext,
    importId: string,
    rows: readonly { skuId: string; onHand: number }[],
    userId: string | null,
  ): Promise<number> {
    return this.#tx(ctx, async (trx, ctx) => {
      let changed = 0;
      const now = this.#now();
      for (const row of rows) {
        const sku = await this.#plainSku(trx, ctx, row.skuId);
        const level = await this.#lock(trx, ctx, sku.id, now);
        const delta = units(row.onHand) - n(level.on_hand);
        if (delta === 0) continue;
        const moved = await this.#move(trx, ctx, sku.id, {
          kind: 'stock_take',
          sourceKind: 'stock_take',
          sourceId: `${importId}:${sku.id}`,
          onHand: delta,
          reserved: 0,
          userId,
          now,
        });
        if (moved === undefined) continue;
        await this.#recompute(trx, ctx, sku.id, moved.id, now);
        changed += 1;
      }
      return changed;
    });
  }

  // ---- Buffers (INV-2) -------------------------------------------------------------------------

  /** An account's buffer; every target of its listings uses it at once (C7.3). */
  async setAccountBuffer(ctx: TenantContext, accountId: string, buffer: number): Promise<void> {
    await this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      await sql`
        INSERT INTO app.channel_stock_settings (workspace_id, channel_account_id, buffer, updated_at)
        VALUES (${ctx.workspaceId}::uuid, ${accountId}::uuid, ${units(buffer)}, ${now})
        ON CONFLICT (workspace_id, channel_account_id)
        DO UPDATE SET buffer = excluded.buffer, updated_at = excluded.updated_at`.execute(trx);
      await this.#recomputeWhere(trx, ctx, sql`l.channel_account_id = ${accountId}::uuid`, now);
    });
  }

  /** A listing's own buffer, or null to use its account's. */
  async setListingBuffer(
    ctx: TenantContext,
    listingId: string,
    buffer: number | null,
  ): Promise<void> {
    await this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      // The stock row first, then the listing: the order every movement takes (no deadlock).
      const sku = await this.#listingSku(trx, ctx, listingId);
      if (sku !== undefined) await this.#lock(trx, ctx, sku.component, now);
      const { numAffectedRows } = await sql`
        UPDATE app.listings SET buffer_override = ${buffer === null ? null : units(buffer)},
               updated_at = ${now}
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${listingId}::uuid`.execute(trx);
      if (numAffectedRows === 0n) throw new StockRefused('not_found');
      await this.#recomputeWhere(trx, ctx, sql`l.id = ${listingId}::uuid`, now);
    });
  }

  // ---- Manual allocation (INV-10, C7) ----------------------------------------------------------

  /**
   * One save of a SKU's allocation (C7.2): checked against the SKU's version in the same
   * transaction, so a change since the form was read (an order, another save) is refused. FBA
   * cannot be manual (INV-9); every named listing must be this SKU's or one of its bundles'.
   */
  async saveAllocation(
    ctx: TenantContext,
    skuId: string,
    input: {
      version: number;
      listings: readonly { listingId: string; mode: StockMode; manualQty?: number }[];
      userId: string | null;
    },
  ): Promise<{ pushes: AllocationPush[]; changes: AllocationChange[] }> {
    return this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      const sku = await this.#plainSku(trx, ctx, skuId);
      const level = await this.#lock(trx, ctx, sku.id, now);
      if (n(level.version) !== input.version) throw new StockRefused('version_conflict');
      const own = await this.#ownListings(trx, ctx, sku.id);
      const changes: AllocationChange[] = [];
      for (const item of input.listings) {
        const listing = own.get(item.listingId);
        if (listing === undefined) throw new StockRefused('not_this_sku');
        if (listing.fulfilment === 'fba') throw new StockRefused('fba');
        if (item.mode === 'manual' && item.manualQty === undefined) {
          throw new StockRefused('manual_qty_required');
        }
        const qty = item.mode === 'manual' ? units(item.manualQty ?? 0) : null;
        if (item.mode === listing.stock_mode && qty === nOrNull(listing.manual_qty)) continue;
        await this.#setMode(trx, ctx, item.listingId, qty, input.userId, now);
        changes.push({ listingId: item.listingId, mode: item.mode, manualQty: qty });
      }
      await this.#logAllocation(trx, ctx, sku.id, level, changes, input.userId, now);
      const pushes = await this.#recompute(trx, ctx, sku.id, undefined, now);
      return { pushes, changes };
    });
  }

  /**
   * Back to Auto (C7.2): the named listings, or every manual listing of the SKU (with bundles,
   * theirs too), drop their manual settings, and one write each is queued right away.
   */
  async backToAuto(
    ctx: TenantContext,
    skuId: string,
    input: { listingIds?: readonly string[]; includeBundles: boolean; userId: string | null },
  ): Promise<{ pushes: AllocationPush[]; changes: AllocationChange[] }> {
    return this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      const sku = await this.#plainSku(trx, ctx, skuId);
      const level = await this.#lock(trx, ctx, sku.id, now);
      const own = await this.#ownListings(trx, ctx, sku.id);
      const chosen =
        input.listingIds ??
        [...own.values()]
          .filter((l) => l.fulfilment !== 'fba' && (input.includeBundles || l.pack === null))
          .map((l) => l.id);
      const changes: AllocationChange[] = [];
      for (const id of chosen) {
        const listing = own.get(id);
        if (listing === undefined) throw new StockRefused('not_this_sku');
        if (listing.stock_mode === 'manual') {
          await this.#setMode(trx, ctx, id, null, input.userId, now);
          changes.push({ listingId: id, mode: 'auto', manualQty: null });
        }
      }
      await this.#logAllocation(trx, ctx, sku.id, level, changes, input.userId, now);
      return {
        pushes: await this.#recompute(trx, ctx, sku.id, undefined, now, new Set(chosen)),
        changes,
      };
    });
  }

  // ---- Catalogue hooks (CAT-5, CAT-6, C7.3) ----------------------------------------------------

  /**
   * CAT-6 listener. Unmapped or remapped: the listing leaves its old SKU, its manual settings
   * go (a remap raises the notice) and its waiting write is cancelled (an unmapped listing gets
   * no writes). Mapped: its unmapped orders' movements are back-filled once (same keys), and its
   * target is pushed.
   */
  async onListingMapped(
    ctx: TenantContext,
    change: { listingId: string; masterSkuId: string | null; previousMasterSkuId: string | null },
  ): Promise<void> {
    await this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      // Stock rows before the listing row, in a fixed order (no deadlock with a movement).
      await this.#lockComponents(
        trx,
        ctx,
        [change.previousMasterSkuId, change.masterSkuId].flatMap((id) => (id === null ? [] : [id])),
        now,
      );
      if (change.previousMasterSkuId !== null) {
        const wasManual = await this.#clearListing(trx, ctx, change.listingId, now);
        if (wasManual && change.masterSkuId !== null) {
          await this.#notifier.raise(ctx, {
            type: 'inventory.mode_reset',
            record: { kind: 'listing', id: change.listingId },
          });
        }
      }
      if (change.masterSkuId === null) return;
      const sku = await this.#listingSku(trx, ctx, change.listingId);
      if (sku === undefined) return;
      if (change.previousMasterSkuId !== null) {
        await this.#moveOpenReserves(
          trx,
          ctx,
          change.listingId,
          change.previousMasterSkuId,
          sku,
          now,
        );
      }
      for (const line of (await this.#demand?.openLines(ctx, change.listingId)) ?? []) {
        const qty = units(line.quantity) * sku.pack;
        const base = {
          sourceKind: 'order_line' as const,
          sourceId: line.orderLineId,
          orderLineId: line.orderLineId,
          listingId: change.listingId,
          companyId: line.companyId,
          now,
        };
        await this.#move(trx, ctx, sku.component, {
          ...base,
          kind: 'reserve',
          onHand: 0,
          reserved: qty,
        });
        // A line already shipped goes through the same line-based dispatch (F-M09-T0901-01).
        if (line.dispatched) {
          await this.dispatch(ctx, {
            orderLineId: line.orderLineId,
            listingId: change.listingId,
            quantity: line.quantity,
            companyId: line.companyId,
          });
        }
      }
      await this.#lock(trx, ctx, sku.component, now);
      await this.#recompute(trx, ctx, sku.component, undefined, now);
    });
  }

  /** C7.3: a listing that ended loses its manual settings and its waiting write. */
  async onListingsEnded(ctx: TenantContext, listingIds: readonly string[]): Promise<void> {
    await this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      for (const id of listingIds) {
        const sku = await this.#listingSku(trx, ctx, id);
        if (sku !== undefined) await this.#lock(trx, ctx, sku.component, now);
        await this.#clearListing(trx, ctx, id, now);
      }
    });
  }

  // ---- Push results (INV-8) --------------------------------------------------------------------

  /**
   * After the outbound path settled a stock write: sent records the quantity and clears Sync
   * failed; a final failure (or the channel refusing the SKU) sets the badge and the notice.
   */
  async recordPushResult(ctx: TenantContext, writeId: string): Promise<void> {
    await this.#tx(ctx, async (trx, ctx) => {
      const { rows } = await sql<{
        listing_id: string;
        quantity: string;
        state: string;
        refused: number;
        company_id: string | null;
        channel_account_id: string;
      }>`
        SELECT lw.listing_id, lw.quantity, w.state, w.channel_account_id,
               coalesce(jsonb_array_length(w.result -> 'refused'), 0) AS refused,
               a.company_id
          FROM app.listing_writes lw
          JOIN app.outbound_writes w
            ON w.workspace_id = lw.workspace_id AND w.id = lw.outbound_write_id
          LEFT JOIN app.channel_accounts a
            ON a.workspace_id = w.workspace_id AND a.id = w.channel_account_id
         WHERE lw.workspace_id = ${ctx.workspaceId}::uuid
           AND lw.outbound_write_id = ${writeId}::uuid`.execute(trx);
      const row = rows[0];
      if (row === undefined) return;
      const now = this.#now();
      // The stock row before the listing row: the order every movement takes (F-M09-T0901-02).
      const sku = await this.#listingSku(trx, ctx, row.listing_id);
      if (sku !== undefined) await this.#lock(trx, ctx, sku.component, now);
      const record = { kind: 'listing', id: row.listing_id };
      if (row.state === 'sent' && n(row.refused) === 0) {
        const { numAffectedRows } = await sql`
          UPDATE app.listings SET last_sent_qty = ${n(row.quantity)}, sync_failed_at = NULL,
                 updated_at = ${now}
           WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${row.listing_id}::uuid
             AND sync_failed_at IS NOT NULL`.execute(trx);
        if (numAffectedRows === 0n) {
          await sql`
            UPDATE app.listings SET last_sent_qty = ${n(row.quantity)}, updated_at = ${now}
             WHERE workspace_id = ${ctx.workspaceId}::uuid
               AND id = ${row.listing_id}::uuid`.execute(trx);
        } else {
          await this.#notifier.resolve(ctx, 'inventory.sync_failed', record);
        }
        await this.#reorderGuard(trx, ctx, writeId, row.listing_id, now);
        return;
      }
      if (row.state === 'failed' || row.state === 'sent') {
        await sql`
          UPDATE app.listings SET sync_failed_at = ${now}, updated_at = ${now}
           WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${row.listing_id}::uuid`.execute(
          trx,
        );
        await this.#notifier.raise(ctx, {
          type: 'inventory.sync_failed',
          record,
          ...(row.company_id === null ? {} : { companyId: row.company_id }),
          channelAccountId: row.channel_account_id,
        });
      }
    });
  }

  /**
   * An older write that was already sending when a newer one was queued may land after it: the
   * channel then shows the older number. When that happens, the listing's target is sent again.
   */
  async #reorderGuard(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    writeId: string,
    listingId: string,
    now: Date,
  ): Promise<void> {
    const { rows } = await sql<{ component: string }>`
      SELECT coalesce(s.bundle_component_id, s.id) AS component
        FROM app.listings l
        JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
        JOIN app.outbound_writes x ON x.workspace_id = l.workspace_id AND x.id = ${writeId}::uuid
        JOIN app.outbound_writes cur
          ON cur.workspace_id = l.workspace_id AND cur.id = l.pending_write_id
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.id = ${listingId}::uuid
         AND l.pending_write_id <> ${writeId}::uuid
         AND cur.state = 'sent' AND cur.sent_at <= x.sent_at`.execute(trx);
    const component = rows[0]?.component;
    if (component === undefined) return;
    await this.#lock(trx, ctx, component, now);
    await this.#recompute(trx, ctx, component, undefined, now, new Set([listingId]));
  }

  // ---- Reconciliation (INV-7) and bulk push (SAFE-1) -------------------------------------------

  /**
   * After a complete listing scan of an account: each listing's channel quantity (just read) is
   * compared with its target. Drift is corrected with a new write and logged; a listing with an
   * order in the 15 minutes before the scan, or a write still on its way, is skipped. Drift on
   * two runs in a row raises the notice.
   */
  async reconcile(
    run: <T>(fn: (ctx: TenantContext) => Promise<T>) => Promise<T>,
    accountId: string,
    scanStartedAt: Date,
  ): Promise<{ checked: number; drifted: number }> {
    // One short transaction to read, then one per SKU, so no SKU's stock row waits on the whole
    // account's run (F-M09-T0901-03). `run` opens each (the worker's tenancy).
    const rows = await run((outer) =>
      this.#tx(outer, (trx, ctx) => this.#driftCandidates(trx, ctx, accountId, scanStartedAt)),
    );
    const byComponent = new Map<string, { id: string; channelQty: number }[]>();
    for (const r of rows) {
      const list = byComponent.get(r.component) ?? [];
      list.push({ id: r.id, channelQty: n(r.channel_qty) });
      byComponent.set(r.component, list);
    }
    let drifted = 0;
    for (const [component, listings] of byComponent) {
      drifted += await run((outer) =>
        this.#tx(outer, (trx, ctx) =>
          this.#reconcileComponent(trx, ctx, accountId, component, listings),
        ),
      );
    }
    // FA-16 cutover: the first reconciliation that checks listings and finds no drift switches
    // the account's stock writes on. A drifting one leaves them held for the seller to fix.
    if (drifted === 0 && rows.length > 0) {
      await run((outer) =>
        this.#tx(outer, async (trx, ctx) => {
          await sql`UPDATE app.channel_accounts SET stock_push_held_since = NULL
                     WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${accountId}::uuid
                       AND stock_push_held_since IS NOT NULL`.execute(trx);
        }),
      );
    }
    return { checked: rows.length, drifted };
  }

  async #driftCandidates(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    accountId: string,
    scanStartedAt: Date,
  ) {
    const quiet = new Date(scanStartedAt.getTime() - 15 * 60_000);
    const { rows } = await sql<{ id: string; component: string; channel_qty: string }>`
        SELECT l.id, coalesce(s.bundle_component_id, s.id) AS component, l.channel_qty
          FROM app.listings l
          JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
          LEFT JOIN app.outbound_writes w
            ON w.workspace_id = l.workspace_id AND w.id = l.pending_write_id
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid
           AND l.channel_account_id = ${accountId}::uuid
           AND l.ended_at IS NULL AND l.fulfilment IS DISTINCT FROM 'fba'
           AND l.provider = ANY (${sql.val(PUSHED)}::text[])
           AND l.channel_qty IS NOT NULL AND l.last_seen_at >= ${scanStartedAt}
           AND (l.last_order_at IS NULL OR l.last_order_at < ${quiet})
           AND (w.id IS NULL OR w.state NOT IN ('pending', 'sending'))
           -- A write that reached the channel after the scan read it: the read is stale.
           AND NOT EXISTS (SELECT 1 FROM app.listing_writes lw
                             JOIN app.outbound_writes sw
                               ON sw.workspace_id = lw.workspace_id AND sw.id = lw.outbound_write_id
                            WHERE lw.workspace_id = l.workspace_id AND lw.listing_id = l.id
                              AND sw.sent_at >= ${scanStartedAt})
         ORDER BY component, l.id`.execute(trx);
    return rows;
  }

  /** One SKU's part of the reconciliation, in its own transaction. Answers how many drifted. */
  async #reconcileComponent(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    accountId: string,
    component: string,
    listings: readonly { id: string; channelQty: number }[],
  ): Promise<number> {
    const now = this.#now();
    let drifted = 0;
    const level = await this.#lock(trx, ctx, component, now);
    const targets = await this.#targets(trx, ctx, component, level);
    const off = new Set<string>();
    for (const l of listings) {
      const t = targets.get(l.id);
      if (t === undefined) continue;
      if (t.target === l.channelQty) {
        const { numAffectedRows } = await sql`
              UPDATE app.listings SET drift_count = 0
               WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${l.id}::uuid
                 AND drift_count > 0`.execute(trx);
        if (numAffectedRows !== undefined && numAffectedRows > 0n) {
          await this.#notifier.resolve(ctx, 'inventory.sync_failed', {
            kind: 'listing_drift',
            id: l.id,
          });
        }
        continue;
      }
      off.add(l.id);
      drifted += 1;
      await sql`
            INSERT INTO app.stock_reconciliations
              (workspace_id, id, channel_account_id, listing_id, channel_qty, target, created_at)
            VALUES (${ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${accountId}::uuid,
                    ${l.id}::uuid, ${l.channelQty}, ${t.target}, ${now})`.execute(trx);
      const { rows: counted } = await sql<{ drift_count: string }>`
            UPDATE app.listings SET drift_count = drift_count + 1, updated_at = ${now}
             WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${l.id}::uuid
            RETURNING drift_count`.execute(trx);
      if (n(counted[0]?.drift_count) >= 2) {
        await this.#notifier.raise(ctx, {
          type: 'inventory.sync_failed',
          record: { kind: 'listing_drift', id: l.id },
          channelAccountId: accountId,
        });
      }
    }
    if (off.size > 0) await this.#recompute(trx, ctx, component, undefined, now, off);
    return drifted;
  }

  /** SAFE-1 bulk stock push: every listing of these accounts gets its target sent now. */
  async pushAccounts(ctx: TenantContext, accountIds: readonly string[]): Promise<number> {
    return this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      const { rows } = await sql<{ id: string; component: string }>`
        SELECT l.id, coalesce(s.bundle_component_id, s.id) AS component
          FROM app.listings l
          JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid
           AND l.channel_account_id = ANY (${sql.val(accountIds)}::uuid[])
           AND l.ended_at IS NULL
         ORDER BY component`.execute(trx);
      const byComponent = new Map<string, Set<string>>();
      for (const r of rows) {
        byComponent.set(r.component, (byComponent.get(r.component) ?? new Set()).add(r.id));
      }
      let queued = 0;
      for (const [component, ids] of byComponent) {
        await this.#lock(trx, ctx, component, now);
        const pushes = await this.#recompute(trx, ctx, component, undefined, now, ids);
        queued += pushes.filter((p) => p.result !== 'unchanged').length;
      }
      return queued;
    });
  }

  /** INV-5: the change log is kept 3 years; the definer deletes only older rows. */
  async purgeExpired(ctx: TenantContext): Promise<number> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ deleted: string }>`
        SELECT app.purge_stock_movements() AS deleted`.execute(trx);
      return n(rows[0]?.deleted);
    });
  }

  // ---- Reads -----------------------------------------------------------------------------------

  async listStock(
    ctx: TenantContext,
    filter: {
      q?: string;
      filter?: 'oversold' | 'sync_failed' | 'manual' | 'bundles';
      offset: number;
      limit: number;
    },
    countUpTo: number,
  ): Promise<{ items: StockRowView[]; total: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const conditions = [sql`TRUE`];
      if (filter.q !== undefined) {
        const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        conditions.push(sql`(r.sku ILIKE ${like} OR r.title ILIKE ${like})`);
      }
      if (filter.filter === 'oversold') conditions.push(sql`r.oversold`);
      if (filter.filter === 'sync_failed') conditions.push(sql`r.sync_failed`);
      if (filter.filter === 'manual') conditions.push(sql`r.manual_count > 0`);
      if (filter.filter === 'bundles') conditions.push(sql`r.bundle_component_id IS NOT NULL`);
      const where = sql.join(conditions, sql` AND `);
      const { rows } = await sql<StockRowSql>`
        SELECT * FROM (${stockRows(ctx)}) r WHERE ${where}
         ORDER BY r.sku LIMIT ${filter.limit} OFFSET ${filter.offset}`.execute(trx);
      const count = await sql<{ n: string }>`
        SELECT count(*) AS n FROM (SELECT 1 FROM (${stockRows(ctx)}) r WHERE ${where}
                                   LIMIT ${countUpTo}) t`.execute(trx);
      return { items: rows.map(toRow), total: n(count.rows[0]?.n) };
    });
  }

  async getStock(ctx: TenantContext, skuId: string): Promise<StockDetailView | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<StockRowSql & { version: string | null }>`
        SELECT r.*, lv.version FROM (${stockRows(ctx)}) r
          LEFT JOIN app.stock_levels lv
            ON lv.workspace_id = ${ctx.workspaceId}::uuid
           AND lv.master_sku_id = coalesce(r.bundle_component_id, r.sku_id)
         WHERE r.sku_id = ${skuId}::uuid`.execute(trx);
      const row = rows[0];
      if (row === undefined) return undefined;
      const component = row.bundle_component_id ?? row.sku_id;
      const componentAvailable = n(row.component_available);
      const listings = await this.#listingViews(trx, ctx, skuId, componentAvailable);
      const { rows: bundles } = await sql<{ id: string; sku: string; pack_size: string }>`
        SELECT id, sku, pack_size FROM app.master_skus
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND bundle_component_id = ${component}::uuid
         ORDER BY sku`.execute(trx);
      const manual = listings.filter((l) => l.mode === 'manual' && l.manual !== null);
      return {
        ...toRow(row),
        version: n(row.version),
        listings,
        allocation: {
          allocated: manual.reduce(
            (sum, l) => sum + remainingAllocation(l.manual?.qty ?? 0, l.manual?.sold ?? 0),
            0,
          ),
          available: toRow(row).available,
        },
        bundles: row.bundle_component_id
          ? []
          : bundles.map((b) => ({
              id: b.id,
              sku: b.sku,
              packSize: n(b.pack_size),
              available: Math.max(0, Math.floor(componentAvailable / n(b.pack_size))),
            })),
      };
    });
  }

  async listMovements(
    ctx: TenantContext,
    filter: MovementFilter & { offset: number; limit: number },
    countUpTo: number,
  ): Promise<{ items: StockMovement[]; total: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const where = movementWhere(ctx, filter);
      const { rows } = await sql<MovementSql>`
        ${movementSelect(ctx)} AND ${where}
         ORDER BY m.created_at DESC, m.id LIMIT ${filter.limit} OFFSET ${filter.offset}`.execute(
        trx,
      );
      const count = await sql<{ n: string }>`
        SELECT count(*) AS n FROM (SELECT 1 FROM app.stock_movements m WHERE ${where}
                                   LIMIT ${countUpTo}) t`.execute(trx);
      return { items: rows.map(toMovement), total: n(count.rows[0]?.n) };
    });
  }

  /** The change log for the CSV export, oldest first; undefined above `cap` rows. */
  async exportMovements(
    ctx: TenantContext,
    filter: MovementFilter,
    cap: number,
  ): Promise<StockMovement[] | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<MovementSql>`
        ${movementSelect(ctx)} AND ${movementWhere(ctx, filter)}
         ORDER BY m.created_at, m.id LIMIT ${cap + 1}`.execute(trx);
      return rows.length > cap ? undefined : rows.map(toMovement);
    });
  }

  /** The buffer of each sales account this user can see (RLS: permitted companies). */
  async buffers(ctx: TenantContext): Promise<
    {
      channelAccountId: string;
      provider: ChannelProvider;
      displayName: string;
      buffer: number;
    }[]
  > {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{
        id: string;
        provider: ChannelProvider;
        display_name: string;
        buffer: string | null;
      }>`
        SELECT a.id, a.provider, a.display_name, cs.buffer
          FROM app.channel_accounts a
          LEFT JOIN app.channel_stock_settings cs
            ON cs.workspace_id = a.workspace_id AND cs.channel_account_id = a.id
         WHERE a.workspace_id = ${ctx.workspaceId}::uuid
           AND a.provider IN ('amazon', 'ebay', 'website') AND a.archived_at IS NULL
         ORDER BY a.display_name, a.id`.execute(trx);
      return rows.map((r) => ({
        channelAccountId: r.id,
        provider: r.provider,
        displayName: r.display_name,
        buffer: n(r.buffer),
      }));
    });
  }

  /** One listing's stock view (after a buffer change). */
  async listingView(ctx: TenantContext, listingId: string): Promise<StockListingView | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ master_sku_id: string | null }>`
        SELECT master_sku_id FROM app.listings
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${listingId}::uuid`.execute(trx);
      const skuId = rows[0]?.master_sku_id;
      if (skuId === undefined || skuId === null) return undefined;
      const detail = await this.getStock(ctx, skuId);
      return detail?.listings.find((l) => l.id === listingId);
    });
  }

  // ---- Internals -------------------------------------------------------------------------------

  /**
   * Joins the caller's request or job transaction when there is one (invariant 3); otherwise
   * opens one. Either way `fn` gets a context bound to it, so the outbound queue and the notifier
   * write in the same transaction as the movement.
   */
  #tx<T>(
    ctx: TenantContext,
    fn: (trx: Transaction<MainDb>, ctx: TenantContext) => Promise<T>,
  ): Promise<T> {
    return withBoundTenant(this.#db, ctx, fn);
  }

  async #orderMove(
    ctx: TenantContext,
    move: OrderLineMove,
    kind: 'release' | 'dispatch',
    after?: (trx: Transaction<MainDb>, now: Date) => Promise<void>,
  ): Promise<{ applied: boolean }> {
    return this.#tx(ctx, async (trx, ctx) => {
      const now = this.#now();
      const line = move.orderLineId;
      // The line's own SKU: where it is reserved now, else where it was first reserved, else (a
      // line first seen shipped) the listing's mapping. A remap moves a reservation only under
      // both stock rows' locks, so look, lock, and look again until they agree.
      const first = await this.#lineHistory(trx, ctx, line);
      const listing =
        first.reserveSku === null ? await this.#listingSku(trx, ctx, move.listingId) : undefined;
      let component = first.live?.component ?? first.reserveSku ?? listing?.component;
      if (component === undefined) return { applied: false };
      let live = first.live;
      for (let tries = 0; tries < 3; tries += 1) {
        await this.#lock(trx, ctx, component, now);
        live = (await this.#lineHistory(trx, ctx, line)).live;
        if (live === undefined || live.component === component) break;
        component = live.component;
      }
      const reserved = live?.component === component ? live.reserved : 0;
      if (kind === 'release' && reserved === 0) return { applied: false };
      // A dispatch ships what the line reserved; with nothing reserved, what it first reserved,
      // or (never reserved) the quantity given in the listing's units.
      const shipped =
        reserved > 0
          ? reserved
          : first.reservedAtFirst > 0
            ? first.reservedAtFirst
            : units(move.quantity) * (listing?.pack ?? 1);
      const moved = await this.#move(trx, ctx, component, {
        kind,
        sourceKind: 'order_line',
        sourceId: line,
        orderLineId: line,
        onHand: kind === 'dispatch' ? -shipped : 0,
        reserved: -reserved,
        listingId: move.listingId,
        companyId: move.companyId ?? null,
        now,
      });
      if (moved === undefined) return { applied: false };
      await after?.(trx, now);
      await this.#recompute(trx, ctx, component, moved.id, now);
      return { applied: true };
    });
  }

  async #userMove(
    ctx: TenantContext,
    skuId: string,
    clientRef: string,
    kind: 'stock_in' | 'adjust',
    input: {
      onHand: number;
      reason?: 'damaged' | 'count_correction' | 'lost' | 'other';
      note: string | null;
      supplier?: string | null;
      userId: string | null;
    },
  ): Promise<StockMovement> {
    return this.#tx(ctx, async (trx, ctx) => {
      const sku = await this.#plainSku(trx, ctx, skuId);
      const now = this.#now();
      const moved = await this.#move(trx, ctx, sku.id, {
        kind,
        sourceKind: 'user',
        sourceId: clientRef,
        onHand: input.onHand,
        reserved: 0,
        reason: input.reason ?? null,
        note: input.note,
        supplier: input.supplier ?? null,
        userId: input.userId,
        now,
      });
      if (moved !== undefined) await this.#recompute(trx, ctx, sku.id, moved.id, now);
      // The movement this client_ref made, now or the first time (a resend returns it again).
      const { rows } = await sql<MovementSql>`
        ${movementSelect(ctx)} AND m.source_kind = 'user' AND m.source_id = ${clientRef}
                               AND m.kind = ${kind}`.execute(trx);
      const row = rows[0];
      if (row === undefined || row.master_sku_id !== sku.id) throw new StockRefused('not_found');
      return toMovement(row);
    });
  }

  /** Locks the stock row of a plain SKU (creating it at 0 the first time) and returns it. */
  async #lock(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    skuId: string,
    now: Date,
  ): Promise<Level> {
    await sql`
      INSERT INTO app.stock_levels (workspace_id, master_sku_id, updated_at)
      VALUES (${ctx.workspaceId}::uuid, ${skuId}::uuid, ${now})
      ON CONFLICT (workspace_id, master_sku_id) DO NOTHING`.execute(trx);
    const { rows } = await sql<Level>`
      SELECT on_hand, reserved, version FROM app.stock_levels
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND master_sku_id = ${skuId}::uuid
       FOR UPDATE`.execute(trx);
    const level = rows[0];
    if (level === undefined) throw new StockRefused('not_found');
    return level;
  }

  /**
   * One movement: lock, insert under the unique key, and only when it is new move the numbers.
   * Undefined when the same event was already recorded (FA-10).
   */
  async #move(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    skuId: string,
    m: {
      kind: string;
      sourceKind: StockMovement['sourceKind'];
      sourceId: string;
      onHand: number;
      reserved: number;
      reason?: StockMovement['reason'];
      note?: string | null;
      supplier?: string | null;
      userId?: string | null;
      listingId?: string;
      companyId?: string | null;
      /** The order line this movement belongs to (its live reservation is the sum of these). */
      orderLineId?: string;
      now: Date;
    },
  ): Promise<{ id: string; onHandAfter: number; reservedAfter: number } | undefined> {
    const level = await this.#lock(trx, ctx, skuId, m.now);
    const onHandAfter = n(level.on_hand) + m.onHand;
    // Reserved never goes below 0: a release of more than is held only clears it (INV-1).
    const reservedAfter = Math.max(0, n(level.reserved) + m.reserved);
    const reservedChange = reservedAfter - n(level.reserved);
    const id = randomUUID();
    const { rows } = await sql<{ id: string }>`
      INSERT INTO app.stock_movements
        (workspace_id, id, master_sku_id, kind, source_kind, source_id, on_hand_change,
         reserved_change, on_hand_after, reserved_after, reason, note, supplier, actor_user_id,
         listing_id, order_company_id, order_line_id, created_at)
      VALUES (${ctx.workspaceId}::uuid, ${id}::uuid, ${skuId}::uuid, ${m.kind}, ${m.sourceKind},
              ${m.sourceId}, ${m.onHand}, ${reservedChange}, ${onHandAfter}, ${reservedAfter},
              ${m.reason ?? null}, ${m.note ?? null}, ${m.supplier ?? null}, ${m.userId ?? null},
              ${m.listingId ?? null}, ${m.companyId ?? null}, ${m.orderLineId ?? null}, ${m.now})
      ON CONFLICT (workspace_id, source_kind, source_id, kind) DO NOTHING
      RETURNING id`.execute(trx);
    if (rows.length === 0) return undefined;
    await sql`
      UPDATE app.stock_levels
         SET on_hand = ${onHandAfter}, reserved = ${reservedAfter}, version = version + 1,
             last_movement_at = ${m.now}, updated_at = ${m.now}
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND master_sku_id = ${skuId}::uuid`.execute(
      trx,
    );
    return { id, onHandAfter, reservedAfter };
  }

  /**
   * An order line's stock so far (F-M09-T0901-01): where it is reserved now and how much (the sum
   * of its reserved changes per SKU), the SKU of its first reserve and what that reserved.
   */
  async #lineHistory(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    line: string,
  ): Promise<{
    live: { component: string; reserved: number } | undefined;
    reserveSku: string | null;
    reservedAtFirst: number;
  }> {
    const { rows } = await sql<{
      master_sku_id: string;
      reserved: string;
      first_reserve: string | null;
      first_at: Date | null;
    }>`
      SELECT master_sku_id, sum(reserved_change) AS reserved,
             (array_agg(reserved_change ORDER BY created_at)
                FILTER (WHERE kind = 'reserve' AND source_kind = 'order_line'))[1] AS first_reserve,
             min(created_at) FILTER (WHERE kind = 'reserve' AND source_kind = 'order_line')
               AS first_at
        FROM app.stock_movements
       WHERE workspace_id = ${ctx.workspaceId}::uuid
         -- Two indexed branches (0047's line index, the unique key), never a scan of the log.
         AND (order_line_id = ${line}
              OR (order_line_id IS NULL AND source_kind = 'order_line' AND source_id = ${line}))
       GROUP BY master_sku_id`.execute(trx);
    const live = rows.find((r) => n(r.reserved) > 0);
    const first = rows
      .filter((r) => r.first_at !== null)
      .sort((a, b) => (a.first_at?.getTime() ?? 0) - (b.first_at?.getTime() ?? 0))[0];
    return {
      live:
        live === undefined
          ? undefined
          : { component: live.master_sku_id, reserved: n(live.reserved) },
      reserveSku: first?.master_sku_id ?? null,
      reservedAtFirst: n(first?.first_reserve ?? 0),
    };
  }

  /**
   * A remap (CAT-5, F-M09-T0901-01): each open order line of the listing takes its live
   * reservation to the new SKU, as a release on the old SKU and a reserve on the new one (source
   * kind remap), converted through the pack sizes. Both stock rows are locked by the caller.
   */
  async #moveOpenReserves(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    listingId: string,
    previousSkuId: string,
    next: SkuRef,
    now: Date,
  ): Promise<void> {
    const { rows: prev } = await sql<{ component: string; pack: string }>`
      SELECT coalesce(bundle_component_id, id) AS component, coalesce(pack_size, 1) AS pack
        FROM app.master_skus
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${previousSkuId}::uuid`.execute(trx);
    const old = prev[0];
    if (old === undefined) return;
    const { rows: open } = await sql<{ line: string; reserved: string }>`
      SELECT coalesce(order_line_id, source_id) AS line, sum(reserved_change) AS reserved
        FROM app.stock_movements
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND master_sku_id = ${old.component}::uuid
         AND (order_line_id IS NOT NULL OR source_kind = 'order_line')
       GROUP BY coalesce(order_line_id, source_id)
      -- The old SKU's movements (indexed by SKU), keeping the lines of this listing.
      HAVING sum(reserved_change) > 0 AND bool_or(listing_id = ${listingId}::uuid)
       ORDER BY 1`.execute(trx);
    let movedAny = false;
    for (const o of open) {
      const reserved = n(o.reserved);
      // Units of the listing: what the order bought, in packs for a bundle listing.
      const bought = Math.floor(reserved / n(old.pack));
      const key = `${o.line}:${randomUUID()}`;
      await this.#move(trx, ctx, old.component, {
        kind: 'release',
        sourceKind: 'remap',
        sourceId: key,
        orderLineId: o.line,
        onHand: 0,
        reserved: -reserved,
        listingId,
        note: 'moved to the newly mapped SKU',
        now,
      });
      await this.#move(trx, ctx, next.component, {
        kind: 'reserve',
        sourceKind: 'remap',
        sourceId: key,
        orderLineId: o.line,
        onHand: 0,
        reserved: bought * next.pack,
        listingId,
        note: 'moved from the previously mapped SKU',
        now,
      });
      movedAny = true;
    }
    if (movedAny) await this.#recompute(trx, ctx, old.component, undefined, now);
  }

  /** Locks the stock rows of these SKUs' components, in id order. */
  async #lockComponents(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    skuIds: readonly string[],
    now: Date,
  ): Promise<void> {
    if (skuIds.length === 0) return;
    const { rows } = await sql<{ component: string }>`
      SELECT DISTINCT coalesce(bundle_component_id, id) AS component FROM app.master_skus
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ANY (${sql.val(skuIds)}::uuid[])
       ORDER BY component`.execute(trx);
    for (const r of rows) await this.#lock(trx, ctx, r.component, now);
  }

  /** The SKU a listing is mapped to, as its component and pack (1 for a plain SKU). */
  async #listingSku(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    listingId: string,
  ): Promise<SkuRef | undefined> {
    const { rows } = await sql<{ id: string; component: string; pack: string }>`
      SELECT s.id, coalesce(s.bundle_component_id, s.id) AS component,
             coalesce(s.pack_size, 1) AS pack
        FROM app.listings l
        JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.id = ${listingId}::uuid`.execute(trx);
    const row = rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, component: row.component, pack: n(row.pack) };
  }

  /** A plain SKU, for hand movements and allocation; a bundle has no stock of its own (CAT-3). */
  async #plainSku(trx: Transaction<MainDb>, ctx: TenantContext, skuId: string): Promise<SkuRef> {
    const { rows } = await sql<{ id: string; bundle_component_id: string | null }>`
      SELECT id, bundle_component_id FROM app.master_skus
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${skuId}::uuid`.execute(trx);
    const row = rows[0];
    if (row === undefined) throw new StockRefused('not_found');
    if (row.bundle_component_id !== null) throw new StockRefused('bundle');
    return { id: row.id, component: row.id, pack: 1 };
  }

  /** The listings of a SKU and of its bundles, locked. */
  async #ownListings(trx: Transaction<MainDb>, ctx: TenantContext, skuId: string) {
    const { rows } = await sql<{
      id: string;
      fulfilment: 'mfn' | 'fba' | null;
      stock_mode: StockMode;
      manual_qty: string | null;
      pack: string | null;
    }>`
      SELECT l.id, l.fulfilment, l.stock_mode, l.manual_qty, s.pack_size AS pack
        FROM app.listings l
        JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.ended_at IS NULL
         AND (s.id = ${skuId}::uuid OR s.bundle_component_id = ${skuId}::uuid)
       FOR UPDATE OF l`.execute(trx);
    return new Map(rows.map((r) => [r.id, r] as const));
  }

  async #setMode(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    listingId: string,
    manualQty: number | null,
    userId: string | null,
    now: Date,
  ): Promise<void> {
    await sql`
      UPDATE app.listings
         SET stock_mode = ${manualQty === null ? 'auto' : 'manual'},
             manual_qty = ${manualQty},
             manual_sold = 0,
             manual_set_at = ${manualQty === null ? null : now},
             manual_set_by = ${manualQty === null ? null : userId},
             updated_at = ${now}
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${listingId}::uuid`.execute(trx);
  }

  /** Every allocation change goes to the change log (C7.2) and bumps the SKU's version. */
  async #logAllocation(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    skuId: string,
    level: Level,
    changes: readonly AllocationChange[],
    userId: string | null,
    now: Date,
  ): Promise<void> {
    for (const c of changes) {
      await sql`
        INSERT INTO app.stock_movements
          (workspace_id, id, master_sku_id, kind, source_kind, source_id, on_hand_change,
           reserved_change, on_hand_after, reserved_after, note, actor_user_id, listing_id,
           created_at)
        VALUES (${ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${skuId}::uuid, 'allocation',
                'allocation', ${randomUUID()}, 0, 0, ${n(level.on_hand)}, ${n(level.reserved)},
                ${c.mode === 'manual' ? `manual ${String(c.manualQty)}` : 'auto'},
                ${userId}, ${c.listingId}::uuid, ${now})`.execute(trx);
    }
    await sql`
      UPDATE app.stock_levels SET version = version + 1, updated_at = ${now}
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND master_sku_id = ${skuId}::uuid`.execute(
      trx,
    );
  }

  /** Clears a listing's manual settings and cancels its waiting write; true if it was manual. */
  async #clearListing(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    listingId: string,
    now: Date,
  ): Promise<boolean> {
    const { rows } = await sql<{ was_manual: boolean; pending_write_id: string | null }>`
      SELECT stock_mode = 'manual' AS was_manual, pending_write_id FROM app.listings
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${listingId}::uuid
       FOR UPDATE`.execute(trx);
    const row = rows[0];
    if (row === undefined) return false;
    await sql`
      UPDATE app.listings
         SET stock_mode = 'auto', manual_qty = NULL, manual_sold = 0, manual_set_at = NULL,
             manual_set_by = NULL, last_queued_qty = NULL, pending_write_id = NULL,
             updated_at = ${now}
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${listingId}::uuid`.execute(trx);
    if (row.pending_write_id !== null) await cancelPending(trx, ctx, row.pending_write_id, now);
    return row.was_manual;
  }

  /** INV-10: a manual listing whose allocation reached 0 shows 0 and gets an info notice. */
  async #allocationUsedUp(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    listingId: string,
  ): Promise<void> {
    const { rows } = await sql<{ used_up: boolean; channel_account_id: string }>`
      SELECT stock_mode = 'manual' AND manual_qty - manual_sold <= 0 AS used_up,
             channel_account_id
        FROM app.listings
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${listingId}::uuid`.execute(trx);
    const row = rows[0];
    if (row?.used_up !== true) return;
    await this.#notifier.raise(ctx, {
      type: 'inventory.allocation_used_up',
      record: { kind: 'listing', id: listingId },
      channelAccountId: row.channel_account_id,
    });
  }

  /** The listings of a component (and its bundles) that OmniBridge writes to, with targets. */
  async #targets(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    component: string,
    level: Level,
  ): Promise<Map<string, TargetRow & { target: number }>> {
    const { rows } = await sql<TargetRow>`
      SELECT l.id, l.channel_account_id, l.provider, l.external_sku, l.fulfilment, l.stock_mode,
             l.manual_qty, l.manual_sold, l.last_queued_qty, l.pending_write_id, l.push_seq,
             s.pack_size AS pack, coalesce(l.buffer_override, cs.buffer, 0) AS buffer,
             (a.paused_at IS NOT NULL
              OR (SELECT ms.maintenance FROM app.maintenance_state() ms)) AS paused,
             (a.stock_push_held_since IS NOT NULL) AS held
        FROM app.listings l
        JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
        LEFT JOIN app.channel_stock_settings cs
          ON cs.workspace_id = l.workspace_id AND cs.channel_account_id = l.channel_account_id
        LEFT JOIN app.channel_accounts a
          ON a.workspace_id = l.workspace_id AND a.id = l.channel_account_id
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid
         AND (s.id = ${component}::uuid OR s.bundle_component_id = ${component}::uuid)
         AND l.ended_at IS NULL AND l.fulfilment IS DISTINCT FROM 'fba'
         AND l.provider = ANY (${sql.val(PUSHED)}::text[])
       ORDER BY l.id
       FOR UPDATE OF l`.execute(trx);
    const available = n(level.on_hand) - n(level.reserved);
    return new Map(
      rows.map((r) => {
        const { target } = listingTarget({
          available,
          buffer: n(r.buffer),
          packSize: r.pack === null ? 1 : n(r.pack),
          mode: r.stock_mode,
          ...(r.manual_qty === null
            ? {}
            : { manualQty: n(r.manual_qty), manualSold: n(r.manual_sold) }),
        });
        return [r.id, { ...r, target }] as const;
      }),
    );
  }

  /**
   * INV-4: recompute every affected listing's target under the component's lock (the caller
   * holds it) and queue one write where the target differs from the last quantity queued, or for
   * each listing in `force`. A newer write cancels the older one still waiting.
   */
  async #recompute(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    component: string,
    movementId: string | undefined,
    now: Date,
    force?: ReadonlySet<string>,
  ): Promise<AllocationPush[]> {
    const level = await this.#lock(trx, ctx, component, now);
    const targets = await this.#targets(trx, ctx, component, level);
    const pushes: AllocationPush[] = [];
    for (const t of targets.values()) {
      const forced = force?.has(t.id) === true;
      if (!forced && t.last_queued_qty !== null && n(t.last_queued_qty) === t.target) {
        // A forced run reports only the listings it was asked about.
        if (force === undefined) pushes.push({ listingId: t.id, result: 'unchanged' });
        continue;
      }
      // FA-16: a newly connected account gets no write until a reconciliation finds no drift.
      if (t.held === true) {
        pushes.push({ listingId: t.id, result: 'held' });
        continue;
      }
      if (t.pending_write_id !== null) await cancelPending(trx, ctx, t.pending_write_id, now);
      const seq = n(t.push_seq) + 1;
      const write = await this.#pushes.enqueue(ctx, {
        channelAccountId: t.channel_account_id,
        provider: t.provider,
        operation: `${t.provider}.stock_push`,
        urgent: false,
        idempotencyKey: `stock:${t.id}:${String(seq)}`,
        payload: { levels: [{ sku: t.external_sku, quantity: t.target }] },
      });
      await sql`
        INSERT INTO app.listing_writes (workspace_id, outbound_write_id, listing_id, quantity,
                                        created_at)
        VALUES (${ctx.workspaceId}::uuid, ${write.id}::uuid, ${t.id}::uuid, ${t.target}, ${now})
        ON CONFLICT DO NOTHING`.execute(trx);
      if (movementId !== undefined) {
        await sql`
          INSERT INTO app.movement_pushes (workspace_id, movement_id, outbound_write_id)
          VALUES (${ctx.workspaceId}::uuid, ${movementId}::uuid, ${write.id}::uuid)
          ON CONFLICT DO NOTHING`.execute(trx);
      }
      await sql`
        UPDATE app.listings
           SET last_queued_qty = ${t.target}, pending_write_id = ${write.id}::uuid,
               push_seq = ${seq}, updated_at = ${now}
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${t.id}::uuid`.execute(trx);
      pushes.push({ listingId: t.id, result: t.paused === true ? 'held' : 'queued' });
    }
    return pushes;
  }

  /** Recomputes every component with a listing matching `where` (a buffer change). */
  async #recomputeWhere(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    where: ReturnType<typeof sql>,
    now: Date,
  ): Promise<void> {
    const { rows } = await sql<{ component: string }>`
      SELECT DISTINCT coalesce(s.bundle_component_id, s.id) AS component
        FROM app.listings l
        JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND ${where}
       ORDER BY component`.execute(trx);
    for (const r of rows) await this.#recompute(trx, ctx, r.component, undefined, now);
  }

  async #listingViews(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    skuId: string,
    componentAvailable: number,
  ): Promise<StockListingView[]> {
    const { rows } = await sql<{
      id: string;
      channel_account_id: string;
      provider: ChannelProvider;
      external_sku: string;
      external_id: string;
      account_name: string | null;
      title: string | null;
      fulfilment: 'mfn' | 'fba' | null;
      buffer_override: string | null;
      account_buffer: string | null;
      pack: string | null;
      stock_mode: StockMode;
      manual_qty: string | null;
      manual_sold: string;
      manual_set_at: Date | null;
      manual_set_by: string | null;
      last_sent_qty: string | null;
      channel_qty: string | null;
      sync_failed_at: Date | null;
      push_at: Date | null;
      push_state: string | null;
      push_paused: string | null;
      push_refused: number | null;
    }>`
      SELECT l.id, l.channel_account_id, acc.display_name AS account_name, l.provider, l.external_sku, l.external_id, l.title,
             l.fulfilment, l.buffer_override, cs.buffer AS account_buffer, s.pack_size AS pack,
             l.stock_mode, l.manual_qty, l.manual_sold, l.manual_set_at, l.manual_set_by,
             l.last_sent_qty, l.channel_qty, l.sync_failed_at,
             p.created_at AS push_at, p.state AS push_state, p.paused_reason AS push_paused,
             p.refused AS push_refused
        FROM app.listings l
        JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
        LEFT JOIN app.channel_stock_settings cs
          ON cs.workspace_id = l.workspace_id AND cs.channel_account_id = l.channel_account_id
        LEFT JOIN app.channel_accounts acc
          ON acc.workspace_id = l.workspace_id AND acc.id = l.channel_account_id
        LEFT JOIN LATERAL (
          SELECT lw.created_at, w.state, w.paused_reason,
                 coalesce(jsonb_array_length(w.result -> 'refused'), 0) AS refused
            FROM app.listing_writes lw
            JOIN app.outbound_writes w
              ON w.workspace_id = lw.workspace_id AND w.id = lw.outbound_write_id
           WHERE lw.workspace_id = l.workspace_id AND lw.listing_id = l.id
             AND w.state <> 'cancelled'
           ORDER BY lw.created_at DESC LIMIT 1) p ON TRUE
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.master_sku_id = ${skuId}::uuid
         AND l.ended_at IS NULL
       ORDER BY l.provider, l.channel_account_id, l.external_sku`.execute(trx);
    return rows.map((r) => {
      const buffer = n(r.buffer_override ?? r.account_buffer);
      const manual =
        r.stock_mode === 'manual' && r.manual_qty !== null && r.manual_set_at !== null
          ? {
              qty: n(r.manual_qty),
              sold: n(r.manual_sold),
              setAt: r.manual_set_at,
              setBy: r.manual_set_by,
            }
          : null;
      const computed = listingTarget({
        available: componentAvailable,
        buffer,
        packSize: r.pack === null ? 1 : n(r.pack),
        mode: r.stock_mode,
        ...(manual === null ? {} : { manualQty: manual.qty, manualSold: manual.sold }),
      });
      const fba = r.fulfilment === 'fba';
      return {
        id: r.id,
        channelAccountId: r.channel_account_id,
        channelAccountName: r.account_name,
        provider: r.provider,
        externalSku: r.external_sku,
        externalId: r.external_id,
        title: r.title,
        fulfilment: r.fulfilment,
        buffer,
        bufferOverride: r.buffer_override !== null,
        target: fba ? null : computed.target,
        cappedByStock: !fba && computed.cappedByStock,
        lastSentQty: nOrNull(r.last_sent_qty),
        channelQty: nOrNull(r.channel_qty),
        mode: r.stock_mode,
        manual,
        syncFailed: r.sync_failed_at !== null,
        lastPush: r.push_at === null ? null : { at: r.push_at, result: pushResult(r) },
      };
    });
  }
}

function pushResult(r: {
  push_state: string | null;
  push_paused: string | null;
  push_refused: number | null;
}): PushResult {
  if (r.push_state === 'failed' || (r.push_state === 'sent' && n(r.push_refused) > 0)) {
    return 'failed';
  }
  if (r.push_state === 'sent') return 'sent';
  if (r.push_paused !== null) return 'held';
  return 'pending';
}

/** A newer quantity replaces a write still waiting to be sent (one write per listing). */
async function cancelPending(
  trx: Transaction<MainDb>,
  ctx: TenantContext,
  writeId: string,
  now: Date,
): Promise<void> {
  await sql`
    UPDATE app.outbound_writes SET state = 'cancelled', updated_at = ${now}
     WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${writeId}::uuid
       AND state = 'pending'`.execute(trx);
}

interface StockRowSql {
  sku_id: string;
  sku: string;
  title: string;
  active: boolean;
  bundle_component_id: string | null;
  component_sku: string | null;
  pack_size: string | null;
  on_hand: string | null;
  reserved: string | null;
  component_available: string | null;
  oversold: boolean;
  sync_failed: boolean;
  manual_count: string;
  auto_count: string;
  listing_count: string;
  fba_count: string;
  last_movement_at: Date | null;
}

/** One row per Master SKU with its (or its component's) numbers and listing counts. */
function stockRows(ctx: TenantContext) {
  return sql`
    SELECT s.id AS sku_id, s.sku, s.title, s.active, s.bundle_component_id, c.sku AS component_sku,
           s.pack_size, lv.on_hand, lv.reserved,
           coalesce(lv.on_hand, 0) - coalesce(lv.reserved, 0) AS component_available,
           coalesce(lv.on_hand, 0) - coalesce(lv.reserved, 0) < 0 AS oversold,
           EXISTS (SELECT 1 FROM app.listings x
                    WHERE x.workspace_id = s.workspace_id AND x.master_sku_id = s.id
                      AND x.ended_at IS NULL AND x.sync_failed_at IS NOT NULL) AS sync_failed,
           (SELECT count(*) FROM app.listings x
             WHERE x.workspace_id = s.workspace_id AND x.master_sku_id = s.id
               AND x.ended_at IS NULL AND x.stock_mode = 'manual') AS manual_count,
           (SELECT count(*) FROM app.listings x
             WHERE x.workspace_id = s.workspace_id AND x.master_sku_id = s.id
               AND x.ended_at IS NULL AND x.stock_mode = 'auto'
               AND x.fulfilment IS DISTINCT FROM 'fba') AS auto_count,
           (SELECT count(*) FROM app.listings x
             WHERE x.workspace_id = s.workspace_id AND x.master_sku_id = s.id
               AND x.ended_at IS NULL) AS listing_count,
           (SELECT count(*) FROM app.listings x
             WHERE x.workspace_id = s.workspace_id AND x.master_sku_id = s.id
               AND x.ended_at IS NULL AND x.fulfilment = 'fba') AS fba_count,
           lv.last_movement_at
      FROM app.master_skus s
      LEFT JOIN app.master_skus c
        ON c.workspace_id = s.workspace_id AND c.id = s.bundle_component_id
      LEFT JOIN app.stock_levels lv
        ON lv.workspace_id = s.workspace_id
       AND lv.master_sku_id = coalesce(s.bundle_component_id, s.id)
     WHERE s.workspace_id = ${ctx.workspaceId}::uuid`;
}

function toRow(r: StockRowSql): StockRowView {
  const componentAvailable = n(r.component_available);
  const bundle =
    r.bundle_component_id === null
      ? null
      : {
          componentId: r.bundle_component_id,
          componentSku: r.component_sku ?? '',
          packSize: n(r.pack_size),
        };
  const manual = n(r.manual_count);
  const auto = n(r.auto_count);
  return {
    skuId: r.sku_id,
    sku: r.sku,
    title: r.title,
    active: r.active,
    bundle,
    onHand: bundle === null ? n(r.on_hand) : null,
    reserved: bundle === null ? n(r.reserved) : 0,
    // CAT-3: a bundle shows floor(component available / pack), never below 0.
    available:
      bundle === null
        ? componentAvailable
        : Math.max(0, Math.floor(componentAvailable / bundle.packSize)),
    oversold: r.oversold,
    syncFailed: r.sync_failed,
    syncMode: manual === 0 ? 'auto' : auto === 0 ? 'manual' : 'mixed',
    listingCount: n(r.listing_count),
    fbaCount: n(r.fba_count),
    lastMovementAt: r.last_movement_at,
  };
}

interface MovementSql {
  id: string;
  created_at: Date;
  master_sku_id: string;
  sku: string;
  kind: string;
  on_hand_change: string;
  reserved_change: string;
  on_hand_after: string;
  reason: StockMovement['reason'];
  note: string | null;
  supplier: string | null;
  source_kind: StockMovement['sourceKind'];
  actor_user_id: string | null;
  actor_name: string | null;
  company_visible: boolean;
  order_ref: string | null;
  pending: string;
  sent: string;
  held: string;
  failed: string;
}

function movementSelect(ctx: TenantContext) {
  return sql`
    SELECT m.id, m.created_at, m.master_sku_id, s.sku, m.kind, m.on_hand_change,
           m.reserved_change, m.on_hand_after, m.reason, m.note, m.supplier, m.source_kind,
           m.actor_user_id, u.name AS actor_name,
           (m.order_company_id IS NULL OR m.order_company_id = ANY (
              coalesce(nullif(current_setting('app.company_ids', true), '')::uuid[],
                       '{}'::uuid[]))) AS company_visible,
           o.external_order_id AS order_ref,
           coalesce(p.pending, 0) AS pending, coalesce(p.sent, 0) AS sent,
           coalesce(p.held, 0) AS held, coalesce(p.failed, 0) AS failed
      FROM app.stock_movements m
      JOIN app.master_skus s ON s.workspace_id = m.workspace_id AND s.id = m.master_sku_id
      LEFT JOIN app.users u ON u.id = m.actor_user_id
      -- INV-5 (M10): the order reference. Order rows are company-scoped, so a user who cannot see
      -- the order's company gets null here ("another company", ARCHITECTURE 6.1).
      LEFT JOIN app.order_lines ol
        ON ol.workspace_id = m.workspace_id
       AND ol.id = CASE WHEN m.order_line_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN m.order_line_id::uuid END
      LEFT JOIN app.orders o ON o.workspace_id = ol.workspace_id AND o.id = ol.order_id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE w.state IN ('pending', 'sending')
                                  AND w.paused_reason IS NULL) AS pending,
               count(*) FILTER (WHERE w.state = 'sent'
                                  AND coalesce(jsonb_array_length(w.result -> 'refused'), 0) = 0)
                 AS sent,
               count(*) FILTER (WHERE w.state = 'pending' AND w.paused_reason IS NOT NULL) AS held,
               count(*) FILTER (WHERE w.state = 'failed'
                                   OR (w.state = 'sent'
                                       AND jsonb_array_length(w.result -> 'refused') > 0))
                 AS failed
          FROM app.movement_pushes mp
          JOIN app.outbound_writes w
            ON w.workspace_id = mp.workspace_id AND w.id = mp.outbound_write_id
         WHERE mp.workspace_id = m.workspace_id AND mp.movement_id = m.id) p ON TRUE
     WHERE m.workspace_id = ${ctx.workspaceId}::uuid`;
}

function movementWhere(ctx: TenantContext, f: MovementFilter) {
  const parts = [sql`m.workspace_id = ${ctx.workspaceId}::uuid`];
  if (f.skuId !== undefined) parts.push(sql`m.master_sku_id = ${f.skuId}::uuid`);
  if (f.kind !== undefined) parts.push(sql`m.kind = ${f.kind}`);
  if (f.source === 'order') parts.push(sql`m.source_kind IN ('order_line', 'refund_line')`);
  if (f.source === 'user') parts.push(sql`m.source_kind IN ('user', 'stock_take', 'allocation')`);
  if (f.source === 'system') parts.push(sql`FALSE`);
  if (f.from !== undefined) {
    parts.push(sql`m.created_at >= (${f.from}::date)::timestamp AT TIME ZONE 'Europe/London'`);
  }
  if (f.to !== undefined) {
    parts.push(sql`m.created_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE 'Europe/London')`);
  }
  return sql.join(parts, sql` AND `);
}

function toMovement(r: MovementSql): StockMovement {
  return {
    id: r.id,
    at: r.created_at,
    skuId: r.master_sku_id,
    sku: r.sku,
    kind: r.kind,
    onHandChange: n(r.on_hand_change),
    reservedChange: n(r.reserved_change),
    onHandAfter: n(r.on_hand_after),
    reason: r.reason,
    note: r.note,
    supplier: r.supplier,
    sourceKind: r.source_kind,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    companyVisible: r.company_visible,
    orderRef: r.company_visible ? r.order_ref : null,
    pushes: { pending: n(r.pending), sent: n(r.sent), held: n(r.held), failed: n(r.failed) },
  };
}
