import { describe, expect, it } from 'vitest';
import { parseEbayOrders } from './adapter.ts';

const gbp = (value: string) => ({ value, currency: 'GBP' });
const order = (over: Record<string, unknown> = {}) => ({
  orderId: 'EB-1',
  creationDate: '2026-11-20T09:00:00.000Z',
  lastModifiedDate: '2026-11-20T10:00:00.000Z',
  orderFulfillmentStatus: 'NOT_STARTED',
  orderPaymentStatus: 'PAID',
  pricingSummary: { deliveryCost: gbp('3.00'), total: gbp('15.00') },
  fulfillmentStartInstructions: [
    {
      shippingStep: {
        shipTo: {
          fullName: 'PIIMARK-Buyer',
          contactAddress: {
            addressLine1: 'PIIMARK-1 Street',
            postalCode: 'TE1 1ST',
            countryCode: 'gb',
          },
        },
      },
    },
  ],
  lineItems: [{ lineItemId: 'L1', sku: 'SKU-1', quantity: 1, lineItemCost: gbp('12.00') }],
  ...over,
});
const page = (...orders: unknown[]) => ({ offset: 0, limit: 50, orders });

describe('eBay getOrders parser (M10)', () => {
  it('[ORD-3][VAT-6] a cancelled order never paid has no payment date', () => {
    const [o] = parseEbayOrders(
      page(order({ cancelStatus: { cancelState: 'CANCELED' }, orderPaymentStatus: 'PENDING' })),
    );
    expect(o).toMatchObject({ state: 'cancelled', paidAt: null });
  });

  it('[ORD-3] an order refunded in full before shipping is cancelled, not awaiting dispatch', () => {
    const [o] = parseEbayOrders(page(order({ orderPaymentStatus: 'FULLY_REFUNDED' })));
    expect(o?.state).toBe('cancelled');
    const [shipped] = parseEbayOrders(
      page(order({ orderPaymentStatus: 'FULLY_REFUNDED', orderFulfillmentStatus: 'FULFILLED' })),
    );
    expect(shipped?.state).toBe('dispatched');
  });

  it('[ORD-4][FIN-1] money is pence, the country upper case, and buyer fields only in the buyer block', () => {
    const [o] = parseEbayOrders(page(order()));
    expect(o).toMatchObject({
      shippingPence: 300,
      shipToCountry: 'GB',
      paidAt: new Date('2026-11-20T09:00:00.000Z'),
    });
    expect(o?.lines[0]?.linePricePence).toBe(1200);
    expect(o?.buyer?.country).toBe('GB');
    expect(JSON.stringify({ ...o, buyer: null })).not.toContain('PIIMARK');
  });

  it('[ORD-4] an ID or SKU longer than db-main keeps fails the parser, not the insert', () => {
    expect(() => parseEbayOrders(page(order({ orderId: 'x'.repeat(201) })))).toThrow();
    expect(() =>
      parseEbayOrders(
        page(order({ pricingSummary: { total: { value: '1.00', currency: 'EUR' } } })),
      ),
    ).toThrow();
  });
});
