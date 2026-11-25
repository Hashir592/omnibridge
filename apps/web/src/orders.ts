import { Readable } from 'node:stream';
import type { ordersRoutes } from '@omnibridge/contract';
import { pageOffset, pageResult, TOTAL_COUNT_CAP } from '@omnibridge/contract';
import {
  ApiError,
  formatLondonDateTime,
  formatPounds,
  pence,
  toCsv,
  toUtcIso,
  type TenantContext,
} from '@omnibridge/core';
import {
  OrderGroupRefused,
  type AuditLog,
  type OrderDetailView,
  type OrderFilter,
  type OrderGroupView,
  type OrderListRow,
  type OrderReads,
} from '@omnibridge/db';
import type { VaultClient } from '@omnibridge/vault-client';
import { UTF8_BOM } from './audit-csv.ts';
import type { Handlers } from './contract.ts';

/*
 * M10 order routes (T-1002: ORD-1, ORD-2, ORD-5 to ORD-9). db-main gives IDs and figures under the
 * user's company scope; pii-vault gives masked values for lists (computed now, never stored) and
 * the full record for the detail page, each full read logged by the vault and in the audit log
 * (ORD-5). The CSV export holds no PII at all, not even masked values (ORD-8).
 */

export interface OrdersOptions {
  reads: Pick<
    OrderReads,
    | 'filterVisible'
    | 'list'
    | 'exportRows'
    | 'detail'
    | 'customerRef'
    | 'setNotes'
    | 'returns'
    | 'group'
    | 'dismissGroup'
    | 'removeMember'
  >;
  /** The web token: mask, read_full (purpose order_detail) and search (purpose order_search). */
  vault: Pick<VaultClient, 'mask' | 'readFull' | 'search'>;
  audit: Pick<AuditLog, 'record'>;
}

/** The most rows one CSV export holds; narrow the filters beyond it (NFR-5). */
const MAX_EXPORT_ROWS = 50_000;
/** The vault masks at most this many refs per call. */
const MASK_BATCH = 200;

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));
const n = (v: bigint) => Number(v);
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

type ListQuery = {
  company_id?: string | undefined;
  channel_account_id?: string | undefined;
  status?: OrderFilter['status'];
  from?: string | undefined;
  to?: string | undefined;
  ship_by?: 'today' | 'overdue' | undefined;
  flag?: OrderFilter['flag'];
  q?: string | undefined;
};

const filterOf = (q: ListQuery): OrderFilter => ({
  companyId: q.company_id,
  channelAccountId: q.channel_account_id,
  status: q.status,
  from: q.from,
  to: q.to,
  shipBy: q.ship_by,
  flag: q.flag,
  q: q.q,
});

function rowBody(r: OrderListRow, masked: ReadonlyMap<string, Record<string, string>>) {
  const mask = r.piiRef === null ? undefined : masked.get(r.piiRef);
  return {
    id: r.id,
    provider: r.provider,
    channel_account_id: r.channelAccountId,
    channel_account_name: r.channelAccountName,
    company_id: r.companyId,
    order_ref: r.orderRef,
    placed_at: r.placedAt.toISOString(),
    first_sku: r.skus[0] ?? null,
    more_skus: r.skus.slice(1),
    status: r.status,
    raw_status: r.rawStatus,
    item_count: r.itemCount,
    total_gross_pence: n(r.grossPence),
    ship_by: iso(r.shipBy),
    shipping_status: null,
    tracking_state: null,
    flags: r.flags,
    customer_state: r.customer,
    buyer:
      r.customer === 'present'
        ? { name: mask?.name ?? null, postcode: mask?.postcode ?? null }
        : null,
    group: r.group,
  };
}

function groupBody(g: OrderGroupView) {
  return {
    id: g.id,
    channel_account_id: g.channelAccountId,
    state: g.state,
    members: g.members.map((m) => ({
      id: m.id,
      order_ref: m.orderRef,
      placed_at: m.placedAt.toISOString(),
      status: m.status,
      ship_by: iso(m.shipBy),
    })),
    warnings: g.warnings,
    earliest_ship_by: iso(g.earliestShipBy),
  };
}

