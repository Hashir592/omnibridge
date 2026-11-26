import { randomUUID } from 'node:crypto';
import {
  computeOrderVat,
  pence,
  sameBuyerGroups,
  type OrderStatus,
  type OrderVat,
  type SaleVatType,
  type TenantContext,
} from '@omnibridge/core';
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/*
 * The order read side and same-buyer groups (T-1002: ORD-1, ORD-2, ORD-5 to ORD-9, AT-26). Every
 * query runs under the caller's company scope (RLS, ARCHITECTURE 6.1), so Combined is the user's
 * permitted companies only. Nothing here holds or returns buyer PII: masked and full values come
 * from pii-vault in the web handlers, by pii_ref.
 */

export type OrderFlag =
  'oversold' | 'unmapped' | 'address_shortened' | 'tracking_not_confirmed' | 'fba';

/** Why an order's pence differ from the channel's (ADR-081 3). */
export type AmountsDiffer = 'channel_total' | 'late_change' | 'refund_above';

export interface OrderFilter {
  companyId?: string | undefined;
  channelAccountId?: string | undefined;
  status?: OrderStatus | undefined;
  /** London calendar days, inclusive, on the placed date. */
  from?: string | undefined;
  to?: string | undefined;
  shipBy?: 'today' | 'overdue' | undefined;
  flag?: OrderFlag | undefined;
  /** How an order reference or SKU (Master or channel) starts, case-insensitive (ADR-081 6). */
  q?: string | undefined;
  /** ORD-2 buyer search: only orders whose vault record is one of these. */
  piiRefs?: readonly string[] | undefined;
}

export interface OrderListRow {
  id: string;
  provider: 'amazon' | 'ebay' | 'website';
  channelAccountId: string;
  channelAccountName: string | null;
  companyId: string;
  orderRef: string;
  placedAt: Date;
  skus: string[];
  status: OrderStatus;
  rawStatus: string;
  itemCount: number;
  grossPence: bigint;
  shipBy: Date | null;
  flags: OrderFlag[];
  customer: 'present' | 'deleted' | 'none';
  customerDeletedAt: Date | null;
  piiRef: string | null;
  group: { id: string; size: number; position: number; hidden: number } | null;
}

export interface OrderGroupView {
  id: string;
  channelAccountId: string;
  state: 'open' | 'dismissed' | 'closed';
  members: {
    id: string;
    orderRef: string;
    placedAt: Date;
    status: OrderStatus;
    shipBy: Date | null;
  }[];
  warnings: ('different_ship_by' | 'different_service' | 'address_shortened' | 'unmapped')[];
  earliestShipBy: Date | null;
}

export interface OrderLineView {
  id: string;
  externalLineId: string;
  skuId: string | null;
  sku: string | null;
  externalSku: string | null;
  title: string | null;
  quantity: number;
  unitGrossPence: bigint;
  lineGrossPence: bigint;
  discountPence: bigint;
  shippingPence: bigint;
  vatType: SaleVatType | null;
  vatRateBp: number;
  vatPence: bigint;
  cogsPence: bigint | null;
  provisional: boolean;
  oversold: boolean;
}

export interface OrderDetailView extends OrderListRow {
  paidAt: Date | null;
  dispatchedAt: Date | null;
  /** `dispatchedAt` is a stand-in: the channel gave no dispatch time. */
  dispatchEstimated: boolean;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  taxPointDate: string;
  shipToCountry: string | null;
  lines: OrderLineView[];
  money: {
    goodsPence: bigint;
    discountPence: bigint;
    shippingPence: bigint;
    grossPence: bigint;
    vatPence: bigint;
    netPence: bigint;
    refundedPence: bigint;
    refundedVatPence: bigint;
    vatGroups: OrderVat['groups'];
    amountsDiffer: AmountsDiffer[];
  };
  history: { at: Date; status: OrderStatus | null; rawStatus: string }[];
  refunds: {
    id: string;
    externalRefundId: string;
    refundedAt: Date;
    amountPence: bigint;
    vatPence: bigint;
    returnToStock: boolean;
    lines: { orderLineId: string; sku: string | null; quantity: number; amountPence: bigint }[];
  }[];
  notes: string | null;
  notesUpdatedAt: Date | null;
  sameBuyer: OrderGroupView | null;
}

export interface ReturnRowView {
  id: string;
  orderId: string;
  orderRef: string;
  provider: 'amazon' | 'ebay' | 'website';
  channelAccountId: string;
  channelAccountName: string | null;
  companyId: string;
  at: Date;
  amountPence: bigint;
  vatPence: bigint;
  skus: string[];
  returnToStock: boolean;
}

/** A group action refused: 404 when the group is not there for this user, 409 when it is not open. */
export class OrderGroupRefused extends Error {
  readonly code: 'not_found' | 'not_open' | 'not_a_member';

  constructor(code: 'not_found' | 'not_open' | 'not_a_member') {
    super(`Order group change refused: ${code}`);
    this.name = 'OrderGroupRefused';
    this.code = code;
  }
}

const big = (v: string | number | bigint | null | undefined): bigint => BigInt(v ?? 0);
const LONDON = sql.lit('Europe/London');
/** The workspace of the tenant transaction (the one the rows belong to anyway, by RLS). */
const WORKSPACE = sql`nullif(current_setting('app.workspace_id', true), '')::uuid`;

/** A normalised column starts with `q`: a range in the C collation, so its index is used (0059). */
function startsWith(column: RawBuilder<unknown>, q: string): RawBuilder<unknown> {
  const from = sql`lower(${q.trim()}::text)`;
  return sql`${column} >= ${from} AND ${column} < ${from} || chr(1114111)`;
}

