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
}

export interface OrderCounts {
  all: number;
  awaiting: number;
  overdue: number;
  dueToday: number;
  flagged: number;
}

export interface OrderPage {
  items: OrderRow[];
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
  };
  history: OrderEvent[];
  label: { carrier: string; service: string; trackingNumber: string; createdAt: string } | null;
  notes: Array<{ at: string; by: string; text: string }>;
  buyer: BuyerDetails;
}
