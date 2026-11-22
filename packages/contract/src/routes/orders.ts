import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { pagedOf, pageQuery } from '../pages.ts';
import { defineRoute } from '../route.ts';
import { ProviderSchema } from './connections.ts';

/*
 * M10: orders and sales VAT (ORD-1 to ORD-9, VAT-1 to VAT-7). Orders, lines and refunds are
 * company-scoped (ARCHITECTURE 6.1): Combined means the user's permitted companies only. db-main
 * holds no buyer PII (ORD-4); masked values come from pii-vault on request and are never stored
 * (ORD-5), and the full record is read only through `viewOrderCustomer`, which is logged.
 * Money is integer pence, VAT rates are basis points (2000 = 20%). Buyer search goes in a POST
 * body, never a query string, so no name or postcode reaches an access log (invariant 7).
 */

const ordersTab = {
  auth: 'session',
  tab: 'orders',
  adminOnly: false,
  companyScoped: true,
} as const;

const At = z.iso.datetime();
const Day = z.iso.date();
const Pence = z.number().int().min(0).max(1_000_000_000);
const BasisPoints = z.number().int().min(0).max(10_000);
const OrderParams = z.object({ orderId: z.uuid() });
const NoBody = z.null();

/** ORD-3: normalised statuses. The channel's own status is kept beside it as `raw_status`. */
export const OrderStatusSchema = z
  .enum([
    'pending_payment',
    'awaiting_dispatch',
    'label_created',
    'dispatched',
    'delivered',
    'cancelled',
    'partly_refunded',
    'refunded',
    'returned',
  ])
  .meta({ id: 'OrderStatus' });

/** ORD-1 flags. `tracking_not_confirmed` is set from M12. */
export const OrderFlagSchema = z
  .enum(['oversold', 'unmapped', 'address_shortened', 'tracking_not_confirmed', 'fba'])
  .meta({ id: 'OrderFlag' });

/** VAT-4: zero-rated and No VAT both carry 0 VAT but are always reported apart. */
export const SaleVatTypeSchema = z
  .enum(['standard', 'reduced', 'zero', 'no_vat'])
  .meta({ id: 'SaleVatType' });

/**
 * Whether the buyer's details exist in pii-vault: `present`, `deleted` (gone under the 30-day
 * rule, a cancellation or an erasure; ORD-6), or `none` (never held, for example an order older
 * than the PII window at cutover, FA-16).
 */
export const CustomerStateSchema = z
  .enum(['present', 'deleted', 'none'])
  .meta({ id: 'CustomerState' });

/** ORD-5: masked values for lists, for example "J. S***" and "G2". Computed on request. */
export const MaskedBuyerSchema = z
  .object({ name: z.string().nullable(), postcode: z.string().nullable() })
  .meta({ id: 'MaskedBuyer' });

/** ORD-9: where a row sits in its same-buyer group (C3.3). Members are adjacent rows. */
export const OrderGroupRefSchema = z
  .object({
    id: z.uuid(),
    size: z.number().int().min(2).max(20),
    /** 1 for the earliest member, which carries the "Same buyer · N orders" chip. */
    position: z.number().int().min(1),
    /** Members the current filters hide ("+1 related order not shown"). */
    hidden: z.number().int().min(0),
  })
  .meta({ id: 'OrderGroupRef' });

export const OrderRowSchema = z
  .object({
    id: z.uuid(),
    provider: ProviderSchema,
    channel_account_id: z.uuid(),
    /** Null when the user cannot see the account's company (ARCHITECTURE 6.1). */
    channel_account_name: z.string().nullable(),
    company_id: z.uuid(),
    /** The channel's order reference. */
    order_ref: z.string(),
    placed_at: At,
    /** ORD-1 / C2: the first line's Master SKU (or the channel SKU when unmapped). */
    first_sku: z.string().nullable(),
    /** The other lines' SKUs, for the "+N" tooltip. */
    more_skus: z.array(z.string()),
    status: OrderStatusSchema,
    raw_status: z.string(),
    item_count: z.number().int().min(0),
    total_gross_pence: Pence,
    ship_by: At.nullable(),
    /** M12 fills these; null until then. */
    shipping_status: z.string().nullable(),
    tracking_state: z.enum(['pending', 'confirmed', 'not_confirmed']).nullable(),
    flags: z.array(OrderFlagSchema),
    customer_state: CustomerStateSchema,
    /** Null unless `customer_state` is `present`. */
    buyer: MaskedBuyerSchema.nullable(),
    group: OrderGroupRefSchema.nullable(),
  })
  .meta({ id: 'OrderRow' });

