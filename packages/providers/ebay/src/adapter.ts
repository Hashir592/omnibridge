/**
 * eBay as a ChannelAdapter (INT-1), the M07 reference adapter: user tokens from the refresh token,
 * the Fulfillment API's "updated since" order read (INT-8) and the Inventory API's stock write.
 * Every answer goes through a versioned parser (INT-5). Buyer fields leave this file only in an
 * order's `buyer` block, which the M10 ingest hands to pii-vault and never stores in db-main.
 */
import { Secret } from '@omnibridge/crypto';
import {
  AuthFailed,
  defineParser,
  ProviderRejected,
  RateLimited,
  readJson,
  GbpAmount,
  type AccessToken,
  type BuyerDetails,
  type ChannelAdapter,
  type ChannelOrder,
  type ChannelOrderState,
  type ListingInfo,
  type OrderSource,
  type Page,
  type ProviderHttp,
  type StockLevel,
  type SyncStream,
  type TokenGrant,
  type WriteResult,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

/** User scopes the M07 calls need (sell.fulfillment and sell.inventory). */
export const EBAY_USER_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
] as const;

/** eBay API names as the governor and usage rows count them (EBAY-8). */
export const EBAY_APIS = {
  identity: 'identity.user_token',
  orders: 'sell.fulfillment',
  inventory: 'sell.inventory',
} as const;

const TokenV1 = defineParser(
  'ebay',
  'user_token',
  1,
  z.object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
  }),
);

const Text = z.string().max(4000).optional();
const When = z.iso.datetime({ offset: true });

/**
 * The Fulfillment API's getOrders (M10: money, dates, refunds and the ship-to block). Version 2:
 * version 1 read IDs and quantities only. Provisional until T-1501 checks it against eBay's spec.
 */
