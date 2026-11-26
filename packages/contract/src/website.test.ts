import { describe, expect, it } from 'vitest';
import { routeMetadataProblems, type AnyRoute } from './route.ts';
import {
  disconnectAccount,
  WEBSITE_ORDER_ID_MAX,
  WebsiteOrderSchema,
  websiteRoutes,
  WebsiteStockBatchSchema,
} from './routes/website.ts';

const order = {
  externalOrderId: 'W-1001',
  status: 'paid',
  currency: 'GBP',
  placedAt: '2026-11-20T09:00:00Z',
  updatedAt: '2026-11-20T09:05:00+00:00',
  lines: [
    { externalLineId: 'L1', externalSku: 'SKU-1', title: 'Mug', quantity: 2, unitPriceGross: 650 },
  ],
  shippingGross: 399,
  discountGross: 0,
  buyer: { name: 'PIIMARK-Buyer' },
  shippingAddress: {
    name: 'PIIMARK-Buyer',
    line1: '1 Example Street',
    city: 'Testville',
    postcode: 'TE1 1ST',
    country: 'GB',
  },
};
const valid = (body: unknown) => WebsiteOrderSchema.safeParse(body).success;

describe('the website protocol in the contract (WEB-1 to WEB-4, ADR-059)', () => {
  it('[WEB-1][WEB-3] every website route needs the website_connector module; Disconnect does not', () => {
    for (const route of websiteRoutes) {
      expect(routeMetadataProblems(route), route.id).toEqual([]);
      expect((route as AnyRoute).module, route.id).toBe(
        route === disconnectAccount ? undefined : 'website_connector',
      );
    }
    // Only a known module may be named.
    expect(routeMetadataProblems({ ...disconnectAccount, module: 'other' as never })).not.toEqual(
      [],
    );
  });

  it('[WEB-3] an order is whole, in GBP, in pence, with IDs that fit and no NUL', () => {
    expect(valid(order)).toBe(true);
    expect(valid({ ...order, currency: 'EUR' })).toBe(false);
    expect(valid({ ...order, shippingGross: 3.99 })).toBe(false);
    expect(valid({ ...order, shippingGross: -1 })).toBe(false);
    expect(valid({ ...order, lines: [] })).toBe(false);
    expect(valid({ ...order, placedAt: '2026-11-20 09:00' })).toBe(false);
    expect(valid({ ...order, externalOrderId: 'x'.repeat(WEBSITE_ORDER_ID_MAX) })).toBe(true);
    expect(valid({ ...order, externalOrderId: 'x'.repeat(WEBSITE_ORDER_ID_MAX + 1) })).toBe(false);
    expect(valid({ ...order, buyer: { name: 'PIIMARK-\u0000' } })).toBe(false);
    expect(valid({ ...order, shippingAddress: { ...order.shippingAddress, country: 'gb' } })).toBe(
      false,
    );
  });

  it('[WEB-4] stock goes in batches of 1 to 100', () => {
    const line = { externalSku: 'SKU-1', quantity: 0 };
    expect(WebsiteStockBatchSchema.safeParse([line]).success).toBe(true);
    expect(WebsiteStockBatchSchema.safeParse(Array(100).fill(line)).success).toBe(true);
    expect(WebsiteStockBatchSchema.safeParse(Array(101).fill(line)).success).toBe(false);
    expect(WebsiteStockBatchSchema.safeParse([]).success).toBe(false);
  });
});
