/**
 * PROPOSED SHAPES (mock only, T-0301). None of these routes exist in packages/contract yet.
 * When a screen is locked, S2 proposes the shape in docs/DECISIONS.md and S3 builds the real route.
 */

export type Channel = 'amazon' | 'ebay' | 'website';

export type OrderStatus =
  | 'pending_payment'
  | 'awaiting_dispatch'
  | 'label_created'
  | 'dispatched'
  | 'delivered'
  | 'cancelled'
  | 'partly_refunded'
  | 'refunded'
  | 'returned';

export type OrderFlag =
  'oversold' | 'unmapped' | 'address_shortened' | 'tracking_unconfirmed' | 'fba';

export type TrackingState = 'none' | 'pending' | 'pushed' | 'confirmed' | 'not_confirmed';

export type Tab =
  | 'home'
  | 'orders'
  | 'shipping'
  | 'stock'
  | 'customer_service'
  | 'account_health'
  | 'advertising'
  | 'sales_profit'
  | 'forecasting'
  | 'finance'
  | 'reminders'
  | 'notes';

export type CompanyHue =
  'teal' | 'violet' | 'cyan' | 'magenta' | 'olive' | 'brown' | 'indigo' | 'slate';

export interface Company {
  id: string;
  tradingName: string;
  code: string; // 3-letter badge text
  hue: CompanyHue;
}

export interface ChannelAccount {
  id: string;
  channel: Channel;
  name: string;
  companyId: string;
}

/** List row. `shipToMasked` is the only PII-derived field and is masked by pii-vault (ORD-5). */
export interface OrderRow {
  id: string;
  ref: string;
  channel: Channel;
  channelAccountId: string;
  companyId: string;
  placedAt: string; // UTC ISO
  shipBy: string; // UTC ISO
  status: OrderStatus;
  itemCount: number;
  totalPence: number;
  shipping: { carrier: string; service: string } | null;
  tracking: TrackingState;
  flags: OrderFlag[];
  shipToMasked: string;
  /** The delivery service the buyer paid for (C3 warnings, SHP-9 highest service). */
  delivery: 'standard' | 'next_day';
}

/** One SKU line of a list row (C2, ORD-1). An unmapped line carries its external SKU. */
export interface OrderSkuLine {
  sku: string;
  qty: number;
  mapped: boolean;
}

/** The same-buyer group a list row belongs to (C3, ORD-9). Order IDs only, never buyer data. */
export interface OrderRowGroup {
  id: string;
  size: number;
  /** 0 for the first member shown; members are adjacent, oldest first. */
  index: number;
  last: boolean;
  /** Members the current filters hide ("+1 related order not shown"). */
  hidden: number;
  warnings: string[];
  memberRefs: string[];
}

/** A list row as the orders route returns it: the row plus its SKU lines and group. */
export interface OrderListItem extends OrderRow {
  skus: OrderSkuLine[];
  group: OrderRowGroup | null;
}

export interface OrderCounts {
  all: number;
  awaiting: number;
  overdue: number;
  dueToday: number;
  flagged: number;
}

export interface OrderPage {
  items: OrderListItem[];
  nextCursor: number | null;
  total: number;
  counts: OrderCounts;
}

export interface Session {
  user: { name: string; initials: string; isAdmin: boolean; email: string };
  workspace: string;
  tabs: Tab[];
  companies: Company[];
  channelAccounts: ChannelAccount[];
}

export interface OrderLine {
  sku: string;
  externalSku: string;
  title: string;
  qty: number;
  unitPence: number;
  vatRate: number;
  mapped: boolean;
}

export interface OrderEvent {
  at: string;
  label: string;
  by: string;
}

/** Full buyer details. PII: returned only by the detail route, never cached or stored by the UI. */
export interface BuyerDetails {
  name: string;
  lines: string[];
  town: string;
  postcode: string;
  country: string;
  phone: string;
}

export interface OrderDetail {
  order: OrderRow;
  channelAccountName: string;
  lines: OrderLine[];
  money: {
    itemsGross: number;
    shippingPence: number;
    discountPence: number;
    totalPence: number;
    vatPence: number;
    feePence: number;
    labelPence: number;
    cogsPence: number;
    refundPence: number;
    /** Why the pence differ from the channel's (contract `money.amounts_differ`). */
    amountsDiffer: Array<'channel_total' | 'late_change' | 'refund_above'>;
  };
  dispatchedAt: string | null;
  /** `dispatchedAt` is a stand-in: the channel gave no dispatch time. */
  dispatchEstimated: boolean;
  history: OrderEvent[];
  label: { carrier: string; service: string; trackingNumber: string; createdAt: string } | null;
  notes: Array<{ at: string; by: string; text: string }>;
  buyer: BuyerDetails;
  /** The other orders of this order's same-buyer group (C3 "Same buyer" panel). */
  sameBuyer: Array<{ id: string; ref: string; placedAt: string; totalPence: number }>;
}