function detailBody(d: OrderDetailView, masked: ReadonlyMap<string, Record<string, string>>) {
  return {
    ...rowBody(d, masked),
    paid_at: iso(d.paidAt),
    dispatched_at: iso(d.dispatchedAt),
    dispatch_estimated: d.dispatchEstimated,
    delivered_at: iso(d.deliveredAt),
    cancelled_at: iso(d.cancelledAt),
    tax_point_date: d.taxPointDate,
    ship_to_country: d.shipToCountry,
    lines: d.lines.map((l) => ({
      id: l.id,
      external_line_id: l.externalLineId,
      sku_id: l.skuId,
      sku: l.sku,
      external_sku: l.externalSku,
      title: l.title,
      quantity: l.quantity,
      unit_gross_pence: n(l.unitGrossPence),
      line_gross_pence: n(l.lineGrossPence),
      discount_pence: n(l.discountPence),
      shipping_pence: n(l.shippingPence),
      vat_type: l.vatType,
      vat_rate_bp: l.vatRateBp,
      vat_pence: n(l.vatPence),
      cogs_pence: l.cogsPence === null ? null : n(l.cogsPence),
      provisional: l.provisional,
      oversold: l.oversold,
    })),
    money: {
      goods_pence: n(d.money.goodsPence),
      discount_pence: n(d.money.discountPence),
      shipping_pence: n(d.money.shippingPence),
      gross_pence: n(d.money.grossPence),
      vat_pence: n(d.money.vatPence),
      net_pence: n(d.money.netPence),
      refunded_pence: n(d.money.refundedPence),
      refunded_vat_pence: n(d.money.refundedVatPence),
      vat_groups: d.money.vatGroups.map((g) => ({
        vat_type: g.vatType,
        rate_bp: g.rateBp,
        gross_pence: n(g.gross),
        vat_pence: n(g.vat),
        net_pence: n(g.net),
        provisional: g.provisional,
      })),
      amounts_differ: d.money.amountsDiffer,
    },
    history: d.history.map((h) => ({
      at: h.at.toISOString(),
      status: h.status,
      raw_status: h.rawStatus,
    })),
    refunds: d.refunds.map((r) => ({
      id: r.id,
      external_refund_id: r.externalRefundId,
      refunded_at: r.refundedAt.toISOString(),
      amount_pence: n(r.amountPence),
      vat_pence: n(r.vatPence),
      lines: r.lines.map((l) => ({
        order_line_id: l.orderLineId,
        sku: l.sku,
        quantity: l.quantity,
        amount_pence: n(l.amountPence),
      })),
      return_to_stock: r.returnToStock,
    })),
    notes: d.notes,
    notes_updated_at: iso(d.notesUpdatedAt),
    customer_deleted_at: iso(d.customerDeletedAt),
    same_buyer: d.sameBuyer === null ? null : groupBody(d.sameBuyer),
  };
}

