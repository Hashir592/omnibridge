/**
 * The seller's own website (WEB-2, WEB-4, OPS-12): OmniBridge's side of the signed website
 * contract (`@omnibridge/contract` routes/website.ts). Every call carries the website's key, a
 * timestamp, an HMAC-SHA256 signature of `<timestamp>.<raw body>` under the shared secret, and an
 * Idempotency-Key that is the same on every attempt of one write. Buyer fields leave the parser
 * only in an order's `buyer` block, which ingest gives to pii-vault.
 */
import { createHmac, randomUUID } from 'node:crypto';
import {
  WEBSITE_HEADERS,
  WEBSITE_ORDER_ID_MAX,
  WEBSITE_STOCK_BATCH_MAX,
  WebsiteOrderSchema,
  type WebsiteShipmentSchema,
} from '@omnibridge/contract';
import { Secret } from '@omnibridge/crypto';
import {
  AuthFailed,
  defineParser,
  parseEach,
  readJson,
  type AccessToken,
  type ChannelOrder,
  type OrderSource,
  type Page,
  type ProviderHttp,
  type SetAside,
  type StockLevel,
  type SyncStream,
  type WriteResult,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

export const PACKAGE_NAME = '@omnibridge/provider-website';

/** A key does not expire; the cache renews it daily anyway. */
const KEY_TTL_MS = 86_400_000;

/** WEB-5: website writes retry from 1 minute up to 24 hours, then dead-letter with an alert. */
export const WEBSITE_RETRY = { maxAttempts: 13, maxDelayMs: 24 * 60 * 60_000 } as const;

/** The website's credential as db-main assembles it (AccountCredentials.read). */
const Credential = z.object({
  apiKey: z.string().min(1),
  signingSecret: z.string().min(1),
  baseUrl: z.string().min(1),
});
type Credential = z.infer<typeof Credential>;

/** Never the value: an unreadable credential is the account's problem, like a revoked key. */
function readCredential(text: string): Credential {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AuthFailed('website', false);
  }
  const parsed = Credential.safeParse(json);
  if (!parsed.success) throw new AuthFailed('website', false);
  return parsed.data;
}
const credentialOf = (token: AccessToken): Credential => readCredential(token.token.reveal());

/** WEB-4: one page of `GET /omnibridge/orders`; each order is read on its own. */
const OrdersPage = defineParser(
  'website',
  'orders',
  4,
  z.object({ orders: z.array(z.unknown()), nextCursor: z.string().nullable() }),
);
const Order = defineParser('website', 'order', 4, WebsiteOrderSchema);
export type WebsiteOrder = z.output<typeof WebsiteOrderSchema>;
export type WebsiteShipment = z.input<typeof WebsiteShipmentSchema>;

/** S5-20261124-07: NUL, which PostgreSQL cannot store, is removed from every text, not refused. */
function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNul(v)]));
  }
  return value;
}

/**
 * One orders page: the orders that can be stored, as channel orders, and those set aside (one bad
 * order never stops the account, F-M10-end-14, -17). A page the parser cannot read throws, with its
 * parser notice (INT-5). `toChannelOrder` is the website push's own mapping (order-ingest).
 */
export function parseWebsiteOrderPage(
  body: unknown,
  toChannelOrder: (o: WebsiteOrder) => ChannelOrder,
): { orders: ChannelOrder[]; setAside: SetAside[]; next: string | undefined } {
  const page = OrdersPage.parse(body);
  const { items, setAside } = parseEach(Order, page.orders.map(withoutNul), {
    id: { field: 'externalOrderId', max: WEBSITE_ORDER_ID_MAX },
    linesField: 'lines',
  });
  return { orders: items.map(toChannelOrder), setAside, next: page.nextCursor ?? undefined };
}

