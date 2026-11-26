import { describe, expect, it } from 'vitest';
import { parseWebsiteOrderPage, parseWebsiteOrders } from './index.ts';

const order = (over: Record<string, unknown> = {}) => ({
  id: 'W-1',
  created_at: '2026-11-20T09:00:00.000Z',
  updated_at: '2026-11-20T10:00:00.000Z',
  paid_at: '2026-11-20T09:00:00.000Z',
  status: 'processing',
  currency: 'GBP',
  shipping_total: '3.99',
  customer: { id: 'c-1', email: 'PIIMARK-web@example.test' },
  shipping_address: {
    name: 'PIIMARK-Web',
    line1: 'PIIMARK-2 Road',
    postcode: 'TE2 2ND',
    country: 'gb',
  },
  lines: [{ id: 'L1', sku: 'SKU-1', quantity: 2, total: '19.98' }],
  ...over,
});

describe('website orders parser (M10, provisional until M11)', () => {
  it('[ORD-3] delivered with no shipped time is still a shipped order', () => {
    const [o] = parseWebsiteOrders({
      orders: [order({ status: 'completed', delivered_at: '2026-11-22T09:00:00.000Z' })],
      next_cursor: null,
    });
    expect(o).toMatchObject({ state: 'delivered', dispatchedAt: null });
    expect(o?.deliveredAt).toEqual(new Date('2026-11-22T09:00:00.000Z'));
  });

  it('[ORD-3] a paid order is never pending payment, whatever its status says', () => {
    const state = (over: Record<string, unknown>) =>
      parseWebsiteOrders({ orders: [order(over)], next_cursor: null })[0]?.state;
    expect(state({ status: 'pending' })).toBe('awaiting_dispatch');
    expect(state({ status: 'pending', paid_at: null })).toBe('pending_payment');
  });

  it('[ORD-4][FIN-1] pence by text, upper-case country, buyer fields only in the buyer block', () => {
    const [o] = parseWebsiteOrders({ orders: [order()], next_cursor: null });
    expect(o).toMatchObject({
      shippingPence: 399,
      shipToCountry: 'GB',
      state: 'awaiting_dispatch',
    });
    expect(o?.lines[0]?.linePricePence).toBe(1998);
    expect(o?.buyer).toMatchObject({ channel_buyer_id: 'c-1', country: 'GB' });
    expect(JSON.stringify({ ...o, buyer: null })).not.toContain('PIIMARK');
  });

  const page = (...orders: unknown[]) => parseWebsiteOrderPage({ orders, next_cursor: null });
  const unreadable = { orders: [], setAside: [{ externalId: 'W-1', reason: 'unreadable' }] };

  it('[FIN-1] a negative line or refund is set aside, never stored; a discount may carry its minus', () => {
    const line = { id: 'L1', sku: 'SKU-1', quantity: 1, total: '-5.00' };
    expect(page(order({ lines: [line] }))).toEqual(unreadable);
    const refund = { id: 'R1', created_at: '2026-11-21T09:00:00Z', amount: '-4.00' };
    expect(page(order({ refunds: [refund] }))).toEqual(unreadable);
    expect(page(order({ discount_total: '-2.00' })).orders[0]?.discountPence).toBe(200);
  });

  it('[ORD-4] a bad country or an over-long SKU is set aside, not refused by the insert', () => {
    expect(page(order({ shipping_address: { country: 'G1' } }))).toEqual(unreadable);
    expect(
      page(order({ lines: [{ id: 'L1', sku: 'x'.repeat(201), quantity: 1, total: '1.00' }] })),
    ).toEqual(unreadable);
  });

  // F-M10-end-14, F-M10-end-17, S5-20261124-07: one order never stops its account's sync.
  it('[INT-5][ORD-4] an order that cannot be stored is set aside and the rest of its page is kept', () => {
    const tooLong = 'y'.repeat(164);
    const { orders, setAside } = page(
      order({ id: 'W-OK' }),
      order({ id: 'W-EUR', currency: 'EUR' }),
      order({ id: 'W-NOLINES', lines: [] }),
      order({ id: tooLong }),
      order({
        id: 'W-TEXT',
        lines: [{ id: 'L1', sku: 'SKU-1', quantity: 1, name: 'Mug\u0000', total: '1.00' }],
        shipping_address: {
          name: 'PIIMARK-Web',
          line1: 'PIIMARK-2 Road',
          postcode: 'TE2 2ND',
          country: 'gb',
          instructions: `PIIMARK-${'i'.repeat(5000)}`,
        },
      }),
    );
    expect(orders.map((o) => o.externalId)).toEqual(['W-OK', 'W-TEXT']);
    expect(setAside).toEqual([
      { externalId: 'W-EUR', reason: 'not_gbp' },
      { externalId: 'W-NOLINES', reason: 'no_lines' },
      { externalId: tooLong, reason: 'id_too_long' },
    ]);
    expect(orders[1]?.lines[0]?.title).toBe('Mug');
    expect(orders[1]?.buyer?.delivery_instructions).toHaveLength(4000);
  });
});
