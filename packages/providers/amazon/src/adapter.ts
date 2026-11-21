/**
 * Amazon SP-API as a ChannelAdapter (INT-1), thin in M07: an LWA access token from the refresh
 * token, the Orders API "updated since" read and the Listings Items stock patch. M18 builds the
 * rest (restricted data tokens, reports, feeds). Each answer goes through a versioned parser.
 */
import { Secret } from '@omnibridge/crypto';
import {
  AuthFailed,
  defineParser,
  ProviderRejected,
  RateLimited,
  readJson,
  retryAfterMs,
  type AccessToken,
  type ChannelAdapter,
  type OrderSummary,
  type Page,
  type ProviderHttp,
  type StockLevel,
  type TokenGrant,
  type WriteResult,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

/** The UK marketplace id (SP-API EU region). */
export const UK_MARKETPLACE_ID = 'A1F83G8C2ARO7P';

export const AMAZON_APIS = {
  lwa: 'lwa.token',
  orders: 'orders.getOrders',
  listings: 'listings.patchListingsItem',
} as const;

const LwaV1 = defineParser(
  'amazon',
  'lwa_token',
  1,
  z.object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
  }),
);

const OrdersV1 = defineParser(
  'amazon',
  'orders',
  1,
  z.object({
    payload: z.object({
      Orders: z.array(
        z.object({
          AmazonOrderId: z.string().min(1),
          LastUpdateDate: z.iso.datetime({ offset: true }),
          OrderStatus: z.string(),
        }),
      ),
      NextToken: z.string().optional(),
    }),
  }),
);

const ListingsPatchV1 = defineParser(
  'amazon',
  'listings_patch',
  1,
  z.object({
    sku: z.string(),
    status: z.enum(['ACCEPTED', 'INVALID', 'VALID']),
    issues: z.array(z.object({ code: z.string() })).optional(),
  }),
);

export interface AmazonAdapterOptions {
  http: ProviderHttp;
  clientId: Secret;
  clientSecret: Secret;
  sellerId: string;
  now?: () => Date;
}

/** SP-API 429: `x-amzn-RateLimit-Limit` (requests per second) when Amazon sends it (AMZ-9). */
async function spJson(res: Response): Promise<unknown> {
  if (res.status === 429) {
    const limit = Number(res.headers.get('x-amzn-ratelimit-limit'));
    const after = retryAfterMs(res);
    await res.body?.cancel();
    throw new RateLimited('amazon', {
      ...(Number.isFinite(limit) && limit > 0 ? { limitPerSecond: limit } : {}),
      ...(after === undefined ? {} : { retryAfterMs: after }),
    });
  }
  return readJson('amazon', res);
}

export function createAmazonAdapter(options: AmazonAdapterOptions): ChannelAdapter & {
  exchangeCode(code: string): Promise<TokenGrant>;
} {
  const now = options.now ?? (() => new Date());
  const lwa = options.http.base('amazon', 'lwa');
  const api = options.http.base('amazon', 'api');
  const expiry = (s: number) => new Date(now().getTime() + s * 1000);

  async function token(params: Record<string, string>) {
    const res = await options.http.request('amazon', {
      url: new URL('auth/o2/token', lwa),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        client_id: options.clientId.reveal(),
        client_secret: options.clientSecret.reveal(),
      }).toString(),
    });
    if (res.status === 400) {
      const err = (await res.json().catch(() => ({}))) as { error?: unknown };
      // AMZ-12: invalid_grant marks the account Needs re-authorisation at once.
      if (err.error === 'invalid_grant') throw new AuthFailed('amazon', true);
      throw new ProviderRejected('amazon', 'http_400');
    }
    return LwaV1.parse(await readJson('amazon', res));
  }

  const headers = (t: AccessToken) => ({ 'x-amz-access-token': t.token.reveal() });

  return {
    provider: 'amazon',

    async authenticate(credential) {
      const t = await token({ grant_type: 'refresh_token', refresh_token: credential.reveal() });
      return { token: new Secret(t.access_token), expiresAt: expiry(t.expires_in) };
    },

    async exchangeCode(code) {
      const t = await token({ grant_type: 'authorization_code', code });
      if (t.refresh_token === undefined) throw new AuthFailed('amazon', true);
      return {
        token: new Secret(t.access_token),
        expiresAt: expiry(t.expires_in),
        refreshToken: new Secret(t.refresh_token),
        refreshTokenExpiresAt: null,
      };
    },

    async ordersUpdatedSince(access, since, page): Promise<Page<OrderSummary>> {
      const url = new URL('orders/v0/orders', api);
      url.searchParams.set('MarketplaceIds', UK_MARKETPLACE_ID);
      if (page === undefined) url.searchParams.set('LastUpdatedAfter', since.toISOString());
      else url.searchParams.set('NextToken', page);
      const res = await options.http.request('amazon', { url, headers: headers(access) });
      const body = OrdersV1.parse(await spJson(res));
      return {
        // Order lines come from getOrderItems in M10/M18; the cursor needs IDs and times only.
        items: body.payload.Orders.map((o) => ({
          externalId: o.AmazonOrderId,
          updatedAt: new Date(o.LastUpdateDate),
          status: o.OrderStatus,
          lines: [],
        })),
        next: body.payload.NextToken,
      };
    },

    async pushStock(access, levels: readonly StockLevel[]): Promise<WriteResult> {
      const accepted: string[] = [];
      const refused: { sku: string; code: string }[] = [];
      for (const level of levels) {
        const url = new URL(
          `listings/2021-08-01/items/${encodeURIComponent(options.sellerId)}/${encodeURIComponent(level.sku)}`,
          api,
        );
        url.searchParams.set('marketplaceIds', UK_MARKETPLACE_ID);
        const res = await options.http.request('amazon', {
          url,
          method: 'PATCH',
          headers: { ...headers(access), 'content-type': 'application/json' },
          body: JSON.stringify({
            productType: 'PRODUCT',
            patches: [
              {
                op: 'replace',
                path: '/attributes/fulfillment_availability',
                value: [{ fulfillment_channel_code: 'DEFAULT', quantity: level.quantity }],
              },
            ],
          }),
        });
        const body = ListingsPatchV1.parse(await spJson(res));
        if (body.status === 'ACCEPTED') accepted.push(level.sku);
        else
          refused.push({ sku: level.sku, code: `amazon.${body.issues?.[0]?.code ?? body.status}` });
      }
      return { accepted, refused };
    },
  };
}