export interface WebsiteAdapter extends OrderSource {
  readonly provider: 'website';
  authenticate(credential: Secret): Promise<AccessToken>;
  /** WEB-4: `PUT /omnibridge/stock`, at most 100 SKUs; a 2xx takes them all. */
  pushStock(token: AccessToken, levels: readonly StockLevel[], key?: string): Promise<WriteResult>;
  /** WEB-4: `POST /omnibridge/orders/{externalOrderId}/shipment`. */
  pushShipment(
    token: AccessToken,
    externalOrderId: string,
    shipment: WebsiteShipment,
    key: string,
  ): Promise<void>;
}

export function createWebsiteAdapter(options: {
  http: ProviderHttp;
  /** The website push's own order mapping (order-ingest `websiteChannelOrder`). */
  toChannelOrder: (o: WebsiteOrder) => ChannelOrder;
  now?: () => Date;
}): WebsiteAdapter {
  const now = options.now ?? (() => new Date());

  /** One signed call (WEB-2). The key is the same on every attempt of one write. */
  const signed = async (
    token: AccessToken,
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    input: { query?: Record<string, string>; body?: unknown; key?: string } = {},
  ): Promise<unknown> => {
    const c = credentialOf(token);
    const url = new URL(path, options.http.site(c.baseUrl));
    for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);
    const raw = input.body === undefined ? '' : JSON.stringify(input.body);
    const at = String(Math.floor(now().getTime() / 1000));
    const signature = createHmac('sha256', c.signingSecret).update(`${at}.${raw}`).digest('hex');
    const res = await options.http.request('website', {
      url,
      method,
      headers: {
        authorization: `Bearer ${c.apiKey}`,
        [WEBSITE_HEADERS.timestamp]: at,
        [WEBSITE_HEADERS.signature]: signature,
        [WEBSITE_HEADERS.idempotencyKey]: input.key ?? randomUUID(),
        ...(raw === '' ? {} : { 'content-type': 'application/json' }),
      },
      ...(raw === '' ? {} : { body: raw }),
    });
    return readJson('website', res);
  };

  return {
    provider: 'website',

    authenticate(credential) {
      // Read now, so a bad credential fails the token call, not the first write; a throw in the
      // executor rejects the promise.
      return new Promise((resolve) => {
        readCredential(credential.reveal());
        resolve({
          token: new Secret(credential.reveal()),
          expiresAt: new Date(now().getTime() + KEY_TTL_MS),
        });
      });
    },

    async ordersUpdatedSince(token, since, page): Promise<Page<ChannelOrder>> {
      const body = await signed(token, 'GET', 'omnibridge/orders', {
        query: {
          updatedSince: since.toISOString(),
          ...(page === undefined ? {} : { cursor: page }),
        },
      });
      const { orders, setAside, next } = parseWebsiteOrderPage(body, options.toChannelOrder);
      return { items: orders, next, setAside };
    },

    async pushStock(token, levels, key) {
      if (levels.length > WEBSITE_STOCK_BATCH_MAX) {
        throw new Error(`a website stock batch holds at most ${String(WEBSITE_STOCK_BATCH_MAX)}`);
      }
      await signed(token, 'PUT', 'omnibridge/stock', {
        body: levels.map((l) => ({ externalSku: l.sku, quantity: l.quantity })),
        ...(key === undefined ? {} : { key }),
      });
      return { accepted: levels.map((l) => l.sku), refused: [] };
    },

    async pushShipment(token, externalOrderId, shipment, key) {
      await signed(
        token,
        'POST',
        `omnibridge/orders/${encodeURIComponent(externalOrderId)}/shipment`,
        { body: shipment, key },
      );
    },
  };
}

/** FA-16: how far back the first order read of a new website account goes. */
export const WEBSITE_ORDER_BACKFILL_MS = 90 * 86_400_000;

/**
 * The `website.orders` stream (WEB-4): the nightly `GET /omnibridge/orders?updatedSince=` that
 * catches calls that never arrived, through the same vault-first prepare and sink as the push.
 */
export function websiteOrderStream(
  adapter: Pick<WebsiteAdapter, 'authenticate'> & OrderSource,
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