/** ORD-2 filters. Dates are London calendar days, inclusive, on the placed date. */
const orderFilter = {
  company_id: z.uuid().optional(),
  channel_account_id: z.uuid().optional(),
  status: OrderStatusSchema.optional(),
  from: Day.optional(),
  to: Day.optional(),
  ship_by: z.enum(['today', 'overdue']).optional(),
  flag: OrderFlagSchema.optional(),
  /** Order reference or SKU (Master or channel), case-insensitive. Never buyer details. */
  q: z.string().trim().min(1).max(100).optional(),
};

export const OrderLineSchema = z
  .object({
    id: z.uuid(),
    external_line_id: z.string(),
    /** Null while the listing is unmapped (CAT-6). */
    sku_id: z.uuid().nullable(),
    sku: z.string().nullable(),
    external_sku: z.string().nullable(),
    title: z.string().nullable(),
    quantity: z.number().int().min(1),
    unit_gross_pence: Pence,
    line_gross_pence: Pence,
    /** This line's share of the order discount and shipping (VAT-3, FA-12). */
    discount_pence: Pence,
    shipping_pence: Pence,
    /** Write-once snapshots (FA-11). Null type while unmapped: the line counts at `vat_rate_bp`. */
    vat_type: SaleVatTypeSchema.nullable(),
    vat_rate_bp: BasisPoints,
    vat_pence: Pence,
    cogs_pence: Pence.nullable(),
    /** True while the line counts at the workspace default rate (unmapped, FA-11, PRF-5). */
    provisional: z.boolean(),
    oversold: z.boolean(),
  })
  .meta({ id: 'OrderLine' });

/** VAT-3: one rate group's totals after discount and shipping, VAT rounded once on the group. */
export const VatGroupSchema = z
  .object({
    vat_type: SaleVatTypeSchema.nullable(),
    rate_bp: BasisPoints,
    gross_pence: Pence,
    vat_pence: Pence,
    net_pence: Pence,
    provisional: z.boolean(),
  })
  .meta({ id: 'VatGroup' });

export const RefundSchema = z
  .object({
    id: z.uuid(),
    external_refund_id: z.string(),
    refunded_at: At,
    amount_pence: Pence,
    /** VAT-5: output VAT reduced by this refund, at the original rates. */
    vat_pence: Pence,
    lines: z.array(
      z.object({
        order_line_id: z.uuid(),
        sku: z.string().nullable(),
        quantity: z.number().int().min(0),
        amount_pence: Pence,
      }),
    ),
    return_to_stock: z.boolean(),
  })
  .meta({ id: 'Refund' });

export const OrderHistoryEntrySchema = z
  .object({
    at: At,
    /** Null when the update was kept but did not move the status (FA-10: never backwards). */
    status: OrderStatusSchema.nullable(),
    raw_status: z.string(),
  })
  .meta({ id: 'OrderHistoryEntry' });

export const OrderGroupMemberSchema = z
  .object({
    id: z.uuid(),
    order_ref: z.string(),
    placed_at: At,
    status: OrderStatusSchema,
    ship_by: At.nullable(),
  })
  .meta({ id: 'OrderGroupMember' });

export const OrderGroupSchema = z
  .object({
    id: z.uuid(),
    channel_account_id: z.uuid(),
    state: z.enum(['open', 'dismissed', 'closed']),
    /** Every member the user can see, by placed time. */
    members: z.array(OrderGroupMemberSchema),
    /** C3.3 warnings; they never block the group. */
    warnings: z.array(
      z.enum(['different_ship_by', 'different_service', 'address_shortened', 'unmapped']),
    ),
    /** The earliest member's ship-by date ("Ship by the earliest"). */
    earliest_ship_by: At.nullable(),
  })
  .meta({ id: 'OrderGroup' });

