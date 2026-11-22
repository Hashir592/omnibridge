/*
 * The order state table (FA-10, ORD-3). Polls re-read changed orders with an overlap, so updates
 * arrive late, twice or out of order. An update moves an order only along the table; skipping
 * forward is allowed (a missed step), and the only backward move is the listed one (a voided
 * label returns the order to awaiting dispatch, SHP-5). Anything else is kept as raw history and
 * changes nothing. Timestamps (paid, dispatched, delivered) are stored as they arrive, apart from
 * the status, so a refused move never loses one.
 */

export const ORDER_STATUSES = [
  'pending_payment',
  'awaiting_dispatch',
  'label_created',
  'dispatched',
  'delivered',
  'cancelled',
  'partly_refunded',
  'refunded',
  'returned',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The allowed direct moves. Cancelled and returned are final. */
export const ORDER_MOVES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending_payment: ['awaiting_dispatch', 'cancelled'],
  awaiting_dispatch: ['label_created', 'dispatched', 'cancelled'],
  label_created: ['awaiting_dispatch', 'dispatched', 'cancelled'],
  dispatched: ['delivered', 'partly_refunded', 'refunded', 'returned'],
  delivered: ['partly_refunded', 'refunded', 'returned'],
  partly_refunded: ['refunded', 'returned'],
  refunded: ['returned'],
  returned: [],
  cancelled: [],
};

/** True when `to` is reachable from `from` along the table: a listed move or a skip forward. */
export function canMoveOrder(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return false;
  if (ORDER_MOVES[from].includes(to)) return true;
  // Skipping forward: reachable through moves that never go back (the void is a direct move only).
  const seen = new Set<OrderStatus>([from]);
  const queue: OrderStatus[] = [from];
  while (queue.length > 0) {
    const at = queue.shift() as OrderStatus;
    for (const next of ORDER_MOVES[at]) {
      if (at === 'label_created' && next === 'awaiting_dispatch') continue;
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** The status after an update: the incoming one when the table allows it, else the current one. */
export function nextOrderStatus(current: OrderStatus | null, incoming: OrderStatus): OrderStatus {
  if (current === null) return incoming;
  return canMoveOrder(current, incoming) ? incoming : current;
}
