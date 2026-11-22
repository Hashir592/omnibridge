import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { stockRoutes } from '@omnibridge/contract';
import { pageOffset, pageResult, TOTAL_COUNT_CAP } from '@omnibridge/contract';
import {
  ApiError,
  formatLondonDateTime,
  parseCsv,
  toCsv,
  toUtcIso,
  type TenantContext,
} from '@omnibridge/core';
import {
  StockRefused,
  type AllocationChange,
  type AuditLog,
  type CatalogueRepository,
  type StockDetailView,
  type StockEngine,
  type StockListingView,
  type StockMovement,
  type StockRowView,
} from '@omnibridge/db';
import { UTF8_BOM } from './audit-csv.ts';
import type { Handlers } from './contract.ts';

/**
 * The stock engine's routes (T-0901: INV-1 to INV-10, AT-27). Workspace-shared (ARCHITECTURE
 * 6.1). Each request is one transaction: a movement, its pushes and its audit row commit together.
 */
export interface StockOptions {
  engine: StockEngine;
  catalogue: Pick<CatalogueRepository, 'skusByCode'>;
  audit: Pick<AuditLog, 'record'>;
}

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));
const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const MAX_EXPORT_ROWS = 100_000;
const MAX_TAKE_ROWS = 20_000;

const REFUSAL_TEXT: Record<StockRefused['code'], string> = {
  not_found: 'Not found.',
  bundle: 'A bundle has no stock of its own: move its component instead.',
  version_conflict: 'Stock or settings changed while you were editing. Review and save again.',
  fba: 'Fulfilled by Amazon: OmniBridge does not manage this stock.',
  not_this_sku: 'That listing is not one of this SKU’s.',
  manual_qty_required: 'Enter the quantity this listing should show.',
  reason_text_required: 'Say what happened.',
};

function refused(err: unknown): never {
  if (err instanceof StockRefused) {
    if (err.code === 'not_found') throw new ApiError({ status: 404, code: 'not_found' });
    throw new ApiError({
      status: 409,
      code: err.code === 'version_conflict' ? 'version_conflict' : 'conflict',
      detail: REFUSAL_TEXT[err.code],
    });
  }
  throw err;
}

function row(r: StockRowView) {
  return {
    sku_id: r.skuId,
    sku: r.sku,
    title: r.title,
    active: r.active,
    bundle:
      r.bundle === null
        ? null
        : {
            component_id: r.bundle.componentId,
            component_sku: r.bundle.componentSku,
            pack_size: r.bundle.packSize,
          },
    on_hand: r.onHand,
    reserved: r.reserved,
    available: r.available,
    oversold: r.oversold,
    sync_failed: r.syncFailed,
    sync_mode: r.syncMode,
    listing_count: r.listingCount,
    fba_count: r.fbaCount,
    last_movement_at: iso(r.lastMovementAt),
  };
}

function listing(l: StockListingView) {
  return {
    id: l.id,
    channel_account_id: l.channelAccountId,
    channel_account_name: l.channelAccountName,
    provider: l.provider,
    external_sku: l.externalSku,
    external_id: l.externalId,
    title: l.title,
    fulfilment: l.fulfilment,
    buffer: l.buffer,
    buffer_override: l.bufferOverride,
    target: l.target,
    capped_by_stock: l.cappedByStock,
    last_sent_qty: l.lastSentQty,
    channel_qty: l.channelQty,
    mode: l.mode,
    manual:
      l.manual === null
        ? null
        : {
            qty: l.manual.qty,
            sold: l.manual.sold,
            set_at: l.manual.setAt.toISOString(),
            set_by: l.manual.setBy,
          },
    sync_failed: l.syncFailed,
    last_push:
      l.lastPush === null ? null : { at: l.lastPush.at.toISOString(), result: l.lastPush.result },
  };
}

function detail(d: StockDetailView) {
  return {
    ...row(d),
    version: d.version,
    listings: d.listings.map(listing),
    allocation: d.allocation,
    bundles: d.bundles.map((b) => ({
      id: b.id,
      sku: b.sku,
      pack_size: b.packSize,
      available: b.available,
    })),
  };
}

const ORDER_SOURCES = new Set(['order_line', 'refund_line']);

