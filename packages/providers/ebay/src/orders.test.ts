import { describe, expect, it } from 'vitest';
import { parseEbayOrderPage, parseEbayOrders } from './adapter.ts';

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

  it('[ORD-3][DEL-1] a fulfilled order has no dispatch time: eBay sends none, and an edit is not one', () => {
    const [o] = parseEbayOrders(page(order({ orderFulfillmentStatus: 'FULFILLED' })));
    expect(o).toMatchObject({ state: 'dispatched', dispatchedAt: null, deliveredAt: null });
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

  it('[FIN-1][VAT-3] delivery discounts and adjustments count, so the pence add up to the total eBay states', () => {
    const [o] = parseEbayOrders(
      page(
        order({
          pricingSummary: {
            deliveryCost: gbp('3.00'),
            priceDiscount: gbp('-1.00'),
            deliveryDiscount: gbp('-2.00'),
            adjustment: gbp('-0.50'),
            total: gbp('11.50'),
          },
        }),
      ),
    );
    expect(o).toMatchObject({ discountPence: 150, shippingPence: 100, totalPence: 1150 });
    // A delivery discount beyond the delivery charge comes off the goods.
    const [free] = parseEbayOrders(
      page(
        order({
          pricingSummary: {
            deliveryCost: gbp('3.00'),
            deliveryDiscount: gbp('-4.00'),
            total: gbp('11.00'),
          },
        }),
      ),
    );
    expect(free).toMatchObject({ discountPence: 100, shippingPence: 0, totalPence: 1100 });
    // A positive adjustment is more to pay: it is split like shipping (VAT-3 step 3).
    const [more] = parseEbayOrders(
      page(
        order({
          pricingSummary: {
            deliveryCost: gbp('3.00'),
            adjustment: gbp('0.50'),
            total: gbp('15.50'),
          },
        }),
      ),
    );
    expect(more).toMatchObject({ discountPence: 0, shippingPence: 350, totalPence: 1550 });
  });

  it('[FIN-1] a negative line or refund is set aside, never stored: its sign is never dropped', () => {
    const unreadable = { orders: [], setAside: [{ externalId: 'EB-1', reason: 'unreadable' }] };
    const line = { lineItemId: 'L1', quantity: 1, lineItemCost: gbp('-5.00') };
    expect(parseEbayOrderPage(page(order({ lineItems: [line] })))).toEqual(unreadable);
    const refunds = [{ refundId: 'R1', refundDate: '2026-11-20T10:00:00Z', amount: gbp('-4.00') }];
    expect(parseEbayOrderPage(page(order({ paymentSummary: { refunds } })))).toEqual(unreadable);
  });

  // F-M10-end-14, F-M10-end-17, S5-20261124-07: one order never stops its account's sync.
  it('[INT-5][ORD-4] an order that cannot be stored is set aside and the rest of its page is kept', () => {
    const fits = 'x'.repeat(163);
    const tooLong = 'y'.repeat(164);
    const { orders, setAside } = parseEbayOrderPage(
      page(
        order({ orderId: 'EB-OK' }),
        order({ orderId: 'EB-EUR', pricingSummary: { total: { value: '1.00', currency: 'EUR' } } }),
        order({ orderId: 'EB-NOLINES', lineItems: [] }),
        order({ orderId: tooLong }),
        order({ orderId: fits }),
        order({
          orderId: 'EB-NUL',
          lineItems: [
            {
              lineItemId: 'L1',
              sku: 'SKU-\u00001',
              title: 'Mug\u0000 blue',
              quantity: 1,
              lineItemCost: gbp('12.00'),
            },
          ],
        }),
        order({
          orderId: 'EB-LONGTEXT',
          lineItems: [
            {
              lineItemId: 'L1',
              sku: 'SKU-1',
              title: 't'.repeat(600),
              quantity: 1,
              lineItemCost: gbp('12.00'),
            },
          ],
          fulfillmentStartInstructions: [
            {
              shippingStep: {
                shipTo: {
                  fullName: `PIIMARK-${'n'.repeat(5000)}`,
                  contactAddress: { addressLine1: 'PIIMARK-1 Street', postalCode: 'TE1 1ST' },
                },
              },
            },
          ],
        }),
        { orderId: 'EB-BROKEN' },
        { nothing: true },
      ),
    );
    expect(orders.map((o) => o.externalId)).toEqual(['EB-OK', fits, 'EB-NUL', 'EB-LONGTEXT']);
    expect(setAside).toEqual([
      { externalId: 'EB-EUR', reason: 'not_gbp' },
      { externalId: 'EB-NOLINES', reason: 'no_lines' },
      { externalId: tooLong, reason: 'id_too_long' },
      { externalId: 'EB-BROKEN', reason: 'unreadable' },
      { externalId: null, reason: 'unreadable' },
    ]);
    // Free text is cut to its limit and NUL removed, never refused.
    expect(orders[2]?.lines[0]).toMatchObject({ sku: 'SKU-1', title: 'Mug blue' });
    expect(orders[3]?.lines[0]?.title).toHaveLength(500);
    expect(orders[3]?.buyer?.name).toHaveLength(4000);
    // A page the parser cannot read at all still fails, with its parser notice (INT-5).
    expect(() => parseEbayOrderPage({ offset: 0, limit: 50 })).toThrow();
  });
});