export function ordersHandlers(options?: OrdersOptions): Handlers<typeof ordersRoutes> {
  if (options === undefined) {
    return {
      listOrders: notFound,
      searchOrders: notFound,
      exportOrders: notFound,
      getOrder: notFound,
      viewOrderCustomer: notFound,
      setOrderNotes: notFound,
      listReturns: notFound,
      dismissOrderGroup: notFound,
      removeOrderGroupMember: notFound,
    };
  }
  const o = options;

  /** A filter naming an account or company the user cannot see is a 404, never an empty list. */
  const checkFilter = async (tenant: TenantContext, f: OrderFilter) => {
    if (!(await o.reads.filterVisible(tenant, f))) {
      throw new ApiError({ status: 404, code: 'not_found' });
    }
  };

  /** ORD-5: masked values for the rows that still have buyer details; never stored. */
  const maskOf = async (tenant: TenantContext, rows: readonly OrderListRow[]) => {
    const refs = [...new Set(rows.flatMap((r) => (r.piiRef === null ? [] : [r.piiRef])))];
    const out = new Map<string, Record<string, string>>();
    for (let i = 0; i < refs.length; i += MASK_BATCH) {
      const { records } = await o.vault.mask(tenant.workspaceId, refs.slice(i, i + MASK_BATCH));
      for (const r of records) out.set(r.pii_ref, r.fields);
    }
    return out;
  };

  const page = async (
    tenant: TenantContext,
    f: OrderFilter,
    query: { page: number; limit: number },
  ) => {
    const { items, total } = await o.reads.list(
      tenant,
      f,
      { offset: pageOffset(query), limit: query.limit },
      TOTAL_COUNT_CAP + 1,
    );
    const masked = await maskOf(tenant, items);
    return {
      status: 200 as const,
      body: await pageResult({
        items: items.map((r) => rowBody(r, masked)),
        page: query.page,
        limit: query.limit,
        countUpTo: () => Promise.resolve(total),
      }),
    };
  };

  const groupRefused = (err: unknown): never => {
    if (err instanceof OrderGroupRefused) {
      if (err.code === 'not_open')
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'This group is no longer open.',
        });
      throw new ApiError({ status: 404, code: 'not_found' });
    }
    throw err;
  };

  return {
    listOrders: async ({ tenant, query }) => {
      const f = filterOf(query);
      await checkFilter(tenant, f);
      return page(tenant, f, query);
    },

    searchOrders: async ({ tenant, session, query, body }) => {
      const f = filterOf(query);
      await checkFilter(tenant, f);
      // ORD-2: the vault's blind index finds the orders while the PII exists; logged there.
      const found = await o.vault.search({
        workspaceId: tenant.workspaceId,
        purpose: 'order_search',
        query: {
          ...(body.buyer_name === undefined ? {} : { name: body.buyer_name }),
          ...(body.buyer_postcode === undefined ? {} : { postcode: body.buyer_postcode }),
        },
        actorUserId: session.userId,
      });
      // Never a partial list shown as whole: a search matching too many buyers must be narrowed.
      if (found.truncated) {
        throw new ApiError({
          status: 400,
          code: 'validation_failed',
          detail: 'Too many buyers match. Add more of the name or the full postcode.',
          errors: [{ location: 'body', path: 'buyer_name', message: 'Narrow the search' }],
        });
      }
      const piiRefs = found.matches.filter((m) => m.subject_type === 'order').map((m) => m.pii_ref);
      return page(tenant, { ...f, piiRefs }, query);
    },

    exportOrders: async ({ tenant, query }) => {
      const f = filterOf(query);
      await checkFilter(tenant, f);
      const rows = await o.reads.exportRows(tenant, f, MAX_EXPORT_ROWS);
      if (rows === undefined) {
        throw new ApiError({
          status: 400,
          code: 'validation_failed',
          detail: 'Too many orders for one export. Narrow the dates or filters.',
          errors: [{ location: 'query', path: 'from', message: 'Narrow the date range' }],
        });
      }
      // ORD-8: IDs, dates and figures only. No buyer value, not even a masked one.
      const text =
        UTF8_BOM +
        toCsv(
          [
            'order_ref',
            'channel',
            'channel_account',
            'placed_at_utc',
            'placed_at_london',
            'status',
            'channel_status',
            'skus',
            'items',
            'total_gross',
            'ship_by_london',
            'flags',
            'customer_details',
          ],
          rows.map((r) => [
            r.orderRef,
            r.provider,
            r.channelAccountName ?? '',
            toUtcIso(r.placedAt),
            formatLondonDateTime(r.placedAt),
            r.status,
            r.rawStatus,
            r.skus.join(' '),
            String(r.itemCount),
            formatPounds(pence(r.grossPence)),
            r.shipBy === null ? '' : formatLondonDateTime(r.shipBy),
            r.flags.join(' '),
            r.customer,
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

    getOrder: async ({ tenant, params }) => {
      const d = await o.reads.detail(tenant, params.orderId);
      if (d === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      return { status: 200, body: detailBody(d, await maskOf(tenant, [d])) };
    },

    viewOrderCustomer: async ({ tenant, session, params, request }) => {
      const ref = await o.reads.customerRef(tenant, params.orderId);
      if (ref === undefined || ref.piiRef === null) {
        throw new ApiError({ status: 404, code: 'not_found' });
      }
      // ORD-5: the vault logs the read with the user (DP-7); the audit log records user, order
      // and time, never a value.
      const full = await o.vault.readFull({
        workspaceId: tenant.workspaceId,
        piiRef: ref.piiRef,
        purpose: 'order_detail',
        actorUserId: session.userId,
      });
      await o.audit.record(tenant, {
        action: 'order.customer_viewed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.orderId,
        ip: request.ip,
      });
      const f = full.fields;
      const v = (k: string) => f[k] ?? null;
      return {
        status: 200,
        body: {
          name: v('name'),
          address_line1: v('address_line1'),
          address_line2: v('address_line2'),
          town: v('city'),
          county: v('county'),
          postcode: v('postcode'),
          country: v('country'),
          phone: v('phone'),
          email: v('email'),
          buyer_username: v('channel_username'),
          delivery_instructions: v('delivery_instructions'),
        },
      };
    },

    setOrderNotes: async ({ tenant, session, params, body, request }) => {
      const saved = await o.reads.setNotes(tenant, params.orderId, body.notes, session.userId);
      if (saved === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      await o.audit.record(tenant, {
        action: 'order.notes_changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.orderId,
        ip: request.ip,
      });
      return {
        status: 200,
        body: { notes: saved.notes, notes_updated_at: saved.updatedAt.toISOString() },
      };
    },

    listReturns: async ({ tenant, query }) => {
      const f = {
        companyId: query.company_id,
        channelAccountId: query.channel_account_id,
        from: query.from,
        to: query.to,
      };
      await checkFilter(tenant, f);
      const { items, total } = await o.reads.returns(
        tenant,
        f,
        { offset: pageOffset(query), limit: query.limit },
        TOTAL_COUNT_CAP + 1,
      );
      return {
        status: 200,
        body: await pageResult({
          items: items.map((r) => ({
            id: r.id,
            kind: 'refund' as const,
            order_id: r.orderId,
            order_ref: r.orderRef,
            provider: r.provider,
            channel_account_id: r.channelAccountId,
            channel_account_name: r.channelAccountName,
            company_id: r.companyId,
            at: r.at.toISOString(),
            amount_pence: n(r.amountPence),
            vat_pence: n(r.vatPence),
            skus: r.skus,
            return_to_stock: r.returnToStock,
            reason: null,
            return_status: null,
            a_to_z: null,
            claim_deadline_estimate: null,
          })),
          page: query.page,
          limit: query.limit,
          countUpTo: () => Promise.resolve(total),
        }),
      };
    },

    dismissOrderGroup: async ({ tenant, session, params, body, request }) => {
      const { memberCount } = await o.reads
        .dismissGroup(tenant, params.groupId)
        .catch(groupRefused);
      await o.audit.record(tenant, {
        action: 'order_group.dismissed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.groupId,
        after: { member_count: memberCount },
        reason: body.reason,
        ip: request.ip,
      });
      return { status: 204, body: null };
    },

    removeOrderGroupMember: async ({ tenant, session, params, body, request }) => {
      const { group, memberCount } = await o.reads
        .removeMember(tenant, params.groupId, params.orderId)
        .catch(groupRefused);
      await o.audit.record(tenant, {
        action: 'order_group.member_removed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.groupId,
        after: { order_id: params.orderId, member_count: memberCount },
        reason: body.reason,
        ip: request.ip,
      });
      return { status: 200, body: groupBody(group) };
    },
  };
}
