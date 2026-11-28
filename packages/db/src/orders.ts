import { createHash, randomUUID } from 'node:crypto';
import {
  computeOrderVat,
  computeRefundVat,
  londonDate,
  nextOrderStatus,
  pence,
  type OrderStatus,
  type OrderVat,
  type Pence,
  type RefundVat,
  type SaleVatType,
  type TenantContext,
} from '@omnibridge/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { CatalogueRepository } from './catalogue.ts';
import type { AmountsDiffer } from './order-reads.ts';
import type { MainDb } from './schema.ts';
import type { StockEngine, UnmappedDemand } from './stock.ts';
import { withBoundTenant, withTenantTransaction } from './tenant.ts';

/*
 * Order ingest (T-1001: ORD-3, ORD-4, VAT-1 to VAT-7, FA-10, FA-11, FA-12, FA-16). Runs inside
 * the sync job's one transaction, after the vault-first step: an order arrives here with its
 * pii_ref (or the reason it has none) and never with buyer details (invariant 7). Every write is
 * keyed, so a replayed page, the 5-minute overlap or an out-of-order update never duplicates an
 * order, a line, a status row, a refund, a ledger row or a stock movement.
 */

/** The channel lifecycle the adapter read (FA-10); refunds are worked out from `refunds`. */
export type IncomingState =
  'pending_payment' | 'awaiting_dispatch' | 'dispatched' | 'delivered' | 'cancelled';

/** What the vault-first step did with the buyer details (ORD-4, FA-16, ADR-068). */
export type IncomingPii =
  /** Stored in pii-vault (or found there: one record per order). */
  | { kind: 'stored'; piiRef: string }
  /** None held: no details sent, the order was cancelled, or it is older than the PII window. */
  | { kind: 'none' }
  /** Refused: the buyer was deleted by an eBay account-deletion notice. */
  | { kind: 'refused' }
  /** The order is already stored with its outcome; nothing was sent to the vault. */
  | { kind: 'unchanged' }
  /** The channel corrected the buyer block before dispatch; the one record was updated. */
  | { kind: 'replaced' };

export interface IncomingOrder {
  externalId: string;
  rawStatus: string;
  state: IncomingState;
  updatedAt: Date;
  placedAt: Date;
  paidAt: Date | null;
  shipBy: Date | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  discount: Pence;
  shipping: Pence;
  /** What the buyer paid as the channel states it; null when it states no total. */
  channelTotal: Pence | null;
  shipToCountry: string | null;
  fba: boolean;
  /** The buyer has asked to cancel and the channel has not decided yet (never grouped). */
  cancelRequested: boolean;
  lines: readonly {
    lineId: string;
    sku: string | null;
    quantity: number;
    title: string | null;
    /** VAT-inclusive line total (quantity × unit). */
    linePrice: Pence;
  }[];
  refunds: readonly {
    refundId: string;
    refundedAt: Date;
    amount: Pence;
    lines: readonly { lineId: string; quantity: number; amount: Pence }[] | null;
  }[];
  pii: IncomingPii;
}

/** The jobs ingest queues in its transaction: IDs only (invariant 7a). */
export interface OrderIngestPorts {
  /** DEL-1: the cancelled order's buyer record is deleted (trigger `cancellation`). */
  cancelPii(ctx: TenantContext, input: { orderId: string; piiSubject: string }): Promise<void>;
  /**
   * DEL-1: dispatch or delivery is known, so the live copy's expiry moves (journalled). `real` is
   * set when the first real dispatch date replaces a stand-in: a second move, not a repeat.
   */
  shortenPii(
    ctx: TenantContext,
    input: { orderId: string; reason: 'dispatch' | 'delivery'; real?: boolean },
  ): Promise<void>;
  /**
   * FIN-1: the order's pence differ from the channel's: they do not add up to its total, or it
   * changed them after they were fixed (ADR-081 1). Once per difference, not once per update.
   */
  totalMismatch(
    ctx: TenantContext,
    input: { orderId: string; channelAccountId: string },
  ): Promise<void>;
  /**
   * CAT-6: a mapped listing has order lines that missed its mapping event (stored while it ran).
   * The event is sent again; `key` is the same for the same lines.
   */
  lateMapped(
    ctx: TenantContext,
    input: { listingId: string; masterSkuId: string; key: string },
  ): Promise<void>;
  /**
   * ORD-9 (C3.2): an order entered or left the ones that can group (awaiting dispatch, its buyer's
   * record held, not FBA, no cancellation asked for), or its buyer was corrected: the account's groups are recomputed.
   */
  regroup(ctx: TenantContext, input: { channelAccountId: string }): Promise<void>;
  /**
   * ADR-081 (T-1201): the buyer's record changed after a label was bought: the printed label
   * still has the old address. The order is marked for a check before dispatch; this raises the
   * user's warning (once per order).
   */
  addressChangedAfterLabel?(
    ctx: TenantContext,
    input: { orderId: string; companyId: string },
  ): Promise<void>;
}

/** The vault subject of an order: one buyer record per order, keyed by account and order ID. */
export function piiSubject(channelAccountId: string, externalOrderId: string): string {
  return `${channelAccountId}:${externalOrderId}`;
}

/**
 * FA-11 / VQ-3: the date a VAT row counts on. A correction to a filed period goes to the next
 * open period; no period can be filed until the VAT quarters module, so today it is the tax point.
 */
export function vatPeriodDate(taxPoint: string): string {
  return taxPoint;
}

/**
 * DEL-1: when a shipped order left, as far as the channel says: its dispatch time, else delivery.
 * With neither, an order seen waiting before (`storedUnshipped`) left with the update that shows it
 * shipped. One first seen shipped may have been edited long after it left, so its stand-in is the
 * earlier of ship-by and that update, or its placement when there is no ship-by. Null until it has
 * shipped. The vault-first step and db-main both use this, so a record's expiry and the stored date
 * always agree.
 */
export function effectiveDispatch(
  o: Pick<
    IncomingOrder,
    'state' | 'placedAt' | 'shipBy' | 'dispatchedAt' | 'deliveredAt' | 'updatedAt'
  >,
  storedUnshipped: boolean,
): Date | null {
  if (o.dispatchedAt !== null) return o.dispatchedAt;
  if (o.state !== 'dispatched' && o.state !== 'delivered') return null;
  if (o.deliveredAt !== null) return o.deliveredAt;
  if (storedUnshipped) return o.updatedAt;
  if (o.shipBy === null) return o.placedAt;
  return o.shipBy < o.updatedAt ? o.shipBy : o.updatedAt;
}

/** What the vault-first step needs to know of an order db-main already holds. */
export interface StoredOrderPii {
  /** It has its outcome (a record, a deletion, a refusal or a cancellation). */
  settled: boolean;
  piiRef: string | null;
  /** The record is still there, as far as db-main knows. */
  live: boolean;
  status: OrderStatus;
  paidAt: Date | null;
  dispatchedAt: Date | null;
  /** `dispatchedAt` is a stand-in (PS-036 a). */
  dispatchEstimated: boolean;
  deliveredAt: Date | null;
}

/** A fixed-length name for a set of order lines, for a ledger key (the column holds 300). */
const linesDigest = (ids: readonly string[]): string =>
  createHash('sha256')
    .update([...ids].sort().join(','))
    .digest('hex');

/** The ORD-3 status an update asks for: refunds turn a dispatched order (partly) refunded. */
export function incomingStatus(state: IncomingState, refunded: bigint, gross: bigint): OrderStatus {
  if ((state === 'dispatched' || state === 'delivered') && refunded > 0n) {
    return refunded >= gross ? 'refunded' : 'partly_refunded';
  }
  return state;
}

const SHIPPED: readonly OrderStatus[] = [
  'dispatched',
  'delivered',
  'partly_refunded',
  'refunded',
  'returned',
];

interface OrderRow {
  id: string;
  company_id: string;
  status: OrderStatus;
  raw_status: string;
  pii_subject: string;
  pii_ref: string | null;
  pii_deleted_at: Date | null;
  paid_at: Date | null;
  ship_by: Date | null;
  dispatched_at: Date | null;
  dispatch_estimated: boolean;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  source_updated_at: Date;
  tax_point_date: string;
  discount_pence: string;
  shipping_pence: string;
  gross_pence: string;
  vat_recorded_at: Date | null;
  stock_moves: boolean;
  amounts_differ: AmountsDiffer[];
  fba: boolean;
  cancel_requested: boolean;
}

