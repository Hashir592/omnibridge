import { createHmac, randomUUID } from 'node:crypto';
import { Secret } from '@omnibridge/crypto';
import { EgressRefused, ProviderHttp, type ChannelOrder } from '@omnibridge/provider-kit';
import { describe, expect, it } from 'vitest';
import { createWebsiteAdapter, parseWebsiteOrderPage, type WebsiteOrder } from './index.ts';

/** Made per run: no signing secret is ever written in the repo, not even a test one. */
const SECRET = `obs_${randomUUID()}`;
const NOW = new Date('2026-11-28T09:00:00.000Z');
const credential = new Secret(
  JSON.stringify({
    apiKey: 'site-key',
    signingSecret: SECRET,
    baseUrl: 'https://shop.example.test',
  }),
);
/** Only what these cases look at: the parser hands each order on as the push maps it. */
const toChannelOrder = (o: WebsiteOrder) =>
  ({ externalId: o.externalOrderId, buyer: { name: o.shippingAddress.name } }) as ChannelOrder;

const order = (over: Record<string, unknown> = {}) => ({
  externalOrderId: 'W-1',
  status: 'paid',
  currency: 'GBP',
  placedAt: '2026-11-27T09:00:00Z',
  updatedAt: '2026-11-27T09:05:00Z',
  lines: [
    { externalLineId: 'L1', externalSku: 'S1', title: 'Mug', quantity: 1, unitPriceGross: 650 },
  ],
  shippingGross: 0,
  discountGross: 0,
  buyer: { name: 'PIIMARK-Buyer' },
  shippingAddress: { name: 'PIIMARK-Buyer', line1: 'PIIMARK-1 Road', city: 'Town', country: 'GB' },
  ...over,
});

/** A website that records each call and answers `answer`. */
function site(answer: unknown = {}) {
  const calls: { url: URL; method: string; headers: Record<string, string>; body: string }[] = [];
  const http = new ProviderHttp({
    mode: 'mock',
    mocksUrl: 'http://mocks.test/',
    fetch: (url, init) => {
      calls.push({
        url: new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url),
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    },
  });
  return { calls, adapter: createWebsiteAdapter({ http, toChannelOrder, now: () => NOW }) };
}

const signedRight = (c: { headers: Record<string, string>; body: string }) =>
  c.headers['x-ob-signature'] ===
  createHmac('sha256', SECRET)
    .update(`${c.headers['x-ob-timestamp'] ?? ''}.${c.body}`)
    .digest('hex');

describe('the website protocol, OmniBridge side (T-1101)', () => {
  it('[WEB-2][WEB-4][OPS-12] stock goes as PUT /omnibridge/stock, signed with the shared secret and keyed by the write', async () => {
    const { calls, adapter } = site();
    const token = await adapter.authenticate(credential);
    const result = await adapter.pushStock(token, [{ sku: 'S1', quantity: 4 }], 'write-1');
    expect(result).toEqual({ accepted: ['S1'], refused: [] });
    const [call] = calls;
    expect(call?.method).toBe('PUT');
    expect(call?.url.pathname).toBe('/website/omnibridge/stock');
    expect(JSON.parse(call?.body ?? '')).toEqual([{ externalSku: 'S1', quantity: 4 }]);
    expect(call?.headers).toMatchObject({
      authorization: 'Bearer site-key',
      'x-ob-timestamp': String(NOW.getTime() / 1000),
      'idempotency-key': 'write-1',
    });
    expect(call !== undefined && signedRight(call)).toBe(true);
    // WEB-4: at most 100 SKUs in one call.
    const many = Array.from({ length: 101 }, (_, i) => ({ sku: `S${String(i)}`, quantity: 1 }));
    await expect(adapter.pushStock(token, many, 'write-2')).rejects.toThrow('at most 100');
  });

  it('[WEB-2][WEB-4][TRK-1] a shipment goes as POST /omnibridge/orders/{id}/shipment, signed', async () => {
    const { calls, adapter } = site();
    const token = await adapter.authenticate(credential);
    const shipment = {
      carrier: 'evri',
      service: '48h',
      trackingNumbers: ['T1'],
      shippedAt: '2026-11-28T08:00:00Z',
    };
    await adapter.pushShipment(token, 'W 1/2', shipment, 'write-3');
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/website/omnibridge/orders/W%201%2F2/shipment');
    expect(JSON.parse(call?.body ?? '')).toEqual(shipment);
    expect(call !== undefined && signedRight(call)).toBe(true);
  });

  it('[WEB-4][INT-5] the nightly read asks for changes since a time; one order that cannot be stored is set aside, the rest kept', async () => {
    const { calls, adapter } = site({
      orders: [
        order(),
        order({ externalOrderId: 'W-USD', currency: 'USD' }),
        order({ externalOrderId: 'W-EMPTY', lines: [] }),
        order({ externalOrderId: 'W'.repeat(164) }),
        { externalOrderId: 'W-BAD', status: 'unknown' },
      ],
      nextCursor: 'c2',
    });
    const token = await adapter.authenticate(credential);
    const page = await adapter.ordersUpdatedSince(token, new Date('2026-11-27T00:00:00Z'), 'c1');
    const [call] = calls;
    expect(call?.url.pathname).toBe('/website/omnibridge/orders');
    expect(call?.url.searchParams.get('updatedSince')).toBe('2026-11-27T00:00:00.000Z');
    expect(call?.url.searchParams.get('cursor')).toBe('c1');
    expect(call !== undefined && signedRight(call)).toBe(true);
    expect(page.items.map((o) => o.externalId)).toEqual(['W-1']);
    expect(page.setAside?.map((x) => x.reason).sort()).toEqual([
      'id_too_long',
      'no_lines',
      'not_gbp',
      'unreadable',
    ]);
    expect(page.next).toBe('c2');
  });

  it('[ORD-4] NUL in a text is removed, never a reason to refuse the order (S5-20261124-07)', () => {
    const { orders } = parseWebsiteOrderPage(
      { orders: [order({ buyer: { name: 'PIIMARK-Bu\u0000yer' } })], nextCursor: null },
      (o) => ({ externalId: o.buyer.name }) as ChannelOrder,
    );
    expect(orders.map((o) => o.externalId)).toEqual(['PIIMARK-Buyer']);
  });

  it('[WEB-2] a credential that is not the website triple is an auth failure, never a value', async () => {
    const { adapter } = site();
    await expect(adapter.authenticate(new Secret('TOKENMARK-plain'))).rejects.toMatchObject({
      name: 'AuthFailed',
    });
  });

  it('[WEB-4][SEC-3] outside mock mode a website is called only over HTTPS at a named host', () => {
    const http = new ProviderHttp({ mode: 'sandbox' });
    expect(http.site('https://shop.example.co.uk').href).toBe('https://shop.example.co.uk/');
    for (const bad of [
      'http://shop.example.co.uk',
      'https://10.0.0.5',
      'https://localhost',
      'https://pii-vault',
      'https://shop.internal',
      'https://user:pass@shop.example.co.uk',
    ]) {
      expect(() => http.site(bad), bad).toThrow(EgressRefused);
    }
  });
});
