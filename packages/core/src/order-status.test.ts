import { describe, expect, it } from 'vitest';
import {
  canMoveOrder,
  nextOrderStatus,
  ORDER_MOVES,
  ORDER_STATUSES,
  type OrderStatus,
} from './order-status.ts';

describe('order state table (FA-10)', () => {
  it('[ORD-3] every listed move is allowed', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_MOVES[from])
        expect({ from, to, ok: canMoveOrder(from, to) }).toEqual({ from, to, ok: true });
    }
  });

  it('[ORD-3] never moves backwards except the listed void (label_created to awaiting_dispatch)', () => {
    expect(canMoveOrder('label_created', 'awaiting_dispatch')).toBe(true);
    const backwards: [OrderStatus, OrderStatus][] = [
      ['awaiting_dispatch', 'pending_payment'],
      ['dispatched', 'awaiting_dispatch'],
      ['dispatched', 'label_created'],
      ['delivered', 'dispatched'],
      ['refunded', 'partly_refunded'],
      ['returned', 'refunded'],
      ['cancelled', 'awaiting_dispatch'],
      ['cancelled', 'dispatched'],
      ['dispatched', 'cancelled'],
    ];
    for (const [from, to] of backwards)
      expect({ from, to, ok: canMoveOrder(from, to) }).toEqual({ from, to, ok: false });
  });

  it('[ORD-3] skipping forward is allowed (a late poll may miss a step)', () => {
    expect(canMoveOrder('pending_payment', 'dispatched')).toBe(true);
    expect(canMoveOrder('awaiting_dispatch', 'delivered')).toBe(true);
    expect(canMoveOrder('pending_payment', 'returned')).toBe(true);
  });

  it('[ORD-3] a repeated, late or out-of-order update never changes the result', () => {
    const arrivals: OrderStatus[][] = [
      ['pending_payment', 'awaiting_dispatch', 'dispatched', 'delivered'],
      ['delivered', 'pending_payment', 'dispatched', 'awaiting_dispatch'],
      ['dispatched', 'dispatched', 'awaiting_dispatch', 'delivered', 'delivered'],
    ];
    for (const updates of arrivals) {
      const end = updates.reduce<OrderStatus | null>((s, u) => nextOrderStatus(s, u), null);
      expect(end).toBe('delivered');
    }
    // A cancellation is final: a late "awaiting dispatch" or "dispatched" never revives it.
    const cancelled = [
      'awaiting_dispatch',
      'cancelled',
      'awaiting_dispatch',
      'dispatched',
    ] as const;
    expect(cancelled.reduce<OrderStatus | null>((s, u) => nextOrderStatus(s, u), null)).toBe(
      'cancelled',
    );
  });
});