/** The lifecycle state a stored status stands for, so an update built from it moves nothing. */
function storedState(row: Pick<OrderRow, 'status' | 'delivered_at'>): IncomingState {
  switch (row.status) {
    case 'pending_payment':
    case 'cancelled':
    case 'delivered':
      return row.status;
    case 'awaiting_dispatch':
    case 'label_created':
      return 'awaiting_dispatch';
    default:
      return row.delivered_at === null ? 'dispatched' : 'delivered';
  }
}

/** ORD-9 (C3.1): the orders a recompute considers (OrderReads.groupCandidates). */
const canGroup = (
  o: Pick<OrderRow, 'status' | 'fba' | 'cancel_requested' | 'pii_ref' | 'pii_deleted_at'>,
): boolean =>
  o.status === 'awaiting_dispatch' &&
  !o.fba &&
  !o.cancel_requested &&
  o.pii_ref !== null &&
  o.pii_deleted_at === null;

interface LineRow {
  id: string;
  line_no: string;
  external_line_id: string;
  external_sku: string | null;
  listing_id: string | null;
  quantity: string;
  line_gross_pence: string;
  vat_type: SaleVatType | null;
  vat_rate_bp: string | null;
  provisional_rate_bp: string;
  stored_unmapped: boolean;
}

interface Snapshot {
  masterSkuId: string;
  vatType: SaleVatType;
  rateBp: number;
  cogs: Pence | null;
}

const big = (v: string | number | bigint | null | undefined): bigint => BigInt(v ?? 0);
const ORDER_COLUMNS = sql`id, company_id, status, raw_status, pii_subject, pii_ref, pii_deleted_at,
  paid_at, ship_by, dispatched_at, dispatch_estimated, delivered_at, cancelled_at, source_updated_at,
  to_char(tax_point_date, 'YYYY-MM-DD') AS tax_point_date, discount_pence, shipping_pence,
  gross_pence, vat_recorded_at, stock_moves, amounts_differ, fba,
  cancel_requested`;

/** VAT-3 needs discount <= goods; a channel discount beyond the goods comes off the shipping. */
function amountsOf(o: Pick<IncomingOrder, 'lines' | 'discount' | 'shipping'>) {
  const goods = o.lines.reduce((a, l) => a + l.linePrice, 0n);
  const excess = o.discount > goods ? o.discount - goods : 0n;
  return {
    goods,
    discount: pence(o.discount - excess),
    shipping: pence(o.shipping > excess ? o.shipping - excess : 0n),
  };
}

/** The marks an order should carry, in a fixed order, so equal sets compare equal. */
function marksOf(set: ReadonlySet<AmountsDiffer>): AmountsDiffer[] {
  const all: AmountsDiffer[] = ['channel_total', 'late_change', 'refund_above'];
  return all.filter((m) => set.has(m));
}

type IncomingLine = IncomingOrder['lines'][number];

interface ResolvedLine {
  line: IncomingLine;
  listing: { id: string; master_sku_id: string | null; fulfilment: string | null } | undefined;
  snap: Snapshot | undefined;
}

interface Account {
  id: string;
  company_id: string;
  provider: string;
  created_at: Date;
}

/** The VAT of stored lines, recomputed exactly as at ingest (VAT-3 is deterministic). */
function vatOf(
  lines: readonly LineRow[],
  order: Pick<OrderRow, 'discount_pence' | 'shipping_pence'>,
): OrderVat {
  return computeOrderVat({
    lines: lines.map((l) => ({
      lineGross: pence(big(l.line_gross_pence)),
      rateBp: Number(l.vat_rate_bp ?? l.provisional_rate_bp),
      vatType: l.vat_type,
    })),
    discount: pence(big(order.discount_pence)),
    shipping: pence(big(order.shipping_pence)),
  });
}

export class OrderIngest implements UnmappedDemand {
  readonly #db: Kysely<MainDb>;
  readonly #catalogue: Pick<CatalogueRepository, 'cogsOn' | 'vatTypeOn' | 'vatRateOn'>;
  readonly #stock: Pick<StockEngine, 'reserve' | 'release' | 'dispatch' | 'lockFor'> | undefined;
  readonly #ports: OrderIngestPorts;
  readonly #now: () => Date;

  constructor(
    db: Kysely<MainDb>,
    deps: {
      catalogue: Pick<CatalogueRepository, 'cogsOn' | 'vatTypeOn' | 'vatRateOn'>;
      /** Left out (web's read side), ingest is not available. */
      stock?: Pick<StockEngine, 'reserve' | 'release' | 'dispatch' | 'lockFor'>;
      ports: OrderIngestPorts;
      now?: () => Date;
    },
  ) {
    this.#db = db;
    this.#catalogue = deps.catalogue;
    this.#stock = deps.stock;
    this.#ports = deps.ports;
    this.#now = deps.now ?? (() => new Date());
  }