function movement(m: StockMovement) {
  return {
    id: m.id,
    at: m.at.toISOString(),
    sku_id: m.skuId,
    sku: m.sku,
    kind: m.kind as 'reserve',
    on_hand_change: m.onHandChange,
    reserved_change: m.reservedChange,
    on_hand_after: m.onHandAfter,
    reason: m.reason,
    note: m.note,
    supplier: m.supplier,
    // An order's reference arrives with M10's orders; a hidden company's never shows (6.1).
    source: ORDER_SOURCES.has(m.sourceKind)
      ? { type: 'order' as const, ref: null }
      : { type: 'user' as const, user_id: m.actorUserId, name: m.actorName },
    pushes: m.pushes,
  };
}

function sourceLabel(m: StockMovement): string {
  if (!ORDER_SOURCES.has(m.sourceKind)) return m.actorName ?? 'a removed user';
  return m.companyVisible ? 'order' : 'another company';
}

export function stockHandlers(options?: StockOptions): Handlers<typeof stockRoutes> {
  if (options === undefined) {
    return {
      listStock: notFound,
      getStock: notFound,
      listMovements: notFound,
      exportMovements: notFound,
      stockIn: notFound,
      adjustStock: notFound,
      importStockTake: notFound,
      listBuffers: notFound,
      setAccountBuffer: notFound,
      setListingBuffer: notFound,
      saveAllocation: notFound,
      backToAuto: notFound,
    };
  }
  const o = options;
  const e = o.engine;

  const getDetail = async (tenant: TenantContext, skuId: string) => {
    const found = await e.getStock(tenant, skuId);
    if (found === undefined) throw new ApiError({ status: 404, code: 'not_found' });
    return found;
  };
  const auditAllocation = async (
    tenant: TenantContext,
    userId: string,
    ip: string,
    changes: readonly AllocationChange[],
  ) => {
    for (const c of changes) {
      await o.audit.record(tenant, {
        action: 'stock.allocation_changed',
        actor: { kind: 'user', userId },
        entityId: c.listingId,
        after: { mode: c.mode, manual_qty: c.manualQty },
        ip,
      });
    }
  };
  const filterOf = (q: {
    sku_id?: string | undefined;
    kind?: string | undefined;
    source?: 'order' | 'user' | 'system' | undefined;
    from?: string | undefined;
    to?: string | undefined;
  }) => ({
    ...(q.sku_id === undefined ? {} : { skuId: q.sku_id }),
    ...(q.kind === undefined ? {} : { kind: q.kind }),
    ...(q.source === undefined ? {} : { source: q.source }),
    ...(q.from === undefined ? {} : { from: q.from }),
    ...(q.to === undefined ? {} : { to: q.to }),
  });

  return {
    listStock: async ({ tenant, query }) => {
      const { items, total } = await e.listStock(
        tenant,
        {
          offset: pageOffset(query),
          limit: query.limit,
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.filter === undefined ? {} : { filter: query.filter }),
        },
        TOTAL_COUNT_CAP + 1,
      );
      return {
        status: 200,
        body: await pageResult({
          items: items.map(row),
          page: query.page,
          limit: query.limit,
          countUpTo: () => Promise.resolve(total),
        }),
      };
    },

    getStock: async ({ tenant, params }) => ({
      status: 200,
      body: detail(await getDetail(tenant, params.skuId)),
    }),

    listMovements: async ({ tenant, query }) => {
      if (query.sku_id !== undefined) await getDetail(tenant, query.sku_id);
      const { items, total } = await e.listMovements(
        tenant,
        { ...filterOf(query), offset: pageOffset(query), limit: query.limit },
        TOTAL_COUNT_CAP + 1,
      );
      return {
        status: 200,
        body: await pageResult({
          items: items.map(movement),
          page: query.page,
          limit: query.limit,
          countUpTo: () => Promise.resolve(total),
        }),
      };
    },

    exportMovements: async ({ tenant, query }) => {
      // A SKU of another workspace is not there (404), not an empty file.
      if (query.sku_id !== undefined) await getDetail(tenant, query.sku_id);
      const rows = await e.exportMovements(tenant, filterOf(query), MAX_EXPORT_ROWS);
      if (rows === undefined) {
        throw new ApiError({
          status: 400,
          code: 'validation_failed',
          detail: 'Too many movements for one export. Narrow the dates or pick a SKU.',
          errors: [{ location: 'query', path: 'from', message: 'Narrow the date range' }],
        });
      }
      const text =
        UTF8_BOM +
        toCsv(
          [
            'at_utc',
            'at_london',
            'sku',
            'kind',
            'on_hand_change',
            'reserved_change',
            'on_hand_after',
            'reason',
            'note',
            'supplier',
            'source',
            'pushed_sent',
            'pushed_held',
            'pushed_failed',
            'pushed_pending',
          ],
          rows.map((m) => [
            toUtcIso(m.at),
            formatLondonDateTime(m.at),
            m.sku,
            m.kind,
            String(m.onHandChange),
            String(m.reservedChange),
            String(m.onHandAfter),
            m.reason ?? '',
            m.note ?? '',
            m.supplier ?? '',
            sourceLabel(m),
            String(m.pushes.sent),
            String(m.pushes.held),
            String(m.pushes.failed),
            String(m.pushes.pending),
          ]),
        );
      const bytes = Buffer.from(text, 'utf8');
      return {
        status: 200,
        body: {
          stream: Readable.from([bytes]),
          contentType: 'text/csv; charset=utf-8',
          sizeBytes: bytes.length,
        },
      };
    },

    stockIn: async ({ tenant, session, params, body: input, request }) => {
      let moved;
      try {
        moved = await e.stockIn(tenant, params.skuId, {
          quantity: input.quantity,
          ...(input.supplier === undefined ? {} : { supplier: input.supplier }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          clientRef: input.client_ref,
          userId: session.userId,
        });
      } catch (err) {
        refused(err);
      }
      await o.audit.record(tenant, {
        action: 'stock.stocked_in',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.skuId,
        after: { quantity: input.quantity, on_hand_after: moved.onHandAfter },
        ip: request.ip,
      });
      return { status: 201, body: movement(moved) };
    },

    adjustStock: async ({ tenant, session, params, body: input, request }) => {
      let moved;
      try {
        moved = await e.adjust(tenant, params.skuId, {
          delta: input.delta,
          reason: input.reason,
          ...(input.text === undefined ? {} : { text: input.text }),
          clientRef: input.client_ref,
          userId: session.userId,
        });
      } catch (err) {
        refused(err);
      }
      await o.audit.record(tenant, {
        action: 'stock.adjusted',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.skuId,
        after: { delta: input.delta, on_hand_after: moved.onHandAfter, reason_code: input.reason },
        reason: input.text ?? input.reason,
        ip: request.ip,
      });
      return { status: 201, body: movement(moved) };
    },

    importStockTake: async ({ tenant, session, body: input, request }) => {
      const errors: { line: number; code: string; column: string | null }[] = [];
      const report = (rows: number, applied: boolean) => ({
        status: 200 as const,
        body: {
          rows,
          valid: Math.max(
            0,
            rows - new Set(errors.filter((x) => x.line > 1).map((x) => x.line)).size,
          ),
          applied,
          errors,
        },
      });
      let parsed;
      try {
        parsed = parseCsv(input.csv);
      } catch {
        errors.push({ line: 1, code: 'csv_invalid', column: null });
        return report(0, false);
      }
      const skuAt = parsed.header.indexOf('sku');
      const qtyAt = parsed.header.indexOf('on_hand');
      if (skuAt < 0 || qtyAt < 0) {
        errors.push({ line: 1, code: 'column_missing', column: skuAt < 0 ? 'sku' : 'on_hand' });
        return report(0, false);
      }
      if (parsed.rows.length > MAX_TAKE_ROWS) {
        errors.push({ line: 1, code: 'too_many_rows', column: null });
        return report(0, false);
      }
      const cells = parsed.rows.map((r) => ({
        line: r.line,
        sku: (r.cells[skuAt] ?? '').trim(),
        qty: (r.cells[qtyAt] ?? '').trim(),
      }));
      const skus = await o.catalogue.skusByCode(
        tenant,
        cells.map((c) => c.sku),
      );
      const seen = new Set<string>();
      const valid: { skuId: string; onHand: number }[] = [];
      for (const c of cells) {
        const sku = skus.get(c.sku);
        const before = errors.length;
        if (sku === undefined) errors.push({ line: c.line, code: 'sku_unknown', column: 'sku' });
        else if (sku.bundle) errors.push({ line: c.line, code: 'bundle_stock', column: 'sku' });
        if (!/^\d{1,8}$/.test(c.qty)) {
          errors.push({ line: c.line, code: 'quantity_invalid', column: 'on_hand' });
        }
        if (seen.has(c.sku)) errors.push({ line: c.line, code: 'duplicate', column: null });
        seen.add(c.sku);
        if (errors.length === before && sku !== undefined) {
          valid.push({ skuId: sku.id, onHand: Number(c.qty) });
        }
      }
      const apply = !input.dry_run && errors.length === 0 && valid.length > 0;
      if (apply) {
        const changed = await e.stockTake(tenant, randomUUID(), valid, session.userId);
        await o.audit.record(tenant, {
          action: 'stock.stock_take_imported',
          actor: { kind: 'user', userId: session.userId },
          after: { row_count: changed },
          ip: request.ip,
        });
      }
      return report(cells.length, apply);
    },

    listBuffers: async ({ tenant }) => ({
      status: 200,
      body: {
        items: (await e.buffers(tenant)).map((b) => ({
          channel_account_id: b.channelAccountId,
          provider: b.provider,
          display_name: b.displayName,
          buffer: b.buffer,
        })),
      },
    }),

    setAccountBuffer: async ({ tenant, session, params, body: input, request }) => {
      // Only an account this user can see (RLS: permitted companies).
      const visible = (await e.buffers(tenant)).find(
        (b) => b.channelAccountId === params.accountId,
      );
      if (visible === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      await e.setAccountBuffer(tenant, params.accountId, input.buffer);
      await o.audit.record(tenant, {
        action: 'stock.buffer_changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.accountId,
        before: { channel_account_id: params.accountId, buffer: visible.buffer },
        after: { channel_account_id: params.accountId, buffer: input.buffer },
        ip: request.ip,
      });
      return {
        status: 200,
        body: {
          channel_account_id: visible.channelAccountId,
          provider: visible.provider,
          display_name: visible.displayName,
          buffer: input.buffer,
        },
      };
    },

    setListingBuffer: async ({ tenant, session, params, body: input, request }) => {
      if ((await e.listingView(tenant, params.listingId)) === undefined) {
        throw new ApiError({ status: 404, code: 'not_found' });
      }
      try {
        await e.setListingBuffer(tenant, params.listingId, input.buffer);
      } catch (err) {
        refused(err);
      }
      await o.audit.record(tenant, {
        action: 'stock.buffer_changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.listingId,
        after: { listing_id: params.listingId, buffer: input.buffer },
        ip: request.ip,
      });
      const view = await e.listingView(tenant, params.listingId);
      if (view === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      return { status: 200, body: listing(view) };
    },

    saveAllocation: async ({ tenant, session, params, body: input, request }) => {
      let result;
      try {
        result = await e.saveAllocation(tenant, params.skuId, {
          version: input.version,
          listings: input.listings.map((l) => ({
            listingId: l.listing_id,
            mode: l.mode,
            ...(l.manual_qty === undefined ? {} : { manualQty: l.manual_qty }),
          })),
          userId: session.userId,
        });
      } catch (err) {
        refused(err);
      }
      await auditAllocation(tenant, session.userId, request.ip, result.changes);
      return {
        status: 200,
        body: {
          stock: detail(await getDetail(tenant, params.skuId)),
          pushes: result.pushes.map((p) => ({ listing_id: p.listingId, result: p.result })),
        },
      };
    },

    backToAuto: async ({ tenant, session, params, body: input, request }) => {
      let result;
      try {
        result = await e.backToAuto(tenant, params.skuId, {
          ...(input.listing_ids === undefined ? {} : { listingIds: input.listing_ids }),
          includeBundles: input.include_bundles ?? false,
          userId: session.userId,
        });
      } catch (err) {
        refused(err);
      }
      await auditAllocation(tenant, session.userId, request.ip, result.changes);
      return {
        status: 200,
        body: {
          stock: detail(await getDetail(tenant, params.skuId)),
          pushes: result.pushes.map((p) => ({ listing_id: p.listingId, result: p.result })),
        },
      };
    },
  };
}
