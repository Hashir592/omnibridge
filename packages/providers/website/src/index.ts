/**
 * The seller's own website as a ChannelAdapter (INT-1), thin in M07: an API key, the "updated
 * since" order read and the stock write. M11 defines the connector protocol in full; buyer fields
 * leave the parser only in an order's `buyer` block, which M10's ingest gives to pii-vault.
 */
import { Secret } from '@omnibridge/crypto';
import {
  defineParser,
  PenceAmount,
  readJson,
  type BuyerDetails,
  type ChannelAdapter,
  type ChannelOrder,
  type ChannelOrderState,
  type OrderSource,
  type ProviderHttp,
  type SyncStream,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

export const PACKAGE_NAME = '@omnibridge/provider-website';

/** An API key does not expire; the cache renews it daily anyway. */
const KEY_TTL_MS = 86_400_000;

const Text = z.string().max(4000).nullable().optional();
const When = z.iso.datetime({ offset: true });

/** Version 2 (M10): money, dates, refunds and the buyer block. Provisional until M11. */
const OrdersV1 = defineParser(
  'website',
  'orders',
  2,
  z.object({
    orders: z.array(
      z.object({
        id: z.string().min(1),
        created_at: When,
        updated_at: When,
        paid_at: When.nullable().optional(),
        shipped_at: When.nullable().optional(),
        delivered_at: When.nullable().optional(),
        cancelled_at: When.nullable().optional(),
        ship_by: When.nullable().optional(),
        status: z.string().min(1),
        currency: z.literal('GBP'),
        shipping_total: PenceAmount,
        discount_total: PenceAmount.optional(),
        customer: z
          .object({ id: Text, email: Text, phone: Text, name: Text })
          .nullable()
          .optional(),
        shipping_address: z
          .object({
            name: Text,
            line1: Text,
            line2: Text,
            city: Text,
            county: Text,
            postcode: Text,
            country: z.string().length(2).nullable().optional(),
            instructions: Text,
          })
          .nullable()
          .optional(),
        lines: z.array(
          z.object({
            id: z.string().min(1),
            sku: z.string().nullable(),
            quantity: z.number().int().min(1),
            name: z.string().max(500).nullable().optional(),
            total: PenceAmount,
          }),
        ),
        refunds: z
          .array(
            z.object({
              id: z.string().min(1),
              created_at: When,
              amount: PenceAmount,
              lines: z
                .array(
                  z.object({
                    line_id: z.string().min(1),
                    quantity: z.number().int().min(0),
                    amount: PenceAmount,
                  }),
                )
                .nullable()
                .optional(),
            }),
          )
          .optional(),
      }),
    ),
    next_cursor: z.string().nullable(),
  }),
);

type WebsiteOrder = ReturnType<typeof OrdersV1.parse>['orders'][number];

/** FA-10: the website's status onto the channel lifecycle (provisional until M11). */
function websiteState(o: WebsiteOrder): ChannelOrderState {
  if (o.status === 'cancelled') return 'cancelled';
  if (o.delivered_at !== null && o.delivered_at !== undefined) return 'delivered';
  if (o.status === 'shipped' || o.status === 'completed') return 'dispatched';
  if (o.shipped_at !== null && o.shipped_at !== undefined) return 'dispatched';
  if (o.status === 'pending') return 'pending_payment';
  return 'awaiting_dispatch';
}

/** The buyer block for pii-vault only (ORD-4); blank values are left out. */
function websiteBuyer(o: WebsiteOrder): BuyerDetails | null {
  const a = o.shipping_address;
  const entries = Object.entries({
    name: a?.name ?? o.customer?.name,
    email: o.customer?.email,
    phone: o.customer?.phone,
    address_line1: a?.line1,
    address_line2: a?.line2,
    city: a?.city,
    county: a?.county,
    postcode: a?.postcode,
    country: a?.country,
    delivery_instructions: a?.instructions,
    channel_buyer_id: o.customer?.id,
  }).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

const at = (v: string | null | undefined) => (v === null || v === undefined ? null : new Date(v));

function websiteOrder(o: WebsiteOrder): ChannelOrder {
  const state = websiteState(o);
  return {
    externalId: o.id,
    updatedAt: new Date(o.updated_at),
    status: o.status,
    state,
    placedAt: new Date(o.created_at),
    paidAt: at(o.paid_at),
    shipBy: at(o.ship_by),
    dispatchedAt: at(o.shipped_at),
    deliveredAt: at(o.delivered_at),
    cancelledAt: state === 'cancelled' ? (at(o.cancelled_at) ?? new Date(o.updated_at)) : null,
    discountPence: o.discount_total ?? 0,
    shippingPence: o.shipping_total,
    shipToCountry: o.shipping_address?.country ?? null,
    fba: false,
    lines: o.lines.map((l) => ({
      lineId: l.id,
      sku: l.sku,
      quantity: l.quantity,
      title: l.name ?? null,
      linePricePence: l.total,
    })),
    refunds: (o.refunds ?? []).map((r) => ({
      refundId: r.id,
      refundedAt: new Date(r.created_at),
      amountPence: r.amount,
      lines:
        r.lines === null || r.lines === undefined
          ? null
          : r.lines.map((l) => ({
              lineId: l.line_id,
              quantity: l.quantity,
              amountPence: l.amount,
            })),
    })),
    buyer: websiteBuyer(o),
  };
}
/** CAT-5: the products the website sells (provisional until M11 defines the protocol). */
const ProductsV1 = defineParser(
  'website',
  'products',
  1,
  z.object({
    products: z.array(
      z.object({
        id: z.string().min(1),
        sku: z.string().min(1),
        title: z.string().nullable().optional(),
        quantity: z.number().int().min(0).nullable().optional(),
      }),
    ),
    next_cursor: z.string().nullable(),
  }),
);
const StockV1 = defineParser('website', 'stock', 1, z.object({ updated: z.array(z.string()) }));

export function createWebsiteAdapter(options: {
  http: ProviderHttp;
  now?: () => Date;
}): ChannelAdapter & OrderSource {
  const now = options.now ?? (() => new Date());
  const base = options.http.base('website', 'api');
  return {
    provider: 'website',

    authenticate(credential) {
      return Promise.resolve({
        token: new Secret(credential.reveal()),
        expiresAt: new Date(now().getTime() + KEY_TTL_MS),
      });
    },

    async ordersUpdatedSince(token, since, page) {
      const url = new URL('api/orders', base);
      url.searchParams.set('updated_since', since.toISOString());
      if (page !== undefined) url.searchParams.set('cursor', page);
      const res = await options.http.request('website', {
        url,
        headers: { 'x-api-key': token.token.reveal() },
      });
      const body = OrdersV1.parse(await readJson('website', res));
      return { items: body.orders.map(websiteOrder), next: body.next_cursor ?? undefined };
    },

    async listListings(token, page) {
      const url = new URL('api/products', base);
      if (page !== undefined) url.searchParams.set('cursor', page);
      const res = await options.http.request('website', {
        url,
        headers: { 'x-api-key': token.token.reveal() },
      });
      const body = ProductsV1.parse(await readJson('website', res));
      return {
        items: body.products.map((p) => ({
          externalSku: p.sku,
          externalId: p.id,
          title: p.title ?? null,
          fulfilment: null,
          inventoryApi: null,
          quantity: p.quantity ?? null,
        })),
        next: body.next_cursor ?? undefined,
      };
    },

    async pushStock(token, levels) {
      const res = await options.http.request('website', {
        url: new URL('api/stock', base),
        method: 'POST',
        headers: { 'x-api-key': token.token.reveal(), 'content-type': 'application/json' },
        body: JSON.stringify({ items: levels.map((l) => ({ sku: l.sku, quantity: l.quantity })) }),
      });
      const updated = new Set(StockV1.parse(await readJson('website', res)).updated);
      return {
        accepted: levels.filter((l) => updated.has(l.sku)).map((l) => l.sku),
        refused: levels
          .filter((l) => !updated.has(l.sku))
          .map((l) => ({ sku: l.sku, code: 'website.not_updated' })),
      };
    },
  };
}

/** FA-16: how far back the first order poll of a new website account reads. */
export const WEBSITE_ORDER_BACKFILL_MS = 90 * 86_400_000;

/**
 * The `website.orders` stream (INT-8, M10): the website's "updated since" read through the same
 * vault-first prepare and sink as eBay. M11 adds the signed push alongside it.
 */
export function websiteOrderStream(
  adapter: Pick<ChannelAdapter, 'authenticate'> & OrderSource,
  ingest: Pick<SyncStream<ChannelOrder>, 'sink' | 'prepare'>,
): SyncStream<ChannelOrder> {
  return {
    stream: 'website.orders',
    provider: 'website',
    api: 'orders',
    lookbackMs: WEBSITE_ORDER_BACKFILL_MS,
    authenticate: (credential) => adapter.authenticate(credential),
    fetchPage: (token, since, page) => adapter.ordersUpdatedSince(token, since, page),
    ...(ingest.prepare === undefined ? {} : { prepare: ingest.prepare }),
    sink: ingest.sink,
  };
}