export const OrderDetailSchema = OrderRowSchema.extend({
  paid_at: At.nullable(),
  dispatched_at: At.nullable(),
  delivered_at: At.nullable(),
  cancelled_at: At.nullable(),
  /** VAT-1: the London date the order was placed; it decides the VAT quarter. */
  tax_point_date: Day,
  ship_to_country: z.string().length(2).nullable(),
  lines: z.array(OrderLineSchema),
  money: z.object({
    goods_pence: Pence,
    discount_pence: Pence,
    shipping_pence: Pence,
    gross_pence: Pence,
    vat_pence: Pence,
    net_pence: Pence,
    refunded_pence: Pence,
    refunded_vat_pence: Pence,
    vat_groups: z.array(VatGroupSchema),
  }),
  history: z.array(OrderHistoryEntrySchema),
  refunds: z.array(RefundSchema),
  /** Internal notes (ORD-6). The screen warns: no customer details. */
  notes: z.string().nullable(),
  notes_updated_at: At.nullable(),
  /** ORD-6: "Customer details deleted on {date} under the 30-day rule". */
  customer_deleted_at: At.nullable(),
  /** The "Same buyer" panel (C3.3); null when the order is in no open group. */
  same_buyer: OrderGroupSchema.nullable(),
}).meta({ id: 'OrderDetail' });

/** The full buyer record from pii-vault (ORD-4, DP-5). Each read is logged (ORD-5). */
export const OrderCustomerSchema = z
  .object({
    name: z.string().nullable(),
    address_line1: z.string().nullable(),
    address_line2: z.string().nullable(),
    town: z.string().nullable(),
    county: z.string().nullable(),
    postcode: z.string().nullable(),
    country: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    buyer_username: z.string().nullable(),
    delivery_instructions: z.string().nullable(),
  })
  .meta({ id: 'OrderCustomer' });

/** ORD-7: refunds from every channel now; Amazon returns report rows join in M18. */
export const ReturnRowSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['refund', 'amazon_return']),
    order_id: z.uuid(),
    order_ref: z.string(),
    provider: ProviderSchema,
    channel_account_id: z.uuid(),
    channel_account_name: z.string().nullable(),
    company_id: z.uuid(),
    at: At,
    amount_pence: Pence,
    vat_pence: Pence,
    skus: z.array(z.string()),
    return_to_stock: z.boolean(),
    /** Amazon returns only (M18): reason, status, A-to-z flag and the claim deadline estimate. */
    reason: z.string().nullable(),
    return_status: z.string().nullable(),
    a_to_z: z.boolean().nullable(),
    claim_deadline_estimate: Day.nullable(),
  })
  .meta({ id: 'ReturnRow' });

const GroupReason = z.string().trim().min(1).max(500);

// ---- List, search and export (ORD-1, ORD-2, ORD-5, ORD-8) --------------------------------------

/**
 * Every order the user may see, newest first. A same-buyer group sorts as one unit by its earliest
 * member, and a page never splits a group, so a page may run over `limit` rows (C3.3).
 */
export const listOrders = defineRoute({
  id: 'listOrders',
  method: 'GET',
  path: '/orders',
  summary: 'List orders across channels and permitted companies',
  query: pageQuery.extend(orderFilter),
  responses: { 200: pagedOf(OrderRowSchema) },
  ...ordersTab,
});

/**
 * ORD-2: the list filtered by buyer name or postcode as well. Works only while the PII exists
 * (pii-vault blind-index search); a POST so the values never sit in a URL or an access log.
 */
