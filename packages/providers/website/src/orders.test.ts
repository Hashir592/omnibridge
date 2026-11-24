import { describe, expect, it } from 'vitest';
import { parseWebsiteOrders } from './index.ts';

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

  it('[FIN-1] a negative line or refund fails the parser; a discount may carry its minus', () => {
    const parse = (over: Record<string, unknown>) =>
      parseWebsiteOrders({ orders: [order(over)], next_cursor: null });
    const line = { id: 'L1', sku: 'SKU-1', quantity: 1, total: '-5.00' };
    expect(() => parse({ lines: [line] })).toThrow();
    const refund = { id: 'R1', created_at: '2026-11-21T09:00:00Z', amount: '-4.00' };
    expect(() => parse({ refunds: [refund] })).toThrow();
    expect(parse({ discount_total: '-2.00' })[0]?.discountPence).toBe(200);
  });

  it('[ORD-4] a bad country or an over-long SKU fails the parser, not the insert', () => {
    const bad = (over: Record<string, unknown>) => () =>
      parseWebsiteOrders({ orders: [order(over)], next_cursor: null });
    expect(bad({ shipping_address: { country: 'G1' } })).toThrow();
    expect(
      bad({ lines: [{ id: 'L1', sku: 'x'.repeat(201), quantity: 1, total: '1.00' }] }),
    ).toThrow();
  });
});
