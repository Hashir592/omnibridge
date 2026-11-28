import { z } from 'zod';
import { defineRoute } from '../route.ts';
import { ConnectionSchema } from './connections.ts';

/*
 * M11: the website connector (WEB-1 to WEB-6, OPS-12, AT-14) and the generic Disconnect.
 *
 * The website protocol is the contract between OmniBridge and a seller's own website, built on
 * the website's side by its own developers (WEB-6). Field names follow PRD 3.7 (camelCase). Money
 * is integer pence, VAT included ("Gross"), in GBP only. Times are ISO 8601 with a zone.
 *
 * Every call in either direction carries (WEB-2):
 * - `Authorization: Bearer <api key>`: the receiver's key for the caller;
 * - `X-OB-Timestamp`: Unix seconds; refused when more than 5 minutes off;
 * - `X-OB-Signature`: hex HMAC-SHA256, under the connection's signing secret, of
 *   `<timestamp> + "." + <raw body>`;
 * - `Idempotency-Key`: the same key and body give the same answer; the same key with another
 *   body is 409.
 *
 * Inbound calls are stored in the request, buyer details in pii-vault first (ADR-054, FA-04).
 * With the workspace's `website_connector` module off, every website route answers 404.
 */

export const WEBSITE_HEADERS = {
  timestamp: 'x-ob-timestamp',
  signature: 'x-ob-signature',
  idempotencyKey: 'idempotency-key',
} as const;
/** WEB-2: a timestamp more than this far from the receiver's clock is refused. */
export const WEBSITE_TIMESTAMP_WINDOW_S = 300;
/** WEB-4: stock is sent in batches of at most this many SKUs. */
export const WEBSITE_STOCK_BATCH_MAX = 100;
/** An order ID's limit: db-main keys a buyer by `<account id>:<order id>` in 200 characters. */
export const WEBSITE_ORDER_ID_MAX = 163;

const At = z.iso.datetime({ offset: true });
/** Text a person typed: no NUL, which PostgreSQL cannot store. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000]*$/, 'must not contain NUL');
const Id = text(200).min(1);
const OrderId = text(WEBSITE_ORDER_ID_MAX).min(1);
const Pence = z.number().int().min(0).max(1_000_000_000);
/** ISO 3166 alpha-2, upper case. */
const Country = z.string().regex(/^[A-Z]{2}$/);

// ---- Setup (WEB-1): admins, Connections tab --------------------------------------------------

const websiteSetup = {
  auth: 'session',
  tab: 'connections',
  adminOnly: true,
  companyScoped: true,
  module: 'website_connector',
} as const;
const AccountParams = z.object({ accountId: z.uuid() });
/** The website's own address for OmniBridge's calls: HTTPS only. */
const BaseUrl = z.url({ protocol: /^https$/ }).max(500);
const OutboundKey = z.string().min(16).max(512);

/** Shown once, when made: OmniBridge keeps only a hash of the key and the secret encrypted. */
export const WebsiteKeysSchema = z
  .object({
    /** The website sends it as `Authorization: Bearer <key>`. */
    inbound_api_key: z.string(),
    /** Both sides sign with it (WEB-2). */
    signing_secret: z.string(),
  })
  .meta({ id: 'WebsiteKeys' });

export const WebsiteSettingsSchema = z
  .object({
    /** The account: the `{connectionId}` in every inbound URL. */
    connection_id: z.uuid(),
    /** Where the website sends its calls (WEB-3). */
    inbound_url: z.url(),
    /** The website's base URL for OmniBridge's calls (WEB-4). */
    base_url: z.url(),
    /** The last 4 characters of the inbound key, to tell keys apart; never the key. */
    inbound_key_hint: z.string().length(4),
    keys_issued_at: At,
    /** Never the website's key itself. */
    outbound_key_set: z.boolean(),
  })
  .meta({ id: 'WebsiteSettings' });

/**
 * Creates a Website channel account under a company (WEB-1). Its stock writes are held until a
 * clean reconciliation (FA-16). The keys are in this answer only.
 */
export const createWebsiteConnection = defineRoute({
  id: 'createWebsiteConnection',
  method: 'POST',
  path: '/connections/website',
  summary: 'Connect a website',
  body: z
    .object({
      company_id: z.uuid(),
      display_name: z.string().trim().min(1).max(100),
      base_url: BaseUrl,
      /** The website's key for OmniBridge's calls (`Authorization: Bearer`). */
      outbound_api_key: OutboundKey,
    })
    .strict(),
  responses: {
    201: z
      .object({
        connection: ConnectionSchema,
        settings: WebsiteSettingsSchema,
        keys: WebsiteKeysSchema,
      })
      .meta({ id: 'WebsiteConnectionCreated' }),
  },
  ...websiteSetup,
});

export const getWebsiteSettings = defineRoute({
  id: 'getWebsiteSettings',
  method: 'GET',
  path: '/connections/:accountId/website',
  summary: "A website account's settings",
  params: AccountParams,
  responses: { 200: WebsiteSettingsSchema },
  ...websiteSetup,
});