/**
 * ORD-2: the orders a search finds (with the other filters), once for the whole statement, with what
 * the list needs of them; or nothing, when there is no search.
 */
function hits(ctx: TenantContext, f: OrderFilter, now: Date): RawBuilder<unknown> {
  if (f.q === undefined) return sql``;
  const ws = sql`${ctx.workspaceId}::uuid`;
  const where = orderWhere(ctx, f, now);
  return sql`hit AS MATERIALIZED (
    SELECT o.id, o.placed_at, o.order_group_id FROM app.orders o
     WHERE ${where} AND ${startsWith(sql`o.search_ref`, f.q)}
    UNION
    SELECT o.id, o.placed_at, o.order_group_id FROM app.order_lines l
      JOIN app.orders o ON o.workspace_id = l.workspace_id AND o.id = l.order_id
     WHERE l.workspace_id = ${ws} AND l.removed_at IS NULL
       AND ${startsWith(sql`l.search_sku`, f.q)} AND ${where}
    UNION
    SELECT o.id, o.placed_at, o.order_group_id FROM app.master_skus s
      JOIN app.order_lines l ON l.workspace_id = s.workspace_id AND l.master_sku_id = s.id
                            AND l.removed_at IS NULL
      JOIN app.orders o ON o.workspace_id = l.workspace_id AND o.id = l.order_id
     WHERE s.workspace_id = ${ws} AND ${startsWith(sql`s.search_sku`, f.q)} AND ${where}),`;
}

/** The ORD-2 filters but the search, as SQL on one orders row, `o` or `m`. */
function orderWhere(
  ctx: TenantContext,
  f: OrderFilter,
  now: Date,
  row: 'o' | 'm' = 'o',
): RawBuilder<unknown> {
  const o = sql.raw(row);
  const parts: RawBuilder<unknown>[] = [sql`${o}.workspace_id = ${ctx.workspaceId}::uuid`];
  if (f.companyId !== undefined) parts.push(sql`${o}.company_id = ${f.companyId}::uuid`);
  if (f.channelAccountId !== undefined)
    parts.push(sql`${o}.channel_account_id = ${f.channelAccountId}::uuid`);
  if (f.status !== undefined) parts.push(sql`${o}.status = ${f.status}`);
  if (f.from !== undefined)
    parts.push(sql`${o}.placed_at >= (${f.from}::date)::timestamp AT TIME ZONE ${LONDON}`);
  if (f.to !== undefined)
    parts.push(sql`${o}.placed_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE ${LONDON})`);
  if (f.shipBy === 'today') {
    parts.push(sql`${o}.ship_by >= date_trunc('day', ${now}::timestamptz AT TIME ZONE ${LONDON}) AT TIME ZONE ${LONDON}
                   AND ${o}.ship_by < (date_trunc('day', ${now}::timestamptz AT TIME ZONE ${LONDON}) + interval '1 day') AT TIME ZONE ${LONDON}`);
  }
  if (f.shipBy === 'overdue') {
    parts.push(
      sql`${o}.ship_by < ${now} AND ${o}.status IN ('pending_payment', 'awaiting_dispatch', 'label_created')`,
    );
  }
  if (f.flag === 'oversold') parts.push(sql`${o}.oversold`);
  if (f.flag === 'unmapped') parts.push(sql`${o}.unmapped`);
  if (f.flag === 'address_shortened') parts.push(sql`${o}.address_shortened`);
  if (f.flag === 'fba') parts.push(sql`${o}.fba`);
  // Tracking confirmation arrives with M12: no order carries the flag yet.
  if (f.flag === 'tracking_not_confirmed') parts.push(sql`FALSE`);
  if (f.piiRefs !== undefined) parts.push(sql`${o}.pii_ref = ANY (${sql.val(f.piiRefs)}::uuid[])`);
  return sql.join(parts, sql` AND `);
}

interface ListSqlRow {
  id: string;
  provider: 'amazon' | 'ebay' | 'website';
  channel_account_id: string;
  account_name: string | null;
  company_id: string;
  external_order_id: string;
  placed_at: Date;
  skus: string[] | null;
  status: OrderStatus;
  raw_status: string;
  items: string | null;
  gross_pence: string;
  ship_by: Date | null;
  oversold: boolean;
  unmapped: boolean;
  address_shortened: boolean;
  fba: boolean;
  pii_ref: string | null;
  customer_present: boolean;
  customer_deleted_at: Date | null;
  open_group: string | null;
  group_size: string | null;
  group_position: string | null;
  group_visible: string | null;
}

function listRow(r: ListSqlRow): OrderListRow {
  const flags: OrderFlag[] = [];
  if (r.oversold) flags.push('oversold');
  if (r.unmapped) flags.push('unmapped');
  if (r.address_shortened) flags.push('address_shortened');
  if (r.fba) flags.push('fba');
  const size = Number(r.group_size ?? 0);
  return {
    id: r.id,
    provider: r.provider,
    channelAccountId: r.channel_account_id,
    channelAccountName: r.account_name,
    companyId: r.company_id,
    orderRef: r.external_order_id,
    placedAt: r.placed_at,
    skus: r.skus ?? [],
    status: r.status,
    rawStatus: r.raw_status,
    itemCount: Number(r.items ?? 0),
    grossPence: big(r.gross_pence),
    shipBy: r.ship_by,
    flags,
    customer: r.customer_present ? 'present' : r.customer_deleted_at !== null ? 'deleted' : 'none',
    customerDeletedAt: r.customer_present ? null : r.customer_deleted_at,
    piiRef: r.customer_present ? r.pii_ref : null,
    group:
      r.open_group === null || size < 2
        ? null
        : {
            id: r.open_group,
            size,
            position: Number(r.group_position ?? 1),
            hidden: Math.max(0, size - Number(r.group_visible ?? size)),
          },
  };
}

