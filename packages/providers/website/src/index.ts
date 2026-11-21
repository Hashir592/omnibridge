/**
 * The seller's own website as a ChannelAdapter (INT-1), thin in M07: an API key, the "updated
 * since" order read and the stock write. M11 defines the connector protocol in full; buyer fields
 * are dropped by the parser here and reach the vault only through M10's ingest.
 */
import { Secret } from '@omnibridge/crypto';
import {
  defineParser,
  readJson,
  type ChannelAdapter,
  type ProviderHttp,
} from '@omnibridge/provider-kit';
import { z } from 'zod';

export const PACKAGE_NAME = '@omnibridge/provider-website';

/** An API key does not expire; the cache renews it daily anyway. */
const KEY_TTL_MS = 86_400_000;

const OrdersV1 = defineParser(
  'website',
  'orders',
  1,
  z.object({
    orders: z.array(
      z.object({
        id: z.string().min(1),
        updated_at: z.iso.datetime({ offset: true }),
        status: z.string(),
        lines: z.array(
          z.object({ id: z.string(), sku: z.string().nullable(), quantity: z.number().int() }),
        ),
      }),
    ),
    next_cursor: z.string().nullable(),
  }),
);
const StockV1 = defineParser('website', 'stock', 1, z.object({ updated: z.array(z.string()) }));

export function createWebsiteAdapter(options: {
  http: ProviderHttp;
  now?: () => Date;
}): ChannelAdapter {
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
      return {
        items: body.orders.map((o) => ({
          externalId: o.id,
          updatedAt: new Date(o.updated_at),
          status: o.status,
          lines: o.lines.map((l) => ({ lineId: l.id, sku: l.sku, quantity: l.quantity })),
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