/** Changes the base URL or the website's key; at least one. Audited. */
export const updateWebsiteSettings = defineRoute({
  id: 'updateWebsiteSettings',
  method: 'PUT',
  path: '/connections/:accountId/website',
  summary: "Change a website account's base URL or key",
  params: AccountParams,
  body: z
    .object({ base_url: BaseUrl.optional(), outbound_api_key: OutboundKey.optional() })
    .strict()
    .refine((b) => b.base_url !== undefined || b.outbound_api_key !== undefined, {
      message: 'Send base_url, outbound_api_key or both',
    }),
  responses: { 200: WebsiteSettingsSchema },
  ...websiteSetup,
});

/** New inbound key and signing secret, shown once; the old ones stop working at once. Audited. */
export const reissueWebsiteKeys = defineRoute({
  id: 'reissueWebsiteKeys',
  method: 'POST',
  path: '/connections/:accountId/website/keys',
  summary: 'Issue a new key and signing secret',
  params: AccountParams,
  responses: { 200: WebsiteKeysSchema },
  ...websiteSetup,
});

// ---- Disconnect (any channel account) --------------------------------------------------------

/**
 * Disconnects any channel account (T-1101): its listings end (C7.3), its writes stop and its
 * credentials are deleted; its orders, stock history and VAT records stay. Audited. Amazon's and
 * eBay's own deletion rules stay with their modules. Disconnecting again changes nothing.
 */
export const disconnectAccount = defineRoute({
  id: 'disconnectAccount',
  method: 'POST',
  path: '/connections/:accountId/disconnect',
  summary: 'Disconnect an account',
  params: AccountParams,
  responses: {
    200: z
      .object({
        connection: ConnectionSchema,
        /** Listings this disconnect ended; 0 when repeated. */
        listings_ended: z.number().int().min(0),
      })
      .meta({ id: 'AccountDisconnected' }),
  },
  auth: 'session',
  tab: 'connections',
  adminOnly: true,
  companyScoped: true,
});

// ---- The website protocol: shapes both sides share --------------------------------------------

/** WEB-3. How an order stands on the website. */
export const WebsiteOrderStatusSchema = z
  .enum(['pending', 'paid', 'shipped', 'delivered', 'cancelled'])
  .meta({ id: 'WebsiteOrderStatus' });

export const WebsiteOrderLineSchema = z
  .object({
    /** Stable for the life of the order: a changed SKU or quantity is a new line ID. */
    externalLineId: Id,
    externalSku: Id,
    title: text(500).nullable(),
    quantity: z.number().int().min(1).max(100_000),
    unitPriceGross: Pence,
  })
  .meta({ id: 'WebsiteOrderLine' });

export const WebsiteBuyerSchema = z
  .object({
    /** The website's own customer ID, if it has one. */
    customerId: text(200).nullable().optional(),
    name: text(200),
    email: text(320).nullable().optional(),
    phone: text(50).nullable().optional(),
  })
  .meta({ id: 'WebsiteBuyer' });

export const WebsiteAddressSchema = z
  .object({
    name: text(200),
    line1: text(200),
    line2: text(200).nullable().optional(),
    line3: text(200).nullable().optional(),
    line4: text(200).nullable().optional(),
    city: text(100),
    county: text(100).nullable().optional(),
    /** Optional outside the UK, where some countries have none. */
    postcode: text(20).nullable().optional(),
    country: Country,
    instructions: text(500).nullable().optional(),
  })
  .meta({ id: 'WebsiteAddress' });

/**
 * One whole order (WEB-3), as the website pushes it and as `GET /omnibridge/orders` lists it
 * (WEB-4). Each push replaces what OmniBridge holds for the order, under the rules for orders
 * before and after payment; one older than the last stored (`updatedAt`) changes nothing.
 */
export const WebsiteOrderSchema = z
  .object({
    externalOrderId: OrderId,
    status: WebsiteOrderStatusSchema,
    currency: z.literal('GBP'),
    placedAt: At,
    /** When the website last changed the order: newer replaces older. */
    updatedAt: At,
    paidAt: At.nullable().optional(),
    shipBy: At.nullable().optional(),
    shippedAt: At.nullable().optional(),
    deliveredAt: At.nullable().optional(),
    cancelledAt: At.nullable().optional(),
    lines: z.array(WebsiteOrderLineSchema).min(1).max(500),
    shippingGross: Pence,
    discountGross: Pence,
    /** What the website charged in all; a difference from the lines is marked on the order. */
    totalGross: Pence.nullable().optional(),
    buyer: WebsiteBuyerSchema,
    shippingAddress: WebsiteAddressSchema,
  })
  .meta({ id: 'WebsiteOrder' });