/** The open group of a row `o` (an order, or one a search found), as `g`. */
const OPEN_GROUP = sql`
  LEFT JOIN app.order_groups g ON g.workspace_id = ${WORKSPACE} AND g.id = o.order_group_id
                              AND g.state = 'open'`;

/** The rows a list is made of: every order the filter keeps, or those the search found. */
function rowsOf(ctx: TenantContext, f: OrderFilter, now: Date, row: 'o' | 'm' = 'o') {
  return f.q === undefined
    ? { from: sql`app.orders ${sql.raw(row)}`, where: orderWhere(ctx, f, now, row) }
    : { from: sql`hit ${sql.raw(row)}`, where: sql`TRUE` };
}

/**
 * ORD-1: the units of a list, newest first when ordered by (unit_at DESC, id): an order in no open
 * group, or the earliest member of its group that the filter keeps. With no search they are read
 * from the placed index, so a page costs what it shows (CAP-7); with one, from what it found.
 */
function heads(ctx: TenantContext, f: OrderFilter, now: Date): RawBuilder<unknown> {
  const o = rowsOf(ctx, f, now);
  if (f.q !== undefined) {
    return sql`
      SELECT o.id, o.placed_at AS unit_at, NULL::uuid AS open_group
        FROM ${o.from} ${OPEN_GROUP} WHERE g.id IS NULL
      UNION ALL
      (SELECT DISTINCT ON (g.id) o.id, o.placed_at, g.id
         FROM ${o.from} ${OPEN_GROUP} WHERE g.id IS NOT NULL
        ORDER BY g.id, o.placed_at, o.id)`;
  }
  return sql`
    SELECT o.id, o.placed_at AS unit_at, g.id AS open_group
      FROM ${o.from} ${OPEN_GROUP}
     WHERE ${o.where}
       AND (g.id IS NULL OR NOT EXISTS (
         SELECT 1 FROM app.orders m
          WHERE m.order_group_id = g.id AND (m.placed_at, m.id) < (o.placed_at, o.id)
            AND ${orderWhere(ctx, f, now, 'm')}))`;
}

/**
 * What every list row needs (C2 SKUs, flags, customer, group size and place) of the orders in
 * `src(id, unit, unit_at, open_group)` only: the caller puts the page (or the export's rows) there
 * first, so this never runs over a whole workspace (CAP-7).
 */
function enriched(ctx: TenantContext): RawBuilder<unknown> {
  return sql`
    SELECT o.id, o.provider, o.channel_account_id, a.display_name AS account_name, o.company_id,
           o.external_order_id, o.placed_at, o.status, o.raw_status, o.gross_pence, o.ship_by,
           o.oversold, o.unmapped, o.address_shortened, o.fba, o.pii_ref,
           (o.pii_ref IS NOT NULL AND o.pii_deleted_at IS NULL AND t.pii_ref IS NULL) AS customer_present,
           coalesce(o.pii_deleted_at, t.deleted_at) AS customer_deleted_at,
           f.unit, f.unit_at, f.open_group,
           -- C3.3 "+N related order not shown": the group's members this filter keeps.
           count(*) OVER (PARTITION BY f.open_group) AS group_visible,
           li.skus, li.items, gs.size AS group_size, gs.position AS group_position
      FROM src f
      JOIN app.orders o ON o.workspace_id = ${ctx.workspaceId}::uuid AND o.id = f.id
      JOIN app.channel_accounts a ON a.workspace_id = o.workspace_id AND a.id = o.channel_account_id
      LEFT JOIN app.pii_tombstones t ON t.workspace_id = o.workspace_id AND t.pii_ref = o.pii_ref
      LEFT JOIN LATERAL (
        SELECT array_agg(coalesce(s.sku, l.external_sku, '') ORDER BY l.line_no) AS skus,
               sum(l.quantity) AS items
          FROM app.order_lines l
          LEFT JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.order_id = o.id
           AND l.removed_at IS NULL) li ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*) AS size,
               count(*) FILTER (WHERE (m.placed_at, m.id) <= (o.placed_at, o.id)) AS position
          FROM app.orders m
         WHERE m.workspace_id = ${ctx.workspaceId}::uuid AND m.order_group_id = f.open_group) gs
        ON f.open_group IS NOT NULL`;
}

export class OrderReads {
  readonly #db: Kysely<MainDb>;
  readonly #now: () => Date;