  /**
   * For the vault-first step, before any transaction holds a lock: what db-main already knows of
   * these orders, so the vault is asked only what it must be. An order stored without details (a
   * pending order with no address yet) is not settled: its buyer is stored once the channel sends
   * one. The dates it already has stand: a later update never restarts its window.
   */
  async piiState(
    ctx: TenantContext,
    channelAccountId: string,
    externalIds: readonly string[],
  ): Promise<{
    orders: ReadonlyMap<string, StoredOrderPii>;
    provider: 'amazon' | 'ebay' | 'website' | undefined;
    retentionDays: number;
  }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{
        external_order_id: string;
        settled: boolean;
        pii_ref: string | null;
        live: boolean;
        status: OrderStatus;
        paid_at: Date | null;
        dispatched_at: Date | null;
        dispatch_estimated: boolean;
        delivered_at: Date | null;
      }>`
        SELECT o.external_order_id, o.status, o.paid_at, o.dispatched_at, o.dispatch_estimated,
               o.delivered_at, o.pii_ref,
               (o.pii_ref IS NOT NULL OR o.pii_deleted_at IS NOT NULL OR o.status = 'cancelled')
                 AS settled,
               (o.pii_ref IS NOT NULL AND o.pii_deleted_at IS NULL AND t.pii_ref IS NULL) AS live
          FROM app.orders o
          LEFT JOIN app.pii_tombstones t
            ON t.workspace_id = o.workspace_id AND t.pii_ref = o.pii_ref
         WHERE o.workspace_id = ${ctx.workspaceId}::uuid
           AND o.channel_account_id = ${channelAccountId}::uuid
           AND o.external_order_id = ANY (${sql.val(externalIds)}::text[])`.execute(trx);
      const { rows: ws } = await sql<{ days: string }>`
        SELECT pii_retention_days AS days FROM app.workspaces
         WHERE id = ${ctx.workspaceId}::uuid`.execute(trx);
      const { rows: account } = await sql<{ provider: 'amazon' | 'ebay' | 'website' }>`
        SELECT provider FROM app.channel_accounts
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${channelAccountId}::uuid`.execute(
        trx,
      );
      return {
        orders: new Map(
          rows.map((r) => [
            r.external_order_id,
            {
              settled: r.settled,
              piiRef: r.pii_ref,
              live: r.live,
              status: r.status,
              paidAt: r.paid_at,
              dispatchedAt: r.dispatched_at,
              dispatchEstimated: r.dispatch_estimated,
              deliveredAt: r.delivered_at,
            },
          ]),
        ),
        provider: account[0]?.provider,
        retentionDays: Number(ws[0]?.days ?? 25),
      };
    });
  }

  /**
   * Stores some orders of one sync page, in the caller's (short) transaction. Lock order, the same
   * for every page and for a mapping event (F-M10-end-10): the orders already stored, in id order;
   * then the stock rows that will move, in component id order; then everything else.
   */
  async apply(
    ctx: TenantContext,
    channelAccountId: string,
    orders: readonly IncomingOrder[],
  ): Promise<void> {
    if (orders.length === 0) return;
    await withBoundTenant(this.#db, ctx, async (trx, ctx) => {
      const { rows: accounts } = await sql<{
        company_id: string;
        provider: string;
        created_at: Date;
      }>`
        SELECT company_id, provider, created_at FROM app.channel_accounts
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${channelAccountId}::uuid`.execute(
        trx,
      );
      const account = accounts[0];
      if (account === undefined) throw new Error('channel account not found');
      const { rows: ws } = await sql<{ rate: string }>`
        SELECT default_vat_rate_bp AS rate FROM app.workspaces
         WHERE id = ${ctx.workspaceId}::uuid`.execute(trx);
      const defaultRate = Number(ws[0]?.rate ?? 2000);
      const { rows: known } = await sql<OrderRow & { external_order_id: string }>`
        SELECT external_order_id, ${ORDER_COLUMNS} FROM app.orders
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND channel_account_id = ${channelAccountId}::uuid
           AND external_order_id = ANY (${sql.val(orders.map((o) => o.externalId))}::text[])
         ORDER BY id
         FOR UPDATE`.execute(trx);
      const stored = new Map<string, OrderRow>(known.map((r) => [r.external_order_id, r]));
      const here = { id: channelAccountId, ...account };
      await this.#lockStock(trx, ctx, here, orders, stored);
      let regroup = false;
      for (const order of orders) {
        const existing = stored.get(order.externalId);
        let id = existing?.id;
        if (existing === undefined) {
          id = await this.#create(trx, ctx, here, defaultRate, order);
        } else {
          await this.#update(trx, ctx, channelAccountId, defaultRate, existing, order);
          if (order.pii.kind === 'replaced') await this.#labelAddressChanged(trx, ctx, existing);
        }
        const row = await this.#lock(trx, ctx, id ?? '');
        stored.set(order.externalId, row);
        const before = existing !== undefined && canGroup(existing);
        const after = canGroup(row);
        regroup ||= before !== after || (after && order.pii.kind === 'replaced');
      }
      await this.reportLateMapped(ctx, channelAccountId);
      if (regroup) await this.#ports.regroup(ctx, { channelAccountId });
      // TEN-3: the account's company is fixed once it has orders.
      await sql`UPDATE app.channel_accounts SET orders_seen_at = ${this.#now()}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${channelAccountId}::uuid
                   AND orders_seen_at IS NULL`.execute(trx);
    });
  }

  async #snapshot(
    ctx: TenantContext,
    masterSkuId: string,
    day: string,
  ): Promise<Snapshot | undefined> {
    const vatType = await this.#catalogue.vatTypeOn(ctx, masterSkuId, day);
    if (vatType === undefined) return undefined;
    const rateBp = await this.#catalogue.vatRateOn(ctx, vatType, day);
    if (rateBp === undefined) return undefined;
    const cogs = await this.#catalogue.cogsOn(ctx, masterSkuId, day);
    return { masterSkuId, vatType, rateBp, cogs: cogs ?? null };
  }

  /**
   * Locks the stock rows these orders may move, before any of them is stored: of new orders that
   * reserve or dispatch, and of stored ones that ship, are cancelled or still take new lines. An
   * order that moves nothing (history, a repeat) makes nobody wait.
   */
  async #lockStock(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    account: Account,
    orders: readonly IncomingOrder[],
    stored: ReadonlyMap<string, OrderRow>,
  ): Promise<void> {
    if (this.#stock === undefined) return;
    const skus = new Set<string>();
    const moving: string[] = [];
    for (const o of orders) {
      const existing = stored.get(o.externalId);
      const ships = o.dispatchedAt !== null || o.state === 'dispatched' || o.state === 'delivered';
      if (existing === undefined) {
        if (o.placedAt < account.created_at || o.state === 'cancelled') continue;
      } else {
        const open =
          existing.vat_recorded_at === null &&
          existing.status !== 'cancelled' &&
          o.updatedAt > existing.source_updated_at;
        const leaves =
          existing.status !== 'cancelled' &&
          ((ships && existing.dispatched_at === null) || o.state === 'cancelled');
        if (!existing.stock_moves || !(open || leaves)) continue;
        moving.push(existing.id);
      }
      for (const l of o.lines) if (l.sku !== null) skus.add(l.sku);
    }
    const { rows } = await sql<{ listing_id: string | null; line_id: string | null }>`
      SELECT l.listing_id, l.id::text AS line_id FROM app.order_lines l
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.removed_at IS NULL
         AND l.order_id = ANY (${sql.val(moving)}::uuid[])
      UNION ALL
      SELECT li.id, NULL FROM app.listings li
       WHERE li.workspace_id = ${ctx.workspaceId}::uuid
         AND li.channel_account_id = ${account.id}::uuid
         AND li.external_sku = ANY (${sql.val([...skus])}::text[])`.execute(trx);
    const given = (v: string | null): v is string => v !== null;
    await this.#stock.lockFor(ctx, {
      listingIds: rows.map((r) => r.listing_id).filter(given),
      orderLineIds: rows.map((r) => r.line_id).filter(given),
    });
  }

  /** Each line with its listing, and the snapshot of its SKU on the order's day. */
  async #resolve(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    accountId: string,
    lines: readonly IncomingLine[],
    day: string,
  ): Promise<ResolvedLine[]> {
    const resolved: ResolvedLine[] = [];
    for (const line of lines) {
      const { rows } =
        line.sku === null
          ? { rows: [] }
          : await sql<{ id: string; master_sku_id: string | null; fulfilment: string | null }>`
            SELECT id, master_sku_id, fulfilment FROM app.listings
             WHERE workspace_id = ${ctx.workspaceId}::uuid
               AND channel_account_id = ${accountId}::uuid AND external_sku = ${line.sku}`.execute(
              trx,
            );
      const listing = rows[0];
      const snap =
        listing?.master_sku_id === null || listing === undefined
          ? undefined
          : await this.#snapshot(ctx, listing.master_sku_id, day);
      resolved.push({ line, listing, snap });
    }
    return resolved;
  }

  async #insertLine(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    order: { id: string; companyId: string },
    lineNo: number,
    { line, listing, snap }: ResolvedLine,
    share: OrderVat['lines'][number] | undefined,
    defaultRate: number,
  ): Promise<string> {
    const now = this.#now();
    const lineId = randomUUID();
    await sql`
      INSERT INTO app.order_lines
        (workspace_id, id, company_id, order_id, line_no, external_line_id, listing_id,
         external_sku, title, quantity, unit_gross_pence, line_gross_pence, discount_pence,
         shipping_pence, vat_pence, master_sku_id, vat_type, vat_rate_bp, cogs_pence,
         provisional_rate_bp, snapshot_at, fba, stored_unmapped, created_at)
      VALUES (${ctx.workspaceId}::uuid, ${lineId}::uuid, ${order.companyId}::uuid, ${order.id}::uuid,
              ${lineNo}, ${line.lineId}, ${listing?.id ?? null}::uuid, ${line.sku},
              ${line.title}, ${line.quantity}, ${line.linePrice / BigInt(line.quantity)},
              ${line.linePrice}, ${share?.discount ?? 0n}, ${share?.shipping ?? 0n},
              ${share?.vat ?? 0n}, ${snap?.masterSkuId ?? null}::uuid, ${snap?.vatType ?? null},
              ${snap?.rateBp ?? null}, ${snap?.cogs ?? null}, ${defaultRate},
              ${snap === undefined ? null : now}, ${listing?.fulfilment === 'fba'},
              ${listing?.master_sku_id == null}, ${now})`.execute(trx);
    return lineId;
  }

  async #create(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    account: Account,
    defaultRate: number,
    o: IncomingOrder,
  ): Promise<string> {
    const now = this.#now();
    const id = randomUUID();
    const day = londonDate(o.placedAt);
    const resolved = await this.#resolve(trx, ctx, account.id, o.lines, day);
    const { goods, discount, shipping } = amountsOf(o);
    const vat = computeOrderVat({
      lines: resolved.map((r) => ({
        lineGross: r.line.linePrice,
        rateBp: r.snap?.rateBp ?? defaultRate,
        vatType: r.snap?.vatType ?? null,
      })),
      discount,
      shipping,
    });
    const refunded = o.refunds.reduce((a, r) => a + r.amount, 0n);
    const mismatch = o.channelTotal !== null && o.channelTotal !== vat.gross;
    const status = incomingStatus(o.state, refunded, vat.gross);
    // FA-16: an order placed before the account was connected is history the first stock take
    // already counts; it never moves stock.
    const stockMoves = o.placedAt >= account.created_at;
    const dispatchedAt = effectiveDispatch(o, false);
    const piiRef = o.pii.kind === 'stored' ? o.pii.piiRef : null;
    const piiDeletedAt = o.pii.kind === 'refused' ? now : null;
    const unmapped = resolved.some((r) => r.listing?.master_sku_id == null);
    const fba = o.fba || resolved.some((r) => r.listing?.fulfilment === 'fba');

    await sql`
      INSERT INTO app.orders
        (workspace_id, id, company_id, provider, origin, channel_account_id, external_order_id,
         pii_subject, pii_ref, pii_deleted_at, status, raw_status, placed_at, paid_at, ship_by,
         dispatched_at, dispatch_estimated, delivered_at, cancelled_at, source_updated_at,
         tax_point_date, goods_pence, discount_pence, shipping_pence, gross_pence, vat_pence, ship_to_country,
         unmapped, fba, cancel_requested, stock_moves, amounts_differ, created_at, updated_at)
      VALUES (${ctx.workspaceId}::uuid, ${id}::uuid, ${account.company_id}::uuid, ${account.provider},
              ${account.provider}, ${account.id}::uuid, ${o.externalId},
              ${piiSubject(account.id, o.externalId)}, ${piiRef}::uuid, ${piiDeletedAt}, ${status},
              ${o.rawStatus}, ${o.placedAt}, ${o.paidAt}, ${o.shipBy}, ${dispatchedAt},
              ${dispatchedAt !== null && o.dispatchedAt === null}, ${o.deliveredAt}, ${status === 'cancelled' ? (o.cancelledAt ?? now) : null},
              ${o.updatedAt}, ${day}::date, ${goods}, ${discount}, ${shipping}, ${vat.gross},
              ${vat.vat}, ${o.shipToCountry}, ${unmapped}, ${fba}, ${o.cancelRequested}, ${stockMoves},
              ${sql.val(mismatch ? ['channel_total'] : [])}::text[], ${now}, ${now})`.execute(trx);

    const lineIds: string[] = [];
    const at = { id, companyId: account.company_id };
    for (const [index, r] of resolved.entries()) {
      const share = vat.lines[index];
      lineIds.push(await this.#insertLine(trx, ctx, at, index + 1, r, share, defaultRate));
    }
    await this.#event(trx, ctx, id, account.company_id, status, o);

    // INV-3: stock moves from the order's own lines, each keyed by the line (FA-10 point 2).
    if (stockMoves && this.#stock !== undefined && status !== 'cancelled') {
      const shipped = SHIPPED.includes(status);
      for (const [index, { line, listing }] of resolved.entries()) {
        if (listing === undefined) continue;
        const move = {
          orderLineId: lineIds[index] ?? '',
          listingId: listing.id,
          quantity: line.quantity,
          companyId: account.company_id,
        };
        if (shipped) {
          await this.#stock.dispatch(ctx, move);
          continue;
        }
        const r = await this.#stock.reserve(ctx, move);
        if (r.oversold) await this.markOversold(ctx, move.orderLineId);
      }
    }

    // DEL-1: an order first seen already shipped. Its record may be an older one with the 90-day
    // backstop (a retry after a failed write), so the expiry is moved here too.
    if (piiRef !== null && status !== 'cancelled' && dispatchedAt !== null) {
      await this.#ports.shortenPii(ctx, {
        orderId: id,
        reason: o.deliveredAt === null ? 'dispatch' : 'delivery',
      });
    }
    if (mismatch) {
      await this.#ports.totalMismatch(ctx, { orderId: id, channelAccountId: account.id });
    }

    const order = await this.#lock(trx, ctx, id);
    await this.#settle(trx, ctx, order, o);
    return id;
  }

  /**
   * ADR-081 (1): until sale VAT is recorded (or the order is cancelled) a newer update replaces
   * discount, shipping, gross, VAT shares and line prices. A line's SKU and quantity never change:
   * one the channel changed or dropped is closed and its stock released, and a changed or added one
   * is inserted with its own reservation and the snapshot of the placed date. After that, a
   * different total or line set changes nothing: it marks the order and raises the notice, until a
   * newer update agrees again. The lines of an unpaid order that has shipped stay too: what left
   * cannot be released. An update with no lines says nothing about them: it is read with the
   * stored lines, so only its discount, shipping and total count, paid or not (F-M10-end-25).
   */
  async #amounts(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    accountId: string,
    defaultRate: number,
    existing: OrderRow,
    o: IncomingOrder,
  ): Promise<OrderRow> {
    if (o.updatedAt <= existing.source_updated_at) return existing;
    const now = this.#now();
    const stored = await this.#lines(trx, ctx, existing.id);
    const lines: readonly IncomingLine[] =
      o.lines.length > 0
        ? o.lines
        : stored.map((l) => ({
            lineId: l.external_line_id,
            sku: l.external_sku,
            quantity: Number(l.quantity),
            title: null,
            linePrice: pence(big(l.line_gross_pence)),
          }));
    const kept: { row: LineRow; line: IncomingLine }[] = [];
    const added: IncomingLine[] = [];
    for (const line of lines) {
      const row = stored.find((l) => l.external_line_id === line.lineId);
      const same =
        row !== undefined &&
        row.external_sku === line.sku &&
        Number(row.quantity) === line.quantity;
      if (same) kept.push({ row, line });
      else added.push(line);
    }
    const closed = stored.filter((l) => !kept.some((k) => k.row.id === l.id));
    const sameLines = closed.length === 0 && added.length === 0;
    const repriced = kept.filter((k) => big(k.row.line_gross_pence) !== k.line.linePrice);
    const want = amountsOf({ ...o, lines });
    const sameTotals =
      want.discount === big(existing.discount_pence) &&
      want.shipping === big(existing.shipping_pence);
    const marks = new Set(existing.amounts_differ);
    const open =
      existing.vat_recorded_at === null &&
      existing.status !== 'cancelled' &&
      (sameLines || existing.dispatched_at === null);

    let gross = big(existing.gross_pence);
    if (!open) {
      const otherTotal =
        o.channelTotal !== null && o.channelTotal !== gross && !marks.has('channel_total');
      if (sameLines && repriced.length === 0 && sameTotals && !otherTotal) {
        marks.delete('late_change');
      } else {
        marks.add('late_change');
      }
    } else {
      if (!sameLines || repriced.length > 0 || !sameTotals) {
        for (const l of closed) {
          await sql`UPDATE app.order_lines SET removed_at = ${now}
                     WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${l.id}::uuid`.execute(
            trx,
          );
          if (existing.stock_moves && l.listing_id !== null) {
            await this.#stock?.release(ctx, {
              orderLineId: l.id,
              listingId: l.listing_id,
              quantity: Number(l.quantity),
              companyId: existing.company_id,
            });
          }
        }
        for (const { row, line } of repriced) {
          await sql`UPDATE app.order_lines
                       SET line_gross_pence = ${line.linePrice},
                           unit_gross_pence = ${line.linePrice / BigInt(line.quantity)}
                     WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${row.id}::uuid`.execute(
            trx,
          );
        }
        let lineNo = await this.#lastLineNo(trx, ctx, existing.id);
        const at = { id: existing.id, companyId: existing.company_id };
        for (const r of await this.#resolve(trx, ctx, accountId, added, existing.tax_point_date)) {
          lineNo += 1;
          const id = await this.#insertLine(trx, ctx, at, lineNo, r, undefined, defaultRate);
          if (!existing.stock_moves || this.#stock === undefined) continue;
          if (r.listing === undefined || o.state === 'cancelled') continue;
          const reserved = await this.#stock.reserve(ctx, {
            orderLineId: id,
            listingId: r.listing.id,
            quantity: r.line.quantity,
            companyId: existing.company_id,
          });
          if (reserved.oversold) await this.markOversold(ctx, id);
        }
        const vat = vatOf(await this.#lines(trx, ctx, existing.id), {
          discount_pence: String(want.discount),
          shipping_pence: String(want.shipping),
        });
        gross = vat.gross;
        await sql`
          UPDATE app.orders o
             SET goods_pence = ${want.goods}, discount_pence = ${want.discount},
                 shipping_pence = ${want.shipping}, gross_pence = ${vat.gross},
                 oversold = l.oversold, fba = ${o.fba} OR l.fba
            FROM (SELECT bool_or(x.oversold) AS oversold, bool_or(x.fba) AS fba
                    FROM app.order_lines x
                   WHERE x.workspace_id = ${ctx.workspaceId}::uuid
                     AND x.order_id = ${existing.id}::uuid AND x.removed_at IS NULL) l
           WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.id = ${existing.id}::uuid`.execute(
          trx,
        );
        await this.#reallocate(trx, ctx, existing.id, vat);
      }
      marks.delete('late_change');
      if (o.channelTotal !== null && o.channelTotal !== gross) marks.add('channel_total');
      else marks.delete('channel_total');
    }

    const next = marksOf(marks);
    if (next.some((m) => !existing.amounts_differ.includes(m))) {
      await this.#ports.totalMismatch(ctx, { orderId: existing.id, channelAccountId: accountId });
    }
    if (next.join() !== existing.amounts_differ.join()) {
      await sql`UPDATE app.orders SET amounts_differ = ${sql.val(next)}::text[]
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${existing.id}::uuid`.execute(
        trx,
      );
    }
    return this.#lock(trx, ctx, existing.id);
  }

  async #lastLineNo(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    orderId: string,
  ): Promise<number> {
    const { rows } = await sql<{ n: string | null }>`
      SELECT max(line_no) AS n FROM app.order_lines
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${orderId}::uuid`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }

  async #update(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    accountId: string,
    defaultRate: number,
    stored: OrderRow,
    o: IncomingOrder,
  ): Promise<void> {
    const now = this.#now();
    // The channel's amounts first; then payment is captured on them, and they are fixed.
    const existing = await this.#amounts(trx, ctx, accountId, defaultRate, stored, o);
    const refunded = o.refunds.reduce((a, r) => a + r.amount, 0n);
    const next = nextOrderStatus(
      existing.status,
      incomingStatus(o.state, refunded, big(existing.gross_pence)),
    );
    const stale = o.updatedAt < existing.source_updated_at;
    // PS-036 (a): the first real dispatch date replaces a stand-in, once; a date already real stays.
    const real = existing.dispatch_estimated && o.dispatchedAt !== null;
    const dispatchedAt =
      (real ? o.dispatchedAt : existing.dispatched_at) ??
      o.dispatchedAt ??
      (SHIPPED.includes(next) ? effectiveDispatch(o, true) : null);
    const estimated =
      existing.dispatched_at === null
        ? dispatchedAt !== null && o.dispatchedAt === null
        : existing.dispatch_estimated && !real;
    const deliveredAt = existing.delivered_at ?? o.deliveredAt;
    const cancelledAt =
      next === 'cancelled'
        ? (existing.cancelled_at ?? o.cancelledAt ?? now)
        : existing.cancelled_at;
    const statusChanged = next !== existing.status;
    const rawChanged = !stale && o.rawStatus !== existing.raw_status;
    const piiRef = existing.pii_ref ?? (o.pii.kind === 'stored' ? o.pii.piiRef : null);

    await sql`
      UPDATE app.orders
         SET status = ${next},
             raw_status = ${stale ? existing.raw_status : o.rawStatus},
             source_updated_at = ${stale ? existing.source_updated_at : o.updatedAt},
             paid_at = coalesce(paid_at, ${o.paidAt}),
             ship_by = ${stale ? existing.ship_by : (o.shipBy ?? existing.ship_by)},
             dispatched_at = ${dispatchedAt},
             dispatch_estimated = ${estimated},
             delivered_at = ${deliveredAt},
             cancelled_at = ${cancelledAt},
             cancel_requested = ${stale ? existing.cancel_requested : o.cancelRequested},
             pii_ref = ${piiRef}::uuid,
             pii_deleted_at = coalesce(pii_deleted_at,
                                       ${piiRef === null && o.pii.kind === 'refused' ? now : null}::timestamptz),
             updated_at = ${now}
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${existing.id}::uuid`.execute(trx);
    if (statusChanged || rawChanged) {
      await this.#event(trx, ctx, existing.id, existing.company_id, statusChanged ? next : null, o);
    }

    // INV-3: stock follows the status, from the line's own reservation; repeats move nothing.
    if (existing.stock_moves && this.#stock !== undefined) {
      const cancelledNow = statusChanged && next === 'cancelled';
      const shippedNow =
        existing.dispatched_at === null && dispatchedAt !== null && next !== 'cancelled';
      if (cancelledNow || shippedNow) {
        for (const line of await this.#lines(trx, ctx, existing.id)) {
          if (line.listing_id === null) continue;
          const move = {
            orderLineId: line.id,
            listingId: line.listing_id,
            quantity: Number(line.quantity),
            companyId: existing.company_id,
          };
          if (cancelledNow) await this.#stock.release(ctx, move);
          else await this.#stock.dispatch(ctx, move);
        }
      }
    }

    // SHP-5, EVRI-6: a label bought for an order the channel cancelled goes on the reconcile list,
    // and the order holds no live label any more.
    if (statusChanged && next === 'cancelled') {
      const { rows: ended } = await sql<{ shipment_id: string }>`
        UPDATE app.shipment_orders SET live = false
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${existing.id}::uuid AND live
         RETURNING shipment_id`.execute(trx);
      for (const { shipment_id } of ended) {
        await sql`UPDATE app.parcels SET reconcile_since = coalesce(reconcile_since, ${now}), updated_at = ${now}
                   WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipment_id}::uuid
                     AND state = 'created' AND reconciled_at IS NULL`.execute(trx);
      }
    }

    // DEL-1: cancellation deletes the buyer's record; dispatch and delivery move its expiry.
    if (piiRef !== null && existing.pii_deleted_at === null) {
      if (statusChanged && next === 'cancelled') {
        await this.#ports.cancelPii(ctx, {
          orderId: existing.id,
          piiSubject: existing.pii_subject,
        });
      } else if (next !== 'cancelled') {
        // A record that only now joins a shipped order needs its expiry moved as well.
        const joined = existing.pii_ref === null;
        if (deliveredAt !== null && (joined || existing.delivered_at === null)) {
          await this.#ports.shortenPii(ctx, { orderId: existing.id, reason: 'delivery' });
        } else if (dispatchedAt !== null && (joined || existing.dispatched_at === null)) {
          await this.#ports.shortenPii(ctx, { orderId: existing.id, reason: 'dispatch' });
        } else if (real && deliveredAt === null) {
          await this.#ports.shortenPii(ctx, { orderId: existing.id, reason: 'dispatch', real });
        }
      }
    }

    await this.#settle(trx, ctx, await this.#lock(trx, ctx, existing.id), o);
  }

  /**
   * ADR-081: a corrected buyer record on an order with a live label. The label already printed
   * holds the old address, so the order needs a check before dispatch (T-1202 refuses to
   * dispatch it until a user confirms) and the user is told.
   */
  async #labelAddressChanged(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    order: OrderRow,
  ): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      UPDATE app.orders o SET address_changed_after_label = true, updated_at = ${this.#now()}
       WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.id = ${order.id}::uuid
         AND NOT o.address_changed_after_label
         AND EXISTS (SELECT 1 FROM app.shipment_orders so
                      WHERE so.workspace_id = o.workspace_id AND so.order_id = o.id AND so.live)
       RETURNING o.id`.execute(trx);
    if (rows.length > 0) {
      await this.#ports.addressChangedAfterLabel?.(ctx, {
        orderId: order.id,
        companyId: order.company_id,
      });
    }
  }

  async #event(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    orderId: string,
    companyId: string,
    status: OrderStatus | null,
    o: IncomingOrder,
  ): Promise<void> {
    await sql`
      INSERT INTO app.order_status_events
        (workspace_id, id, company_id, order_id, status, raw_status, source_at, created_at)
      VALUES (${ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${companyId}::uuid, ${orderId}::uuid,
              ${status}, ${o.rawStatus}, ${o.updatedAt}, ${this.#now()})`.execute(trx);
  }

  async #lock(trx: Transaction<MainDb>, ctx: TenantContext, id: string): Promise<OrderRow> {
    const { rows } = await sql<OrderRow>`
      SELECT ${ORDER_COLUMNS} FROM app.orders
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${id}::uuid
       FOR UPDATE`.execute(trx);
    const row = rows[0];
    if (row === undefined) throw new Error('order vanished inside its transaction');
    return row;
  }

  async #lines(trx: Transaction<MainDb>, ctx: TenantContext, orderId: string): Promise<LineRow[]> {
    const { rows } = await sql<LineRow>`
      SELECT id, line_no, external_line_id, external_sku, listing_id, quantity, line_gross_pence,
             vat_type, vat_rate_bp, provisional_rate_bp, stored_unmapped
        FROM app.order_lines
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${orderId}::uuid
         AND removed_at IS NULL
       ORDER BY line_no`.execute(trx);
    return rows;
  }

  /**
   * VAT-1, VAT-5, VAT-6: sale VAT once payment is captured (never for an order cancelled before
   * it), at the tax point; each new refund at the original rates, capped per group, in the
   * refund date's quarter. Every row is keyed, so a repeat writes nothing.
   */
  async #settle(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    order: OrderRow,
    o: IncomingOrder,
  ): Promise<void> {
    if (order.paid_at === null) return;
    const lines = await this.#lines(trx, ctx, order.id);
    const vat = vatOf(lines, order);
    const now = this.#now();
    if (order.vat_recorded_at === null) {
      for (const g of vat.groups) {
        await this.#ledger(trx, ctx, order, {
          entryKey: `sale:${order.id}:${g.key}`,
          kind: 'sale',
          refundId: null,
          groupKey: g.key,
          vatType: g.vatType,
          rateBp: g.rateBp,
          provisional: g.provisional,
          gross: g.gross,
          vat: g.vat,
          taxPoint: order.tax_point_date,
        });
      }
      await sql`UPDATE app.orders SET vat_recorded_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${order.id}::uuid`.execute(
        trx,
      );
    }

    for (const refund of o.refunds) {
      const { rows: seen } = await sql<{ id: string }>`
        SELECT id FROM app.refunds
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${order.id}::uuid
           AND external_refund_id = ${refund.refundId}`.execute(trx);
      if (seen.length > 0) continue;
      const prior = await this.#refundedSoFar(trx, ctx, order.id);
      const byExternal = new Map(lines.map((l, index) => [l.external_line_id, { l, index }]));
      // One entry per order line: a channel may list a line twice (goods, then an extra part).
      const merged = new Map<string, { lineId: string; quantity: number; amount: bigint }>();
      for (const rl of refund.lines ?? []) {
        const had = merged.get(rl.lineId);
        merged.set(rl.lineId, {
          lineId: rl.lineId,
          quantity: (had?.quantity ?? 0) + rl.quantity,
          amount: (had?.amount ?? 0n) + rl.amount,
        });
      }
      const refundLines = [...merged.values()].flatMap((rl) => {
        const hit = byExternal.get(rl.lineId);
        return hit === undefined ? [] : [{ ...rl, amount: pence(rl.amount), line: hit }];
      });
      const rv = computeRefundVat({
        order: vat,
        refunded: prior,
        refund: {
          amount: refund.amount,
          ...(refundLines.length === 0
            ? {}
            : { lines: refundLines.map((rl) => ({ line: rl.line.index, amount: rl.amount })) }),
        },
      });
      const refundId = randomUUID();
      const taxPoint = londonDate(refund.refundedAt);
      await sql`
        INSERT INTO app.refunds
          (workspace_id, id, company_id, order_id, external_refund_id, refunded_at, tax_point_date,
           amount_pence, vat_pence, created_at)
        VALUES (${ctx.workspaceId}::uuid, ${refundId}::uuid, ${order.company_id}::uuid,
                ${order.id}::uuid, ${refund.refundId}, ${refund.refundedAt}, ${taxPoint}::date,
                ${refund.amount}, ${rv.vat}, ${now})`.execute(trx);
      for (const rl of refundLines) {
        await sql`
          INSERT INTO app.refund_lines
            (workspace_id, id, company_id, refund_id, order_line_id, quantity, amount_pence)
          VALUES (${ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${order.company_id}::uuid,
                  ${refundId}::uuid, ${rl.line.l.id}::uuid, ${rl.quantity}, ${rl.amount})
          ON CONFLICT DO NOTHING`.execute(trx);
      }
      for (const g of rv.groups) {
        const charged = vat.groups.find((c) => c.key === g.key);
        await this.#ledger(trx, ctx, order, {
          entryKey: `refund:${refundId}:${g.key}`,
          kind: 'refund',
          refundId,
          groupKey: g.key,
          vatType: g.vatType,
          rateBp: g.rateBp,
          provisional: charged?.provisional ?? false,
          gross: 0n - g.gross,
          vat: 0n - g.vat,
          taxPoint,
        });
      }
      // ADR-081 (2): the refund keeps its whole amount; VAT went back up to what was left.
      await sql`
        UPDATE app.orders SET amounts_differ = array_append(amounts_differ, 'refund_above')
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${order.id}::uuid
           AND NOT 'refund_above' = ANY (amounts_differ)
           AND gross_pence < (SELECT sum(amount_pence) FROM app.refunds
                               WHERE workspace_id = ${ctx.workspaceId}::uuid
                                 AND order_id = ${order.id}::uuid)`.execute(trx);
    }
  }

  /** The refunds already in the ledger, as computeRefundVat takes them (FA-12 rule 3). */
  async #refundedSoFar(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    orderId: string,
  ): Promise<RefundVat[]> {
    const { rows } = await sql<{
      group_key: string;
      vat_type: SaleVatType | null;
      rate_bp: string;
      gross: string;
      vat: string;
    }>`
      SELECT group_key, min(vat_type) AS vat_type, min(rate_bp) AS rate_bp,
             -sum(gross_pence) AS gross, -sum(vat_pence) AS vat
        FROM app.vat_ledger
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${orderId}::uuid
         AND refund_id IS NOT NULL
       GROUP BY group_key`.execute(trx);
    if (rows.length === 0) return [];
    const groups = rows.map((r) => ({
      key: r.group_key,
      vatType: r.vat_type,
      rateBp: Number(r.rate_bp),
      gross: pence(big(r.gross)),
      vat: pence(big(r.vat)),
    }));
    return [
      {
        groups,
        gross: pence(groups.reduce((a, g) => a + g.gross, 0n)),
        vat: pence(groups.reduce((a, g) => a + g.vat, 0n)),
      },
    ];
  }

  async #ledger(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    order: Pick<OrderRow, 'id' | 'company_id'>,
    row: {
      entryKey: string;
      kind: 'sale' | 'refund' | 'adjustment';
      refundId: string | null;
      groupKey: string;
      vatType: SaleVatType | null;
      rateBp: number;
      provisional: boolean;
      gross: bigint;
      vat: bigint;
      taxPoint: string;
    },
  ): Promise<void> {
    const { numAffectedRows } = await sql`
      INSERT INTO app.vat_ledger
        (workspace_id, id, company_id, order_id, refund_id, entry_key, kind, group_key, vat_type,
         rate_bp, provisional, gross_pence, vat_pence, net_pence, tax_point_date, period_date,
         created_at)
      VALUES (${ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${order.company_id}::uuid,
              ${order.id}::uuid, ${row.refundId}::uuid, ${row.entryKey}, ${row.kind}, ${row.groupKey},
              ${row.vatType}, ${row.rateBp}, ${row.provisional}, ${row.gross}, ${row.vat},
              ${row.gross - row.vat}, ${row.taxPoint}::date, ${vatPeriodDate(row.taxPoint)}::date,
              ${this.#now()})
      ON CONFLICT (workspace_id, entry_key) DO NOTHING`.execute(trx);
    if (numAffectedRows !== 0n) return;
    // A repeat writes nothing, but only a true repeat: the ledger is append-only, so a key taken
    // by another row would lose this one for good.
    const { rows } = await sql<{ same: boolean }>`
      SELECT (order_id = ${order.id}::uuid AND group_key = ${row.groupKey}
              AND refund_id IS NOT DISTINCT FROM ${row.refundId}::uuid
              AND gross_pence = ${row.gross} AND vat_pence = ${row.vat}) AS same
        FROM app.vat_ledger
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND entry_key = ${row.entryKey}`.execute(trx);
    if (rows[0]?.same !== true) {
      throw new Error('a VAT ledger key is taken by a different entry');
    }
  }

  /**
   * CAT-6: gives a listing the lines stored before discovery had seen it, matched as ingest matches
   * them: the same channel account and external SKU.
   */
  async #link(trx: Transaction<MainDb>, ctx: TenantContext, listingId: string): Promise<void> {
    const { rows } = await sql<{ order_id: string; fba: boolean }>`
      UPDATE app.order_lines l
         SET listing_id = li.id, fba = (li.fulfilment IS NOT DISTINCT FROM 'fba')
        FROM app.orders o, app.listings li
       WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.listing_id IS NULL
         AND l.vat_type IS NULL AND l.removed_at IS NULL AND l.external_sku = li.external_sku
         AND o.workspace_id = l.workspace_id AND o.id = l.order_id
         AND li.workspace_id = l.workspace_id AND li.id = ${listingId}::uuid
         AND li.channel_account_id = o.channel_account_id
      RETURNING l.order_id, l.fba`.execute(trx);
    const fba = rows.filter((r) => r.fba).map((r) => r.order_id);
    if (fba.length === 0) return;
    await sql`UPDATE app.orders SET fba = true
               WHERE workspace_id = ${ctx.workspaceId}::uuid
                 AND id = ANY (${sql.val(fba)}::uuid[])`.execute(trx);
  }

  /** The OmniBridge IDs of an account's orders, by external order ID (the website push answers it). */
  async orderIds(
    ctx: TenantContext,
    channelAccountId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map();
    const { rows } = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql<{ id: string; external_order_id: string }>`
        SELECT id, external_order_id FROM app.orders
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND channel_account_id = ${channelAccountId}::uuid
           AND external_order_id = ANY (${sql.val(externalIds)}::text[])`.execute(trx),
    );
    return new Map(rows.map((r) => [r.external_order_id, r.id]));
  }

  /**
   * WEB-3: a stored order as an update that changes nothing, for a website call that changes one
   * thing (a cancel, a refund) through `apply`. It carries the stored change time, so the amounts
   * and lines stay as they are (an update with no lines never touches lines, F-M10-end-25), and the
   * refunds already recorded, so a status counts them all. Undefined when the order is not stored.
   */
  async asStored(
    ctx: TenantContext,
    channelAccountId: string,
    externalId: string,
  ): Promise<{ id: string; order: IncomingOrder } | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<OrderRow & { placed_at: Date }>`
        SELECT placed_at, ${ORDER_COLUMNS} FROM app.orders
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND channel_account_id = ${channelAccountId}::uuid
           AND external_order_id = ${externalId}`.execute(trx);
      const row = rows[0];
      if (row === undefined) return undefined;
      const { rows: refunds } = await sql<{ id: string; at: Date; amount: string }>`
        SELECT external_refund_id AS id, refunded_at AS at, amount_pence::text AS amount
          FROM app.refunds
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${row.id}::uuid
         ORDER BY refunded_at, external_refund_id`.execute(trx);
      return {
        id: row.id,
        order: {
          externalId,
          rawStatus: row.raw_status,
          state: storedState(row),
          updatedAt: row.source_updated_at,
          placedAt: row.placed_at,
          paidAt: row.paid_at,
          shipBy: row.ship_by,
          // The stored dates stand; null here never clears one.
          dispatchedAt: null,
          deliveredAt: null,
          cancelledAt: row.cancelled_at,
          discount: pence(big(row.discount_pence)),
          shipping: pence(big(row.shipping_pence)),
          channelTotal: null,
          shipToCountry: null,
          fba: row.fba,
          cancelRequested: row.cancel_requested,
          lines: [],
          refunds: refunds.map((r) => ({
            refundId: r.id,
            refundedAt: r.at,
            amount: pence(big(r.amount)),
            lines: null,
          })),
          pii: { kind: 'unchanged' },
        },
      };
    });
  }

  /**
   * CAT-6: mapped listings of the account that still have provisional lines get their event again:
   * a line stored while the event ran (or while the scan added the listing) was not visible to it.
   * Read only here, so ingest takes no listing lock. Returns how many listings it reported.
   */
  async reportLateMapped(ctx: TenantContext, channelAccountId: string): Promise<number> {
    return withBoundTenant(this.#db, ctx, async (trx, ctx) => {
      const { rows } = await sql<{ listing_id: string; master_sku_id: string; lines: string[] }>`
        SELECT li.id AS listing_id, li.master_sku_id, array_agg(l.id::text) AS lines
          FROM app.order_lines l
          JOIN app.orders o ON o.workspace_id = l.workspace_id AND o.id = l.order_id
          JOIN app.listings li ON li.workspace_id = l.workspace_id
                              AND li.channel_account_id = o.channel_account_id
                              AND li.external_sku = l.external_sku
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.vat_type IS NULL
           AND l.removed_at IS NULL
           AND o.channel_account_id = ${channelAccountId}::uuid AND li.master_sku_id IS NOT NULL
         GROUP BY li.id, li.master_sku_id
         ORDER BY li.id`.execute(trx);
      for (const r of rows) {
        await this.#ports.lateMapped(ctx, {
          listingId: r.listing_id,
          masterSkuId: r.master_sku_id,
          key: linesDigest(r.lines),
        });
      }
      return rows.length;
    });
  }

  /** INV-6: an order line that took available stock below 0, at ingest or on back-fill. */
  async markOversold(ctx: TenantContext, orderLineId: string): Promise<void> {
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`
        WITH line AS (
          UPDATE app.order_lines SET oversold = true
           WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderLineId}::uuid
          RETURNING order_id)
        UPDATE app.orders SET oversold = true
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = (SELECT order_id FROM line)`.execute(
        trx,
      );
    });
  }

  /**
   * CAT-6 (UnmappedDemand): locks the orders still to ship that `openLines` will read, and those
   * whose lines `fillSnapshots` will fill, as ingest locks them: in id order, all at once, before the
   * stock rows. So a dispatch being stored right now is either seen by it or finds the line linked,
   * and the event never asks for an order while it holds a stock row (F-M10-end-10).
   */
  async lockOrders(ctx: TenantContext, listingId: string): Promise<void> {
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`
        SELECT o.id FROM app.orders o
         WHERE o.workspace_id = ${ctx.workspaceId}::uuid
           AND o.id IN (
             SELECT l.order_id FROM app.order_lines l
               JOIN app.orders x ON x.workspace_id = l.workspace_id AND x.id = l.order_id
              WHERE l.workspace_id = ${ctx.workspaceId}::uuid
                AND l.listing_id = ${listingId}::uuid AND l.removed_at IS NULL
                AND (l.vat_type IS NULL
                     OR (l.stored_unmapped AND x.dispatched_at IS NULL AND x.status <> 'cancelled'))
             UNION ALL
             SELECT l.order_id FROM app.order_lines l
               JOIN app.listings li ON li.workspace_id = l.workspace_id
                                   AND li.external_sku = l.external_sku
              WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.vat_type IS NULL
                AND l.listing_id IS NULL AND l.removed_at IS NULL
                AND li.id = ${listingId}::uuid)
           AND o.channel_account_id = (SELECT channel_account_id FROM app.listings
                                        WHERE workspace_id = ${ctx.workspaceId}::uuid
                                          AND id = ${listingId}::uuid)
         ORDER BY o.id
         FOR UPDATE`.execute(trx);
    });
  }

  /**
   * CAT-6 (UnmappedDemand): the lines of a listing stored while it was unmapped (or not discovered
   * yet), on orders that move stock and are not cancelled, earliest order first. The stock engine
   * back-fills their movements on mapping; its keys make a repeat move nothing. Linking a line
   * touches the listing row, so the caller holds the stock rows by now.
   */
  async openLines(ctx: TenantContext, listingId: string) {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      await this.#link(trx, ctx, listingId);
      const { rows } = await sql<{
        id: string;
        quantity: string;
        dispatched: boolean;
        company_id: string;
      }>`
        SELECT l.id, l.quantity, (o.dispatched_at IS NOT NULL) AS dispatched, o.company_id
          FROM app.order_lines l
          JOIN app.orders o ON o.workspace_id = l.workspace_id AND o.id = l.order_id
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.listing_id = ${listingId}::uuid
           AND l.stored_unmapped AND l.removed_at IS NULL
           AND o.stock_moves AND o.status <> 'cancelled'
         ORDER BY o.placed_at, o.id, l.line_no`.execute(trx);
      return rows.map((r) => ({
        orderLineId: r.id,
        quantity: Number(r.quantity),
        dispatched: r.dispatched,
        companyId: r.company_id,
      }));
    });
  }

  /**
   * FA-11: a listing was mapped, so its provisional lines take the snapshot in effect on their
   * order date, once (the trigger refuses a second write). Where sale VAT is already recorded,
   * the difference is written as adjustment rows, dated to the open period (VQ-3).
   */
  async fillSnapshots(ctx: TenantContext, listingId: string): Promise<{ filled: number }> {
    return withBoundTenant(this.#db, ctx, async (trx, ctx) => {
      await this.#link(trx, ctx, listingId);
      const { rows: pending } = await sql<{
        line_id: string;
        order_id: string;
        master_sku_id: string;
        day: string;
      }>`
        SELECT l.id AS line_id, l.order_id, li.master_sku_id,
               to_char(o.tax_point_date, 'YYYY-MM-DD') AS day
          FROM app.order_lines l
          JOIN app.orders o ON o.workspace_id = l.workspace_id AND o.id = l.order_id
          JOIN app.listings li ON li.workspace_id = l.workspace_id AND li.id = l.listing_id
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.listing_id = ${listingId}::uuid
           AND l.vat_type IS NULL AND l.removed_at IS NULL AND li.master_sku_id IS NOT NULL
         ORDER BY l.order_id, l.line_no`.execute(trx);
      let filled = 0;
      const byOrder = new Map<string, typeof pending>();
      for (const p of pending) byOrder.set(p.order_id, [...(byOrder.get(p.order_id) ?? []), p]);
      for (const [orderId, lines] of byOrder) {
        const order = await this.#lock(trx, ctx, orderId);
        const before = vatOf(await this.#lines(trx, ctx, orderId), order);
        const done: string[] = [];
        for (const p of lines) {
          const snap = await this.#snapshot(ctx, p.master_sku_id, p.day);
          if (snap === undefined) continue;
          const { numAffectedRows } = await sql`
            UPDATE app.order_lines
               SET master_sku_id = ${snap.masterSkuId}::uuid, vat_type = ${snap.vatType},
                   vat_rate_bp = ${snap.rateBp}, cogs_pence = ${snap.cogs}, snapshot_at = ${this.#now()}
             WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${p.line_id}::uuid
               AND vat_type IS NULL`.execute(trx);
          if ((numAffectedRows ?? 0n) > 0n) done.push(p.line_id);
        }
        if (done.length === 0) continue;
        filled += done.length;
        const tag = linesDigest(done);
        const after = vatOf(await this.#lines(trx, ctx, orderId), order);
        await this.#reallocate(trx, ctx, orderId, after);
        if (order.vat_recorded_at === null) continue;
        // The difference per group, as adjustment rows: the old provisional group comes off, the
        // new group goes on.
        const keys = new Set([...before.groups, ...after.groups].map((g) => g.key));
        for (const key of keys) {
          const b = before.groups.find((g) => g.key === key);
          const a = after.groups.find((g) => g.key === key);
          const gross = (a?.gross ?? 0n) - (b?.gross ?? 0n);
          const vatDiff = (a?.vat ?? 0n) - (b?.vat ?? 0n);
          if (
            gross === 0n &&
            vatDiff === 0n &&
            (a?.provisional ?? false) === (b?.provisional ?? false)
          )
            continue;
          const g = a ?? b;
          if (g === undefined) continue;
          await this.#ledger(trx, ctx, order, {
            entryKey: `adjust:${orderId}:${tag}:${key}`,
            kind: 'adjustment',
            refundId: null,
            groupKey: key,
            vatType: g.vatType,
            rateBp: g.rateBp,
            provisional: a?.provisional ?? false,
            gross,
            vat: vatDiff,
            taxPoint: order.tax_point_date,
          });
        }
        await this.#rebaseRefunds(trx, ctx, order, after, tag);
      }
      return { filled };
    });
  }

  /**
   * FA-11 with FA-12 rule 3: refunds recorded while a line was provisional are worked out again
   * at the filled rates, in their own order, and the difference goes in as adjustment rows on each
   * refund's own date. So the per-group cap holds on the new groups and no provisional refund VAT
   * is left behind.
   */
  async #rebaseRefunds(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    order: OrderRow,
    vat: OrderVat,
    tag: string,
  ): Promise<void> {
    const { rows: refunds } = await sql<{ id: string; amount_pence: string; day: string }>`
      SELECT id, amount_pence, to_char(tax_point_date, 'YYYY-MM-DD') AS day FROM app.refunds
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${order.id}::uuid
       ORDER BY refunded_at, id`.execute(trx);
    if (refunds.length === 0) return;
    const lines = await this.#lines(trx, ctx, order.id);
    const index = new Map(lines.map((l, i) => [l.id, i]));
    const prior: RefundVat[] = [];
    for (const refund of refunds) {
      const { rows: refundLines } = await sql<{ order_line_id: string; amount_pence: string }>`
        SELECT order_line_id, amount_pence FROM app.refund_lines
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND refund_id = ${refund.id}::uuid`.execute(
        trx,
      );
      const byLine = refundLines.flatMap((rl) => {
        const i = index.get(rl.order_line_id);
        return i === undefined ? [] : [{ line: i, amount: pence(big(rl.amount_pence)) }];
      });
      const rv = computeRefundVat({
        order: vat,
        refunded: prior,
        refund: {
          amount: pence(big(refund.amount_pence)),
          ...(byLine.length === 0 ? {} : { lines: byLine }),
        },
      });
      prior.push(rv);
      const { rows: recorded } = await sql<{
        group_key: string;
        gross: string;
        vat: string;
        rate_bp: string;
        vat_type: SaleVatType | null;
      }>`
        SELECT group_key, sum(gross_pence) AS gross, sum(vat_pence) AS vat,
               min(rate_bp) AS rate_bp, min(vat_type) AS vat_type FROM app.vat_ledger
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND refund_id = ${refund.id}::uuid
         GROUP BY group_key`.execute(trx);
      const keys = new Set([...recorded.map((r) => r.group_key), ...rv.groups.map((g) => g.key)]);
      for (const key of keys) {
        const want = rv.groups.find((g) => g.key === key);
        const had = recorded.find((r) => r.group_key === key);
        const gross = 0n - (want?.gross ?? 0n) - big(had?.gross);
        const vatDiff = 0n - (want?.vat ?? 0n) - big(had?.vat);
        if (gross === 0n && vatDiff === 0n) continue;
        const group = vat.groups.find((g) => g.key === key);
        await this.#ledger(trx, ctx, order, {
          entryKey: `adjust:${refund.id}:${tag}:${key}`,
          kind: 'adjustment',
          refundId: refund.id,
          groupKey: key,
          vatType: group?.vatType ?? had?.vat_type ?? null,
          rateBp: group?.rateBp ?? Number(had?.rate_bp ?? 0),
          provisional: group?.provisional ?? false,
          gross,
          vat: vatDiff,
          taxPoint: refund.day,
        });
      }
    }
  }

  /** Line VAT and the order's VAT after a snapshot filled (FA-12 rule 2: from the group). */
  async #reallocate(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    orderId: string,
    vat: OrderVat,
  ): Promise<void> {
    const lines = await this.#lines(trx, ctx, orderId);
    for (const [index, line] of lines.entries()) {
      const v = vat.lines[index];
      if (v === undefined) continue;
      await sql`UPDATE app.order_lines
                   SET vat_pence = ${v.vat}, discount_pence = ${v.discount}, shipping_pence = ${v.shipping}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${line.id}::uuid`.execute(
        trx,
      );
    }
    const unmapped = lines.some((l) => l.vat_type === null);
    await sql`UPDATE app.orders SET vat_pence = ${vat.vat}, unmapped = ${unmapped}, updated_at = ${this.#now()}
               WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderId}::uuid`.execute(
      trx,
    );
  }

  /** DEL-1: what the expiry job needs, IDs and dates only, for orders that still hold PII. */
  async piiExpiryOf(
    ctx: TenantContext,
    orderIds: readonly string[],
  ): Promise<
    {
      orderId: string;
      piiRef: string;
      placedAt: Date;
      dispatchedAt: Date | null;
      deliveredAt: Date | null;
    }[]
  > {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{
        id: string;
        pii_ref: string;
        placed_at: Date;
        dispatched_at: Date | null;
        delivered_at: Date | null;
      }>`
        SELECT o.id, o.pii_ref, o.placed_at, o.dispatched_at, o.delivered_at FROM app.orders o
         WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.id = ANY (${sql.val(orderIds)}::uuid[])
           AND o.pii_ref IS NOT NULL AND o.pii_deleted_at IS NULL AND o.status <> 'cancelled'
           AND NOT EXISTS (SELECT 1 FROM app.pii_tombstones t
                            WHERE t.workspace_id = o.workspace_id AND t.pii_ref = o.pii_ref)`.execute(
        trx,
      );
      return rows.map((r) => ({
        orderId: r.id,
        piiRef: r.pii_ref,
        placedAt: r.placed_at,
        dispatchedAt: r.dispatched_at,
        deliveredAt: r.delivered_at,
      }));
    });
  }

  /** The workspace's PII window in days (TEN-6: 25, fixed; PRD 7.3). */
  async retentionDays(ctx: TenantContext): Promise<number> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ days: string }>`
        SELECT pii_retention_days AS days FROM app.workspaces
         WHERE id = ${ctx.workspaceId}::uuid`.execute(trx);
      return Number(rows[0]?.days ?? 25);
    });
  }

  /** FA-10 orphan sweep: which of these vault refs an order points at (IDs only). */
  async knownPiiRefs(ctx: TenantContext, piiRefs: readonly string[]): Promise<ReadonlySet<string>> {
    if (piiRefs.length === 0) return new Set();
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ pii_ref: string }>`
        SELECT pii_ref FROM app.orders
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND pii_ref = ANY (${sql.val(piiRefs)}::uuid[])`.execute(trx);
      return new Set(rows.map((r) => r.pii_ref));
    });
  }
}
