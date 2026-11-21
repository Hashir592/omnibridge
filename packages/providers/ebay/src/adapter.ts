/**
 * eBay as a ChannelAdapter (INT-1), the M07 reference adapter: user tokens from the refresh token,
 * the Fulfillment API's "updated since" order read (INT-8) and the Inventory API's stock write.
 * Every answer goes through a versioned parser (INT-5); buyer fields are dropped by the parser and
 * never leave this file (M10 brings the vault-first ingest).
 */
import { Secret } from '@omnibridge/crypto';
import {
  AuthFailed,
  defineParser,
  ProviderRejected,
  RateLimited,
  readJson,
  type AccessToken,
  type ChannelAdapter,
  type OrderSummary,
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

export const EbayOrdersV1 = defineParser(
  'ebay',
  'orders',
  1,
  z.object({
    next: z.string().optional(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    orders: z.array(
      z.object({
        orderId: z.string().min(1),
        lastModifiedDate: z.iso.datetime({ offset: true }),
        orderFulfillmentStatus: z.string(),
        lineItems: z.array(
          z.object({
            lineItemId: z.string().min(1),
            sku: z.string().optional(),
            quantity: z.number().int().min(0),
          }),
        ),
      }),
    ),
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

export function createEbayAdapter(options: EbayAdapterOptions): ChannelAdapter & {
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

    async ordersUpdatedSince(access, since, page): Promise<Page<OrderSummary>> {
      const url = new URL('sell/fulfillment/v1/order', base);
      url.searchParams.set('filter', `lastmodifieddate:[${since.toISOString()}..]`);
      url.searchParams.set('limit', String(options.pageSize ?? 200));
      url.searchParams.set('offset', page ?? '0');
      const res = await options.http.request('ebay', { url, headers: bearer(access) });
      const body = EbayOrdersV1.parse(await ebayJson(res));
      return {
        items: body.orders.map((o) => ({
          externalId: o.orderId,
          updatedAt: new Date(o.lastModifiedDate),
          status: o.orderFulfillmentStatus,
          lines: o.lineItems.map((l) => ({
            lineId: l.lineItemId,
            sku: l.sku ?? null,
            quantity: l.quantity,
          })),
        })),
        next: body.next === undefined ? undefined : String(body.offset + body.limit),
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
 * The `ebay.orders` stream (INT-8): the reference path of M07, job → governor → parser → cursor.
 * The sink is M10's order ingest; until then the worker passes one that only counts.
 */
export function ebayOrderStream(
  adapter: ChannelAdapter,
  sink: SyncStream<OrderSummary>['sink'],
): SyncStream<OrderSummary> {
  return {
    stream: 'ebay.orders',
    provider: 'ebay',
    api: EBAY_APIS.orders,
    lookbackMs: 30 * 86_400_000,
    authenticate: (credential) => adapter.authenticate(credential),
    fetchPage: (token, since, page) => adapter.ordersUpdatedSince(token, since, page),
    sink,
  };
}