  constructor(db: Kysely<MainDb>, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  /** False when a filter names an account or company this user cannot see (the route's 404). */
  async filterVisible(
    ctx: TenantContext,
    f: Pick<OrderFilter, 'companyId' | 'channelAccountId'>,
  ): Promise<boolean> {
    if (f.companyId !== undefined && !ctx.companyIds.includes(f.companyId)) return false;
    if (f.channelAccountId === undefined) return true;
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql`SELECT 1 FROM app.channel_accounts
                                  WHERE workspace_id = ${ctx.workspaceId}::uuid
                                    AND id = ${f.channelAccountId}::uuid`.execute(trx);
      return rows.length > 0;
    });
  }

  /**
   * ORD-1: one page of orders, newest first. A same-buyer group is one unit sorted by its earliest
   * visible member, and a page never splits a group, so it may hold more than `limit` rows (C3.3).
   * `total` counts units. Compiling the statement (jit) takes longer than running it.
   */
  async list(
    ctx: TenantContext,
    f: OrderFilter,
    page: { offset: number; limit: number },
    countUpTo: number,
  ): Promise<{ items: OrderListRow[]; total: number }> {
    const now = this.#now();
    const m = rowsOf(ctx, f, now, 'm');
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`SET LOCAL jit = off`.execute(trx);
      // A search counts what it found already; without one the count stops at its cap by itself.
      const counted = f.q !== undefined;
      const { rows } = await sql<ListSqlRow & { total: string | null }>`
        WITH ${hits(ctx, f, now)}
             u AS ${counted ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (${heads(ctx, f, now)}),
             p AS (SELECT * FROM u
                    ORDER BY u.unit_at DESC, u.id LIMIT ${page.limit} OFFSET ${page.offset}),
             src AS (SELECT p.id, p.id AS unit, p.unit_at, p.open_group FROM p
                      WHERE p.open_group IS NULL
                     UNION ALL
                     SELECT m.id, p.id, p.unit_at, p.open_group FROM p
                       JOIN ${m.from} ON m.order_group_id = p.open_group
                      WHERE ${m.where}),
             e AS (${enriched(ctx)})
        SELECT e.*, ${
          counted ? sql`(SELECT count(*) FROM (SELECT 1 FROM u LIMIT ${countUpTo}) x)` : sql`NULL`
        } AS total
          FROM e ORDER BY e.unit_at DESC, e.unit, e.placed_at, e.id`.execute(trx);
      const items = rows.map(listRow);
      const known = rows[0]?.total ?? null;
      if (known !== null) return { items, total: Number(known) };
      const { rows: total } = await sql<{ n: string }>`
        WITH ${hits(ctx, f, now)}
             u AS (SELECT 1 FROM (${heads(ctx, f, now)}) x LIMIT ${countUpTo})
        SELECT count(*) AS n FROM u`.execute(trx);
      return { items, total: Number(total[0]?.n ?? 0) };
    });
  }

  /** ORD-8: the rows of the CSV export, at most `cap`, newest first. IDs and figures only. */
  async exportRows(
    ctx: TenantContext,
    f: OrderFilter,
    cap: number,
  ): Promise<OrderListRow[] | undefined> {
    const now = this.#now();
    const o = rowsOf(ctx, f, now);
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`SET LOCAL jit = off`.execute(trx);
      const { rows } = await sql<ListSqlRow>`
        WITH ${hits(ctx, f, now)}
             src AS (SELECT o.id, o.id AS unit, o.placed_at AS unit_at, g.id AS open_group
                       FROM ${o.from} ${OPEN_GROUP}
                      WHERE ${o.where}
                      ORDER BY o.placed_at DESC, o.id LIMIT ${cap + 1}),
             e AS (${enriched(ctx)})
        SELECT * FROM e ORDER BY placed_at DESC, id`.execute(trx);
      return rows.length > cap ? undefined : rows.map(listRow);
    });
  }

  /** ORD-6: everything the detail page shows, or undefined (404) when the user cannot see it. */
  async detail(ctx: TenantContext, orderId: string): Promise<OrderDetailView | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<ListSqlRow>`
        WITH src AS (SELECT o.id, o.id AS unit, o.placed_at AS unit_at, g.id AS open_group
                       FROM app.orders o ${OPEN_GROUP}
                      WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.id = ${orderId}::uuid),
             e AS (${enriched(ctx)})
        SELECT * FROM e`.execute(trx);
      const head = rows[0];
      if (head === undefined) return undefined;
      const { rows: extra } = await sql<{
        paid_at: Date | null;
        dispatched_at: Date | null;
        dispatch_estimated: boolean;
        delivered_at: Date | null;
        cancelled_at: Date | null;
        amounts_differ: AmountsDiffer[];
        tax_point_date: string;
        ship_to_country: string | null;
        goods_pence: string;
        discount_pence: string;
        shipping_pence: string;
        notes: string | null;
        notes_updated_at: Date | null;
      }>`
        SELECT paid_at, dispatched_at, dispatch_estimated, delivered_at, cancelled_at, amounts_differ,
               to_char(tax_point_date, 'YYYY-MM-DD') AS tax_point_date, ship_to_country,
               goods_pence, discount_pence, shipping_pence, notes, notes_updated_at
          FROM app.orders WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderId}::uuid`.execute(
        trx,
      );
      const o = extra[0];
      if (o === undefined) return undefined;
      const { rows: lineRows } = await sql<{
        id: string;
        external_line_id: string;
        master_sku_id: string | null;
        sku: string | null;
        external_sku: string | null;
        title: string | null;
        quantity: string;
        unit_gross_pence: string;
        line_gross_pence: string;
        discount_pence: string;
        shipping_pence: string;
        vat_type: SaleVatType | null;
        vat_rate_bp: string | null;
        provisional_rate_bp: string;
        vat_pence: string;
        cogs_pence: string | null;
        oversold: boolean;
      }>`
        SELECT l.id, l.external_line_id, l.master_sku_id, s.sku, l.external_sku, l.title, l.quantity,
               l.unit_gross_pence, l.line_gross_pence, l.discount_pence, l.shipping_pence, l.vat_type,
               l.vat_rate_bp, l.provisional_rate_bp, l.vat_pence, l.cogs_pence, l.oversold
          FROM app.order_lines l
          LEFT JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
         WHERE l.workspace_id = ${ctx.workspaceId}::uuid AND l.order_id = ${orderId}::uuid
           AND l.removed_at IS NULL
         ORDER BY l.line_no`.execute(trx);
      const lines: OrderLineView[] = lineRows.map((l) => ({
        id: l.id,
        externalLineId: l.external_line_id,
        skuId: l.master_sku_id,
        sku: l.sku,
        externalSku: l.external_sku,
        title: l.title,
        quantity: Number(l.quantity),
        unitGrossPence: big(l.unit_gross_pence),
        lineGrossPence: big(l.line_gross_pence),
        discountPence: big(l.discount_pence),
        shippingPence: big(l.shipping_pence),
        vatType: l.vat_type,
        vatRateBp: Number(l.vat_rate_bp ?? l.provisional_rate_bp),
        vatPence: big(l.vat_pence),
        cogsPence: l.cogs_pence === null ? null : big(l.cogs_pence),
        provisional: l.vat_type === null,
        oversold: l.oversold,
      }));
      const vat = computeOrderVat({
        lines: lines.map((l) => ({
          lineGross: pence(l.lineGrossPence),
          rateBp: l.vatRateBp,
          vatType: l.vatType,
        })),
        discount: pence(big(o.discount_pence)),
        shipping: pence(big(o.shipping_pence)),
      });
      const { rows: history } = await sql<{
        created_at: Date;
        status: OrderStatus | null;
        raw_status: string;
      }>`
        SELECT created_at, status, raw_status FROM app.order_status_events
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${orderId}::uuid
         ORDER BY created_at, id`.execute(trx);
      const refunds = await this.#refunds(trx, ctx, orderId);
      const { rows: refundedVat } = await sql<{ vat: string | null }>`
        SELECT -sum(vat_pence) AS vat FROM app.vat_ledger
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${orderId}::uuid
           AND refund_id IS NOT NULL`.execute(trx);
      const listed = listRow(head);
      // "Hidden by a filter" is a list idea; the detail page shows the whole group.
      const row =
        listed.group === null ? listed : { ...listed, group: { ...listed.group, hidden: 0 } };
      return {
        ...row,
        paidAt: o.paid_at,
        dispatchedAt: o.dispatched_at,
        dispatchEstimated: o.dispatch_estimated,
        deliveredAt: o.delivered_at,
        cancelledAt: o.cancelled_at,
        taxPointDate: o.tax_point_date,
        shipToCountry: o.ship_to_country,
        lines,
        money: {
          goodsPence: big(o.goods_pence),
          discountPence: big(o.discount_pence),
          shippingPence: big(o.shipping_pence),
          grossPence: vat.gross,
          vatPence: vat.vat,
          netPence: vat.gross - vat.vat,
          refundedPence: refunds.reduce((a, r) => a + r.amountPence, 0n),
          refundedVatPence: big(refundedVat[0]?.vat),
          vatGroups: vat.groups,
          amountsDiffer: o.amounts_differ,
        },
        history: history.map((h) => ({
          at: h.created_at,
          status: h.status,
          rawStatus: h.raw_status,
        })),
        refunds,
        notes: o.notes,
        notesUpdatedAt: o.notes_updated_at,
        sameBuyer:
          row.group === null ? null : ((await this.#group(trx, ctx, row.group.id)) ?? null),
      };
    });
  }

  async #refunds(trx: Transaction<MainDb>, ctx: TenantContext, orderId: string) {
    const { rows } = await sql<{
      id: string;
      external_refund_id: string;
      refunded_at: Date;
      amount_pence: string;
      vat_pence: string;
      return_to_stock: boolean;
    }>`
      SELECT id, external_refund_id, refunded_at, amount_pence, vat_pence, return_to_stock
        FROM app.refunds
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${orderId}::uuid
       ORDER BY refunded_at, id`.execute(trx);
    const { rows: lines } = await sql<{
      refund_id: string;
      order_line_id: string;
      sku: string | null;
      quantity: string;
      amount_pence: string;
    }>`
      SELECT rl.refund_id, rl.order_line_id, coalesce(s.sku, l.external_sku) AS sku, rl.quantity,
             rl.amount_pence
        FROM app.refund_lines rl
        JOIN app.order_lines l ON l.workspace_id = rl.workspace_id AND l.id = rl.order_line_id
        LEFT JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
       WHERE rl.workspace_id = ${ctx.workspaceId}::uuid AND l.order_id = ${orderId}::uuid`.execute(
      trx,
    );
    return rows.map((r) => ({
      id: r.id,
      externalRefundId: r.external_refund_id,
      refundedAt: r.refunded_at,
      amountPence: big(r.amount_pence),
      vatPence: big(r.vat_pence),
      returnToStock: r.return_to_stock,
      lines: lines
        .filter((l) => l.refund_id === r.id)
        .map((l) => ({
          orderLineId: l.order_line_id,
          sku: l.sku,
          quantity: Number(l.quantity),
          amountPence: big(l.amount_pence),
        })),
    }));
  }

  /** ORD-5: the order's vault record, when the buyer's details still exist. */
  async customerRef(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{ piiRef: string | null } | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ pii_ref: string | null; present: boolean }>`
        SELECT o.pii_ref,
               (o.pii_ref IS NOT NULL AND o.pii_deleted_at IS NULL AND t.pii_ref IS NULL) AS present
          FROM app.orders o
          LEFT JOIN app.pii_tombstones t ON t.workspace_id = o.workspace_id AND t.pii_ref = o.pii_ref
         WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.id = ${orderId}::uuid`.execute(trx);
      const r = rows[0];
      if (r === undefined) return undefined;
      return { piiRef: r.present ? r.pii_ref : null };
    });
  }

  /** ORD-6: internal notes. Undefined when the order is not there for this user. */
  async setNotes(
    ctx: TenantContext,
    orderId: string,
    notes: string,
    userId: string,
  ): Promise<{ notes: string | null; updatedAt: Date } | undefined> {
    const now = this.#now();
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const value = notes.trim() === '' ? null : notes;
      const { numAffectedRows } = await sql`
        UPDATE app.orders SET notes = ${value}, notes_updated_at = ${now}, notes_updated_by = ${userId}::uuid
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderId}::uuid`.execute(trx);
      return Number(numAffectedRows ?? 0n) === 0 ? undefined : { notes: value, updatedAt: now };
    });
  }

  /** ORD-7: refunds from every channel, newest first. */
  async returns(
    ctx: TenantContext,
    f: Pick<OrderFilter, 'companyId' | 'channelAccountId' | 'from' | 'to'>,
    page: { offset: number; limit: number },
    countUpTo: number,
  ): Promise<{ items: ReturnRowView[]; total: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const parts = [sql`r.workspace_id = ${ctx.workspaceId}::uuid`];
      if (f.companyId !== undefined) parts.push(sql`r.company_id = ${f.companyId}::uuid`);
      if (f.channelAccountId !== undefined)
        parts.push(sql`o.channel_account_id = ${f.channelAccountId}::uuid`);
      if (f.from !== undefined)
        parts.push(sql`r.refunded_at >= (${f.from}::date)::timestamp AT TIME ZONE ${LONDON}`);
      if (f.to !== undefined)
        parts.push(sql`r.refunded_at < ((${f.to}::date + 1)::timestamp AT TIME ZONE ${LONDON})`);
      const where = sql.join(parts, sql` AND `);
      const { rows } = await sql<{
        id: string;
        order_id: string;
        external_order_id: string;
        provider: 'amazon' | 'ebay' | 'website';
        channel_account_id: string;
        account_name: string | null;
        company_id: string;
        refunded_at: Date;
        amount_pence: string;
        vat_pence: string;
        return_to_stock: boolean;
        skus: string[] | null;
      }>`
        SELECT r.id, r.order_id, o.external_order_id, o.provider, o.channel_account_id,
               a.display_name AS account_name, r.company_id, r.refunded_at, r.amount_pence,
               r.vat_pence, r.return_to_stock,
               (SELECT array_agg(DISTINCT coalesce(s.sku, l.external_sku))
                         FILTER (WHERE coalesce(s.sku, l.external_sku) IS NOT NULL)
                  FROM app.order_lines l
                  LEFT JOIN app.master_skus s ON s.workspace_id = l.workspace_id AND s.id = l.master_sku_id
                 WHERE l.workspace_id = r.workspace_id AND l.order_id = r.order_id
                   AND l.removed_at IS NULL
                   AND (NOT EXISTS (SELECT 1 FROM app.refund_lines x
                                     WHERE x.workspace_id = r.workspace_id AND x.refund_id = r.id)
                        OR l.id IN (SELECT x.order_line_id FROM app.refund_lines x
                                     WHERE x.workspace_id = r.workspace_id AND x.refund_id = r.id))) AS skus
          FROM app.refunds r
          JOIN app.orders o ON o.workspace_id = r.workspace_id AND o.id = r.order_id
          JOIN app.channel_accounts a ON a.workspace_id = o.workspace_id AND a.id = o.channel_account_id
         WHERE ${where}
         ORDER BY r.refunded_at DESC, r.id
         LIMIT ${page.limit} OFFSET ${page.offset}`.execute(trx);
      const { rows: counted } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM (SELECT 1 FROM app.refunds r
          JOIN app.orders o ON o.workspace_id = r.workspace_id AND o.id = r.order_id
         WHERE ${where} LIMIT ${countUpTo}) x`.execute(trx);
      return {
        items: rows.map((r) => ({
          id: r.id,
          orderId: r.order_id,
          orderRef: r.external_order_id,
          provider: r.provider,
          channelAccountId: r.channel_account_id,
          channelAccountName: r.account_name,
          companyId: r.company_id,
          at: r.refunded_at,
          amountPence: big(r.amount_pence),
          vatPence: big(r.vat_pence),
          skus: r.skus ?? [],
          returnToStock: r.return_to_stock,
        })),
        total: Number(counted[0]?.n ?? 0),
      };
    });
  }

  /** DEL-5: the order records of these vault subjects, for the access export (IDs and figures). */
  async bySubjects(ctx: TenantContext, subjects: readonly string[]) {
    if (subjects.length === 0) return [];
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{
        pii_subject: string;
        external_order_id: string;
        provider: string;
        channel_account_id: string;
        placed_at: Date;
        status: string;
        gross_pence: string;
      }>`
        SELECT pii_subject, external_order_id, provider, channel_account_id, placed_at, status, gross_pence
          FROM app.orders
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND pii_subject = ANY (${sql.val(subjects)}::text[])
         ORDER BY placed_at`.execute(trx);
      return rows.map((r) => ({
        subjectId: r.pii_subject,
        orderRef: r.external_order_id,
        provider: r.provider,
        channelAccountId: r.channel_account_id,
        placedAt: r.placed_at,
        status: r.status,
        grossPence: big(r.gross_pence),
      }));
    });
  }

  async #group(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    groupId: string,
  ): Promise<OrderGroupView | undefined> {
    const { rows: g } = await sql<{
      id: string;
      channel_account_id: string;
      state: 'open' | 'dismissed' | 'closed';
    }>`
      SELECT id, channel_account_id, state FROM app.order_groups
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${groupId}::uuid`.execute(trx);
    const group = g[0];
    if (group === undefined) return undefined;
    const { rows: members } = await sql<{
      id: string;
      external_order_id: string;
      placed_at: Date;
      status: OrderStatus;
      ship_by: Date | null;
      address_shortened: boolean;
      unmapped: boolean;
    }>`
      SELECT id, external_order_id, placed_at, status, ship_by, address_shortened, unmapped
        FROM app.orders
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_group_id = ${groupId}::uuid
       ORDER BY placed_at, id`.execute(trx);
    const shipBys = members
      .map((m) => m.ship_by?.getTime() ?? null)
      .filter((t): t is number => t !== null);
    const warnings: OrderGroupView['warnings'] = [];
    if (new Set(shipBys).size > 1) warnings.push('different_ship_by');
    if (members.some((m) => m.address_shortened)) warnings.push('address_shortened');
    if (members.some((m) => m.unmapped)) warnings.push('unmapped');
    return {
      id: group.id,
      channelAccountId: group.channel_account_id,
      state: group.state,
      members: members.map((m) => ({
        id: m.id,
        orderRef: m.external_order_id,
        placedAt: m.placed_at,
        status: m.status,
        shipBy: m.ship_by,
      })),
      warnings,
      earliestShipBy: shipBys.length === 0 ? null : new Date(Math.min(...shipBys)),
    };
  }

  /** ORD-9: one group as the detail panel and the group actions show it. */
  async group(ctx: TenantContext, groupId: string): Promise<OrderGroupView | undefined> {
    return withTenantTransaction(this.#db, ctx, (trx) => this.#group(trx, ctx, groupId));
  }

  /** C3.2: the orders a recompute considers: awaiting dispatch, not FBA, buyer details held, no open request to cancel. */
  async groupCandidates(
    ctx: TenantContext,
    channelAccountId: string,
  ): Promise<{ id: string; piiRef: string; piiSubject: string }[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ id: string; pii_ref: string; pii_subject: string }>`
        SELECT o.id, o.pii_ref, o.pii_subject FROM app.orders o
         WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.channel_account_id = ${channelAccountId}::uuid
           AND o.status = 'awaiting_dispatch' AND NOT o.fba AND NOT o.cancel_requested
           AND o.pii_ref IS NOT NULL
           AND o.pii_deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM app.pii_tombstones t
                            WHERE t.workspace_id = o.workspace_id AND t.pii_ref = o.pii_ref)
         ORDER BY o.placed_at, o.id`.execute(trx);
      return rows.map((r) => ({ id: r.id, piiRef: r.pii_ref, piiSubject: r.pii_subject }));
    });
  }

  /**
   * C3.2: recompute one account's groups from the vault's match classes (subject → class), under
   * a transaction-scoped advisory lock per account so two jobs never build overlapping groups.
   * An existing open group keeps its id when its earliest member stays grouped; groups left with
   * fewer than two members close.
   */
  async applyGroups(
    ctx: TenantContext,
    channelAccountId: string,
    classes: ReadonlyMap<string, string>,
  ): Promise<{ groups: number }> {
    const now = this.#now();
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      await this.#lockAccount(trx, ctx, channelAccountId);
      const { rows: cands } = await sql<{
        id: string;
        placed_at: Date;
        pii_subject: string;
        order_group_id: string | null;
        company_id: string;
      }>`
        SELECT o.id, o.placed_at, o.pii_subject, o.order_group_id, o.company_id FROM app.orders o
         WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.channel_account_id = ${channelAccountId}::uuid
           AND o.status = 'awaiting_dispatch' AND NOT o.fba AND NOT o.cancel_requested
           AND o.pii_ref IS NOT NULL
           AND o.pii_deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM app.pii_tombstones t
                            WHERE t.workspace_id = o.workspace_id AND t.pii_ref = o.pii_ref)`.execute(
        trx,
      );
      const ids = cands.map((c) => c.id);
      const { rows: excl } = await sql<{ order_a: string; order_b: string }>`
        SELECT order_a, order_b FROM app.order_group_exclusions
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_a = ANY (${sql.val(ids)}::uuid[])`.execute(
        trx,
      );
      const excluded = new Set(excl.map((e) => `${e.order_a}|${e.order_b}`));
      const { rows: ws } = await sql<{ grace: string }>`
        SELECT group_midnight_grace_hours AS grace FROM app.workspaces WHERE id = ${ctx.workspaceId}::uuid`.execute(
        trx,
      );
      const groups = sameBuyerGroups(
        cands.flatMap((c) => {
          const cls = classes.get(c.pii_subject);
          return cls === undefined ? [] : [{ id: c.id, placedAt: c.placed_at, matchClass: cls }];
        }),
        {
          graceHours: Number(ws[0]?.grace ?? 3),
          excluded: (a, b) => excluded.has(a < b ? `${a}|${b}` : `${b}|${a}`),
        },
      );
      const byId = new Map(cands.map((c) => [c.id, c]));
      const company = cands[0]?.company_id;
      const grouped = new Set<string>();
      // A group id goes to one new group only: when an old group splits, the second part is new.
      const usedIds = new Set<string>();
      for (const members of groups) {
        const first = byId.get(members[0] ?? '');
        let groupId = first?.order_group_id ?? null;
        if (groupId !== null && usedIds.has(groupId)) groupId = null;
        if (groupId !== null) {
          const { rows: open } = await sql`SELECT 1 FROM app.order_groups
             WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${groupId}::uuid AND state = 'open'
             FOR UPDATE`.execute(trx);
          if (open.length === 0) groupId = null;
        }
        if (groupId === null) {
          groupId = randomUUID();
          await sql`INSERT INTO app.order_groups (workspace_id, id, company_id, channel_account_id, state, created_at)
                    VALUES (${ctx.workspaceId}::uuid, ${groupId}::uuid, ${first?.company_id ?? company}::uuid,
                            ${channelAccountId}::uuid, 'open', ${now})`.execute(trx);
        }
        usedIds.add(groupId);
        for (const m of members) grouped.add(m);
        await sql`UPDATE app.orders SET order_group_id = ${groupId}::uuid
                   WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ANY (${sql.val(members)}::uuid[])
                     AND order_group_id IS DISTINCT FROM ${groupId}::uuid`.execute(trx);
      }
      // Orders of this account no longer in an open group lose the link; empty groups close.
      await sql`UPDATE app.orders o SET order_group_id = NULL
                 WHERE o.workspace_id = ${ctx.workspaceId}::uuid AND o.channel_account_id = ${channelAccountId}::uuid
                   AND o.order_group_id IS NOT NULL
                   AND NOT (o.id = ANY (${sql.val([...grouped])}::uuid[]))
                   AND EXISTS (SELECT 1 FROM app.order_groups g WHERE g.workspace_id = o.workspace_id
                                 AND g.id = o.order_group_id AND g.state = 'open')`.execute(trx);
      await this.#closeSmall(trx, ctx, channelAccountId, now);
      return { groups: groups.length };
    });
  }

  /**
   * Every change to an account's groups takes this lock first, so a recompute that has read the
   * groups and the pairs kept apart never writes over what a person has just decided (C3.3). Then
   * the orders it may link or unlink, in id order, as a page of orders locks them (F-M10-end-10).
   */
  async #lockAccount(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    channelAccountId: string,
  ): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`order-groups:${channelAccountId}`}, 0))`.execute(
      trx,
    );
    await sql`
      SELECT id FROM app.orders
       WHERE workspace_id = ${ctx.workspaceId}::uuid
         AND channel_account_id = ${channelAccountId}::uuid
         AND (status = 'awaiting_dispatch' OR order_group_id IS NOT NULL)
       ORDER BY id
       FOR NO KEY UPDATE`.execute(trx);
  }

  async #closeSmall(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    channelAccountId: string,
    now: Date,
  ): Promise<void> {
    const { rows: small } = await sql<{ id: string }>`
      SELECT g.id FROM app.order_groups g
       WHERE g.workspace_id = ${ctx.workspaceId}::uuid AND g.channel_account_id = ${channelAccountId}::uuid
         AND g.state = 'open'
         AND (SELECT count(*) FROM app.orders o WHERE o.workspace_id = g.workspace_id
                AND o.order_group_id = g.id) < 2`.execute(trx);
    for (const { id } of small) {
      await sql`UPDATE app.orders SET order_group_id = NULL
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_group_id = ${id}::uuid`.execute(
        trx,
      );
      await sql`UPDATE app.order_groups SET state = 'closed', ended_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${id}::uuid`.execute(trx);
    }
  }

  async #exclude(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    companyId: string,
    pairs: [string, string][],
    kind: 'dismissed' | 'removed',
    now: Date,
  ): Promise<void> {
    for (const [x, y] of pairs) {
      const [a, b] = x < y ? [x, y] : [y, x];
      await sql`INSERT INTO app.order_group_exclusions (workspace_id, order_a, order_b, company_id, kind, created_at)
                VALUES (${ctx.workspaceId}::uuid, ${a}::uuid, ${b}::uuid, ${companyId}::uuid, ${kind}, ${now})
                ON CONFLICT DO NOTHING`.execute(trx);
    }
  }

  async #lockGroup(trx: Transaction<MainDb>, ctx: TenantContext, groupId: string) {
    const { rows: where } = await sql<{ channel_account_id: string }>`
      SELECT channel_account_id FROM app.order_groups
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${groupId}::uuid`.execute(trx);
    if (where[0] === undefined) throw new OrderGroupRefused('not_found');
    await this.#lockAccount(trx, ctx, where[0].channel_account_id);
    const { rows } = await sql<{
      id: string;
      state: string;
      company_id: string;
      channel_account_id: string;
    }>`
      SELECT id, state, company_id, channel_account_id FROM app.order_groups
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${groupId}::uuid FOR UPDATE`.execute(
      trx,
    );
    const g = rows[0];
    if (g === undefined) throw new OrderGroupRefused('not_found');
    if (g.state !== 'open') throw new OrderGroupRefused('not_open');
    const { rows: members } = await sql<{ id: string }>`
      SELECT id FROM app.orders WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_group_id = ${groupId}::uuid
       ORDER BY placed_at, id`.execute(trx);
    return { group: g, members: members.map((m) => m.id) };
  }

  /** C3.3 "Not the same buyer": the group is dismissed and its orders never group again. */
  async dismissGroup(ctx: TenantContext, groupId: string): Promise<{ memberCount: number }> {
    const now = this.#now();
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { group, members } = await this.#lockGroup(trx, ctx, groupId);
      const pairs: [string, string][] = [];
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++)
          pairs.push([members[i] ?? '', members[j] ?? '']);
      }
      await this.#exclude(trx, ctx, group.company_id, pairs, 'dismissed', now);
      await sql`UPDATE app.orders SET order_group_id = NULL
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_group_id = ${groupId}::uuid`.execute(
        trx,
      );
      await sql`UPDATE app.order_groups SET state = 'dismissed', ended_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${groupId}::uuid`.execute(
        trx,
      );
      return { memberCount: members.length };
    });
  }

  /** ADR-057: one order out of its group for good; the rest stay while two or more remain. */
  async removeMember(
    ctx: TenantContext,
    groupId: string,
    orderId: string,
  ): Promise<{ group: OrderGroupView; memberCount: number }> {
    const now = this.#now();
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { group, members } = await this.#lockGroup(trx, ctx, groupId);
      if (!members.includes(orderId)) throw new OrderGroupRefused('not_a_member');
      const rest = members.filter((m) => m !== orderId);
      await this.#exclude(
        trx,
        ctx,
        group.company_id,
        rest.map((m) => [orderId, m]),
        'removed',
        now,
      );
      await sql`UPDATE app.orders SET order_group_id = NULL
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderId}::uuid`.execute(
        trx,
      );
      await this.#closeSmall(trx, ctx, group.channel_account_id, now);
      const view = await this.#group(trx, ctx, groupId);
      if (view === undefined) throw new OrderGroupRefused('not_found');
      return { group: view, memberCount: rest.length };
    });
  }
}