export const EbayOrdersV1 = defineParser(
  'ebay',
  'orders',
  2,
  z.object({
    next: z.string().optional(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    orders: z.array(
      z.object({
        orderId: z.string().min(1),
        creationDate: When,
        lastModifiedDate: When,
        orderFulfillmentStatus: z.string().min(1),
        orderPaymentStatus: z.string().min(1),
        cancelStatus: z.object({ cancelState: z.string().optional() }).optional(),
        buyer: z.object({ username: Text }).optional(),
        pricingSummary: z.object({
          deliveryCost: GbpAmount.optional(),
          priceDiscount: GbpAmount.optional(),
          total: GbpAmount,
        }),
        paymentSummary: z
          .object({
            payments: z.array(z.object({ paymentDate: When.optional() })).optional(),
            refunds: z
              .array(
                z.object({
                  refundId: z.string().min(1),
                  refundDate: When,
                  refundStatus: z.string().optional(),
                  amount: GbpAmount,
                }),
              )
              .optional(),
          })
          .optional(),
        fulfillmentStartInstructions: z
          .array(
            z.object({
              shippingStep: z
                .object({
                  shipTo: z
                    .object({
                      fullName: Text,
                      email: Text,
                      primaryPhone: z.object({ phoneNumber: Text }).optional(),
                      contactAddress: z
                        .object({
                          addressLine1: Text,
                          addressLine2: Text,
                          city: Text,
                          stateOrProvince: Text,
                          postalCode: Text,
                          countryCode: z.string().length(2).optional(),
                        })
                        .optional(),
                    })
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
        lineItems: z.array(
          z.object({
            lineItemId: z.string().min(1),
            sku: z.string().optional(),
            title: z.string().max(500).optional(),
            quantity: z.number().int().min(1),
            lineItemCost: GbpAmount,
            lineItemFulfillmentInstructions: z.object({ shipByDate: When.optional() }).optional(),
          }),
        ),
      }),
    ),
  }),
);

type EbayOrder = ReturnType<typeof EbayOrdersV1.parse>['orders'][number];

/** FA-10: eBay's fulfilment, payment and cancel states onto the channel lifecycle. */
function ebayState(o: EbayOrder): ChannelOrderState {
  if (o.cancelStatus?.cancelState === 'CANCELED') return 'cancelled';
  if (o.orderFulfillmentStatus === 'FULFILLED') return 'dispatched';
  if (o.orderPaymentStatus === 'PENDING' || o.orderPaymentStatus === 'FAILED') {
    return 'pending_payment';
  }
  return 'awaiting_dispatch';
}

/** The ship-to block and username, for pii-vault only (ORD-4). Blank values are left out. */
function ebayBuyer(o: EbayOrder): BuyerDetails | null {
  const to = o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const a = to?.contactAddress;
  const entries = Object.entries({
    name: to?.fullName,
    email: to?.email,
    phone: to?.primaryPhone?.phoneNumber,
    address_line1: a?.addressLine1,
    address_line2: a?.addressLine2,
    city: a?.city,
    county: a?.stateOrProvince,
    postcode: a?.postalCode,
    country: a?.countryCode,
    channel_username: o.buyer?.username,
  }).filter((e): e is [string, string] => e[1] !== undefined && e[1].trim() !== '');
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

function ebayOrder(o: EbayOrder): ChannelOrder {
  const state = ebayState(o);
  const paid = o.paymentSummary?.payments?.find((p) => p.paymentDate !== undefined)?.paymentDate;
  const shipBy = o.lineItems
    .map((l) => l.lineItemFulfillmentInstructions?.shipByDate)
    .filter((d): d is string => d !== undefined)
    .sort()[0];
  return {
    externalId: o.orderId,
    updatedAt: new Date(o.lastModifiedDate),
    status: [o.orderFulfillmentStatus, o.orderPaymentStatus, o.cancelStatus?.cancelState]
      .filter((v) => v !== undefined && v !== 'NONE_REQUESTED')
      .join('/'),
    state,
    placedAt: new Date(o.creationDate),
    paidAt:
      paid !== undefined
        ? new Date(paid)
        : state === 'pending_payment'
          ? null
          : new Date(o.creationDate),
    shipBy: shipBy === undefined ? null : new Date(shipBy),
    // getOrders has no dispatch time: the update that first shows FULFILLED stands in for it.
    // M12 records its own dispatch time for labels it makes.
    dispatchedAt: state === 'dispatched' ? new Date(o.lastModifiedDate) : null,
    deliveredAt: null,
    cancelledAt: state === 'cancelled' ? new Date(o.lastModifiedDate) : null,
    discountPence: o.pricingSummary.priceDiscount ?? 0,
    shippingPence: o.pricingSummary.deliveryCost ?? 0,
    shipToCountry:
      o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.countryCode ??
      null,
    fba: false,
    lines: o.lineItems.map((l) => ({
      lineId: l.lineItemId,
      sku: l.sku ?? null,
      quantity: l.quantity,
      title: l.title ?? null,
      linePricePence: l.lineItemCost,
    })),
    refunds: (o.paymentSummary?.refunds ?? [])
      .filter((r) => r.refundStatus === undefined || r.refundStatus === 'REFUNDED')
      .map((r) => ({
        refundId: r.refundId,
        refundedAt: new Date(r.refundDate),
        amountPence: r.amount,
        lines: null,
      })),
    buyer: ebayBuyer(o),
  };
}

/** CAT-5: the Inventory API's items (SKU, title, quantity); M15 checks it against eBay's spec. */
export const EbayInventoryItemsV1 = defineParser(
  'ebay',
  'inventory_items',
  1,
  z.object({
    next: z.string().optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).optional(),
    inventoryItems: z
      .array(
        z.object({
          sku: z.string().min(1),
          product: z.object({ title: z.string().optional() }).optional(),
          availability: z
            .object({
              shipToLocationAvailability: z
                .object({ quantity: z.number().int().min(0).optional() })
                .optional(),
            })
            .optional(),
        }),
      )
      .default([]),
  }),
);

const BulkUpdateV1 = defineParser(
  'ebay',
  'bulk_update',
  1,
  z.object({
    responses: z.array(
      z.object({
        statusCode: z.number().int(),
        sku: z.string(),
        errors: z.array(z.object({ errorId: z.number().int() })).optional(),
      }),
    ),
  }),
);

export interface EbayAdapterOptions {
  http: ProviderHttp;
  clientId: Secret;
  clientSecret: Secret;
  /** The RuName eBay sends the browser back to (the OAuth redirect_uri). */
  ruName?: string;
  pageSize?: number;
  now?: () => Date;
}

/** eBay's daily call limit is spent (HTTP 429): nothing more of this API today (EBAY-8). */
async function ebayJson(res: Response): Promise<unknown> {
  if (res.status === 429) {
    await res.body?.cancel();
    throw new RateLimited('ebay', { daily: true });
  }
  return readJson('ebay', res);
}

export function createEbayAdapter(options: EbayAdapterOptions): ChannelAdapter &
  OrderSource & {
    exchangeCode(code: string): Promise<TokenGrant>;
  } {
  const now = options.now ?? (() => new Date());
  const base = options.http.base('ebay', 'api');
  const basic = () =>
    `Basic ${Buffer.from(`${options.clientId.reveal()}:${options.clientSecret.reveal()}`).toString('base64')}`;

  async function token(body: URLSearchParams): Promise<ReturnType<typeof TokenV1.parse>> {
    const res = await options.http.request('ebay', {
      url: new URL('identity/v1/oauth2/token', base),
      method: 'POST',
      headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.status === 400) {
      const err = (await res.json().catch(() => ({}))) as { error?: unknown };
      // invalid_grant: the refresh token or code will never work again (EBAY-5).
      if (err.error === 'invalid_grant') throw new AuthFailed('ebay', true);
      throw new ProviderRejected('ebay', 'http_400');
    }
    return TokenV1.parse(await ebayJson(res));
  }

  const bearer = (t: AccessToken) => ({ authorization: `Bearer ${t.token.reveal()}` });
  const expiry = (seconds: number) => new Date(now().getTime() + seconds * 1000);

  return {
    provider: 'ebay',

    async authenticate(credential) {
      const t = await token(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.reveal(),
          scope: EBAY_USER_SCOPES.join(' '),
        }),
      );
      return { token: new Secret(t.access_token), expiresAt: expiry(t.expires_in) };
    },

    async exchangeCode(code) {
      const t = await token(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: options.ruName ?? '',
        }),
      );
      if (t.refresh_token === undefined) throw new AuthFailed('ebay', true);
      return {
        token: new Secret(t.access_token),
        expiresAt: expiry(t.expires_in),
        refreshToken: new Secret(t.refresh_token),
        refreshTokenExpiresAt:
          t.refresh_token_expires_in === undefined ? null : expiry(t.refresh_token_expires_in),
      };
    },

    async ordersUpdatedSince(access, since, page): Promise<Page<ChannelOrder>> {
      const url = new URL('sell/fulfillment/v1/order', base);
      url.searchParams.set('filter', `lastmodifieddate:[${since.toISOString()}..]`);
      url.searchParams.set('limit', String(options.pageSize ?? 200));
      url.searchParams.set('offset', page ?? '0');
      const res = await options.http.request('ebay', { url, headers: bearer(access) });
      const body = EbayOrdersV1.parse(await ebayJson(res));
      return {
        items: body.orders.map(ebayOrder),
        next: body.next === undefined ? undefined : String(body.offset + body.limit),
      };
    },

    async listListings(access, page): Promise<Page<ListingInfo>> {
      const limit = options.pageSize ?? 200;
      const offset = Number(page ?? '0');
      const url = new URL('sell/inventory/v1/inventory_item', base);
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('offset', String(offset));
      const res = await options.http.request('ebay', { url, headers: bearer(access) });
      const body = EbayInventoryItemsV1.parse(await ebayJson(res));
      return {
        // An Inventory API item is keyed by its SKU; its offer's listing ID arrives with M15.
        items: body.inventoryItems.map((i) => ({
          externalSku: i.sku,
          externalId: i.sku,
          title: i.product?.title ?? null,
          fulfilment: null,
          inventoryApi: true,
          quantity: i.availability?.shipToLocationAvailability?.quantity ?? null,
        })),
        // The page eBay actually served, which may be smaller than the one asked for.
        next:
          body.next === undefined
            ? undefined
            : String((body.offset ?? offset) + (body.limit ?? limit)),
      };
    },

    async pushStock(access, levels: readonly StockLevel[]): Promise<WriteResult> {
      const res = await options.http.request('ebay', {
        url: new URL('sell/inventory/v1/bulk_update_price_quantity', base),
        method: 'POST',
        headers: { ...bearer(access), 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: levels.map((l) => ({
            sku: l.sku,
            shipToLocationAvailability: { quantity: l.quantity },
          })),
        }),
      });
      const body = BulkUpdateV1.parse(await ebayJson(res));
      return {
        accepted: body.responses.filter((r) => r.statusCode === 200).map((r) => r.sku),
        refused: body.responses
          .filter((r) => r.statusCode !== 200)
          .map((r) => ({
            sku: r.sku,
            code: `ebay.${String(r.errors?.[0]?.errorId ?? r.statusCode)}`,
          })),
      };
    },
  };
}

/**
 * The `ebay.orders` stream (INT-8): job → governor → parser → vault-first prepare → sink (M10).
 * The first poll of an account reads 90 days back (FA-16 backfill depth; FC-1 wants 90 days).
 */
export function ebayOrderStream(
  adapter: Pick<ChannelAdapter, 'authenticate'> & OrderSource,
  ingest: Pick<SyncStream<ChannelOrder>, 'sink' | 'prepare'>,
): SyncStream<ChannelOrder> {
  return {
    stream: 'ebay.orders',
    provider: 'ebay',
    api: EBAY_APIS.orders,
    authApi: EBAY_APIS.identity,
    lookbackMs: ORDER_BACKFILL_MS,
    authenticate: (credential) => adapter.authenticate(credential),
    fetchPage: (token, since, page) => adapter.ordersUpdatedSince(token, since, page),
    ...(ingest.prepare === undefined ? {} : { prepare: ingest.prepare }),
    sink: ingest.sink,
  };
}

/** FA-16: how far back the first order poll of a new account reads. */
export const ORDER_BACKFILL_MS = 90 * 86_400_000;