export const searchOrders = defineRoute({
  id: 'searchOrders',
  method: 'POST',
  path: '/orders/search',
  summary: 'Search orders by buyer name or postcode',
  query: pageQuery.extend(orderFilter),
  body: z
    .object({
      buyer_name: z.string().trim().min(2).max(100).optional(),
      buyer_postcode: z.string().trim().min(2).max(10).optional(),
    })
    .strict()
    .refine((b) => b.buyer_name !== undefined || b.buyer_postcode !== undefined, {
      message: 'buyer_name or buyer_postcode is required',
    }),
  responses: { 200: pagedOf(OrderRowSchema) },
  ...ordersTab,
});

/** ORD-8: the list as CSV with the same filters. It holds no PII, not even masked values. */
export const exportOrders = defineRoute({
  id: 'exportOrders',
  method: 'GET',
  path: '/orders/export',
  summary: 'Export orders as CSV (no customer details)',
  query: z.object(orderFilter),
  responses: { 200: FileDownloadSchema },
  ...ordersTab,
});

// ---- Detail (ORD-6, ORD-5) ---------------------------------------------------------------------

export const getOrder = defineRoute({
  id: 'getOrder',
  method: 'GET',
  path: '/orders/:orderId',
  summary: 'Order detail: lines, money, VAT groups, history, refunds and notes',
  params: OrderParams,
  responses: { 200: OrderDetailSchema },
  ...ordersTab,
});

/**
 * ORD-5: the buyer's full details, read from pii-vault and logged (user, order, time). A POST
 * because every call is a logged access. 404 when the details are gone or were never held.
 */
export const viewOrderCustomer = defineRoute({
  id: 'viewOrderCustomer',
  method: 'POST',
  path: '/orders/:orderId/customer',
  summary: "Show the buyer's full details (logged)",
  params: OrderParams,
  responses: { 200: OrderCustomerSchema },
  ...ordersTab,
});

export const setOrderNotes = defineRoute({
  id: 'setOrderNotes',
  method: 'PUT',
  path: '/orders/:orderId/notes',
  summary: 'Save the internal notes on an order',
  params: OrderParams,
  body: z.object({ notes: z.string().max(2000) }).strict(),
  responses: { 200: z.object({ notes: z.string().nullable(), notes_updated_at: At }) },
  ...ordersTab,
});

// ---- Returns (ORD-7) ---------------------------------------------------------------------------

export const listReturns = defineRoute({
  id: 'listReturns',
  method: 'GET',
  path: '/returns',
  summary: 'Refunds and returns from every channel, newest first (read-only)',
  query: pageQuery.extend({
    company_id: z.uuid().optional(),
    channel_account_id: z.uuid().optional(),
    from: Day.optional(),
    to: Day.optional(),
  }),
  responses: { 200: pagedOf(ReturnRowSchema) },
  ...ordersTab,
});

// ---- Same-buyer groups (ORD-9, C3, ADR-057) ----------------------------------------------------

/** "Not the same buyer": the group is dismissed and these orders are never grouped again. */
export const dismissOrderGroup = defineRoute({
  id: 'dismissOrderGroup',
  method: 'POST',
  path: '/order-groups/:groupId/dismiss',
  summary: 'Dismiss a same-buyer group as not the same buyer',
  params: z.object({ groupId: z.uuid() }),
  body: z.object({ reason: GroupReason }).strict(),
  responses: { 204: NoBody },
  ...ordersTab,
});

/**
 * ADR-057: take one order out of its group for good. The rest stay grouped while two or more
 * remain; otherwise the group closes. Returns the group as it now stands.
 */
export const removeOrderGroupMember = defineRoute({
  id: 'removeOrderGroupMember',
  method: 'POST',
  path: '/order-groups/:groupId/members/:orderId/remove',
  summary: 'Remove one order from its same-buyer group',
  params: z.object({ groupId: z.uuid(), orderId: z.uuid() }),
  body: z.object({ reason: GroupReason }).strict(),
  responses: { 200: OrderGroupSchema },
  ...ordersTab,
});

export const ordersRoutes = [
  listOrders,
  searchOrders,
  exportOrders,
  getOrder,
  viewOrderCustomer,
  setOrderNotes,
  listReturns,
  dismissOrderGroup,
  removeOrderGroupMember,
] as const;