export const WebsiteRefundSchema = z
  .object({
    /** The website's refund ID: a repeat with the same ID changes nothing. */
    refundId: Id,
    amountGross: Pence.min(1),
    lines: z
      .array(
        z.object({
          externalLineId: Id,
          quantity: z.number().int().min(0).max(100_000),
          amountGross: Pence,
        }),
      )
      .max(500)
      .nullable()
      .optional(),
    reason: text(500).nullable().optional(),
    refundedAt: At,
  })
  .meta({ id: 'WebsiteRefund' });

/** WEB-4: `PUT /omnibridge/stock` on the website, in batches of at most 100. */
export const WebsiteStockBatchSchema = z
  .array(z.object({ externalSku: Id, quantity: z.number().int().min(0) }))
  .min(1)
  .max(WEBSITE_STOCK_BATCH_MAX)
  .meta({ id: 'WebsiteStockBatch' });

/** WEB-4: `POST /omnibridge/orders/{externalOrderId}/shipment` on the website. */
export const WebsiteShipmentSchema = z
  .object({
    carrier: text(50).min(1),
    service: text(100).min(1),
    trackingNumbers: z.array(text(100).min(1)).min(1).max(20),
    shippedAt: At,
  })
  .meta({ id: 'WebsiteShipment' });

/**
 * WEB-4: the website's answer to `GET /omnibridge/orders?updatedSince=<ISO>&cursor=<cursor>`,
 * oldest change first, used nightly to catch calls that never arrived.
 */
export const WebsiteOrdersPageSchema = z
  .object({ orders: z.array(WebsiteOrderSchema).max(200), nextCursor: text(500).nullable() })
  .meta({ id: 'WebsiteOrdersPage' });

// ---- Inbound routes (WEB-3): the website calls these, signed ---------------------------------

const websiteInbound = {
  auth: 'signed-webhook',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
  module: 'website_connector',
} as const;
const ConnectionParams = z.object({ connectionId: z.uuid() });
const OrderParams = ConnectionParams.extend({ externalOrderId: OrderId });

export const WebsiteStoredSchema = z
  .object({ omnibridgeOrderId: z.uuid() })
  .meta({ id: 'WebsiteStored' });

/**
 * Creates or updates one order by `externalOrderId`: 201 when it is new, 200 otherwise. 422 with
 * field errors when the body is not a valid order; 409 when the idempotency key was used for
 * another body.
 */
export const websitePushOrder = defineRoute({
  id: 'websitePushOrder',
  method: 'POST',
  path: '/v1/website/:connectionId/orders',
  summary: 'Website: create or update an order',
  params: ConnectionParams,
  body: WebsiteOrderSchema,
  responses: { 200: WebsiteStoredSchema, 201: WebsiteStoredSchema },
  ...websiteInbound,
});

/**
 * Cancels an order OmniBridge holds; its buyer details are deleted (DEL-1). 404 if unknown. An
 * order already shipped answers 409 `order_shipped` and changes nothing, so the website never
 * refunds a parcel that has left (ADR-088).
 */
export const websiteCancelOrder = defineRoute({
  id: 'websiteCancelOrder',
  method: 'POST',
  path: '/v1/website/:connectionId/orders/:externalOrderId/cancel',
  summary: 'Website: cancel an order',
  params: OrderParams,
  body: z
    .object({ cancelledAt: At, reason: text(500).nullable().optional() })
    .meta({ id: 'WebsiteCancel' }),
  responses: { 200: WebsiteStoredSchema },
  ...websiteInbound,
});

/** Records one refund (201; a repeat of the same refundId is 200 and changes nothing). */
export const websiteRefundOrder = defineRoute({
  id: 'websiteRefundOrder',
  method: 'POST',
  path: '/v1/website/:connectionId/orders/:externalOrderId/refunds',
  summary: 'Website: record a refund',
  params: OrderParams,
  body: WebsiteRefundSchema,
  responses: { 200: WebsiteStoredSchema, 201: WebsiteStoredSchema },
  ...websiteInbound,
});

/** Optional: the website's products, for mapping to master SKUs (CAT-5). */
export const websitePushProducts = defineRoute({
  id: 'websitePushProducts',
  method: 'POST',
  path: '/v1/website/:connectionId/products',
  summary: 'Website: send its products for mapping',
  params: ConnectionParams,
  body: z
    .object({
      products: z
        .array(
          z.object({
            externalSku: Id,
            title: text(500).nullable().optional(),
            quantity: z.number().int().min(0).nullable().optional(),
          }),
        )
        .min(1)
        .max(1000),
    })
    .meta({ id: 'WebsiteProducts' }),
  responses: {
    200: z.object({ received: z.number().int().min(0) }).meta({ id: 'WebsiteProductsReceived' }),
  },
  ...websiteInbound,
});

export const websiteRoutes = [
  createWebsiteConnection,
  getWebsiteSettings,
  updateWebsiteSettings,
  reissueWebsiteKeys,
  disconnectAccount,
  websitePushOrder,
  websiteCancelOrder,
  websiteRefundOrder,
  websitePushProducts,
] as const;
