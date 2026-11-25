import type { TenantContext } from '@omnibridge/core';
import type { StoredOrderPii } from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import type { ChannelOrder } from '@omnibridge/provider-kit';
import { describe, expect, it } from 'vitest';
import { orderIngestStream } from './orders.ts';

const job = { workspaceId: 'w', channelAccountId: 'a' };
const at = new Date('2026-11-20T09:00:00Z');

const order = (over: Partial<ChannelOrder> = {}): ChannelOrder => ({
  externalId: 'O-1',
  updatedAt: at,
  status: 'PAID',
  state: 'awaiting_dispatch',
  placedAt: at,
  paidAt: at,
  shipBy: null,
  dispatchedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  discountPence: 0,
  shippingPence: 0,
  totalPence: null,
  shipToCountry: 'GB',
  fba: false,
  lines: [],
  refunds: [],
  buyer: { name: 'PIIMARK-A', address_line1: 'PIIMARK-1', postcode: 'TE1 1ST' },
  ...over,
});
const stored = (over: Partial<StoredOrderPii> = {}): StoredOrderPii => ({
  settled: true,
  piiRef: 'ref-1',
  live: true,
  status: 'awaiting_dispatch',
  paidAt: at,
  dispatchedAt: null,
  dispatchEstimated: false,
  deliveredAt: null,
  ...over,
});

/** What the vault-first step asked the vault, for one order db-main already holds. */
async function asked(o: ChannelOrder, known: StoredOrderPii) {
  const calls: string[] = [];
  const stream = orderIngestStream({
    tenancy: {
      runWorkspace: (_actor, fn) =>
        fn({ workspaceId: 'w', companyIds: [] } satisfies TenantContext),
    },
    ingest: {
      piiState: () =>
        Promise.resolve({
          orders: new Map([[o.externalId, known]]),
          provider: 'ebay' as const,
          retentionDays: 25,
        }),
      apply: () => Promise.resolve(),
    },
    vault: {
      ingest: () => {
        calls.push('ingest');
        return Promise.resolve({ pii_ref: 'ref-2' });
      },
      replace: () => {
        calls.push('replace');
        return Promise.resolve({ changed: true });
      },
    },
    logger: createLogger({ service: 'test', version: '0', destination: { write: () => true } }),
  });
  const [ready] = (await stream.prepare?.(job, [o])) ?? [];
  return { calls, kind: ready?.pii?.kind, buyer: ready?.buyer };
}

describe('the vault-first step for a stored order (ORD-4)', () => {
  it('[ORD-4] a paid order waiting on both sides has its address corrected', async () => {
    const whole = { calls: ['replace'], kind: 'replaced', buyer: null };
    expect(await asked(order(), stored())).toEqual(whole);
    expect(await asked(order(), stored({ status: 'label_created' }))).toEqual(whole);
    // Paid on either side is paid.
    expect(await asked(order({ paidAt: null }), stored())).toEqual(whole);
    expect(await asked(order(), stored({ paidAt: null }))).toEqual(whole);
  });

  it('[ORD-4][DEL-1] no other stored order asks the vault for anything', async () => {
    const nothing = { calls: [], kind: 'unchanged', buyer: null };
    const cases: [string, ChannelOrder, StoredOrderPii][] = [
      ['dispatch date known', order(), stored({ dispatchedAt: at })],
      ['shipped', order(), stored({ status: 'dispatched' })],
      ['cancelled', order(), stored({ status: 'cancelled' })],
      ['not paid', order({ paidAt: null }), stored({ paidAt: null })],
      ['record deleted', order(), stored({ live: false })],
      ['never had a record', order(), stored({ piiRef: null, live: false })],
      ['shipped in this update', order({ state: 'dispatched' }), stored()],
      ['no buyer sent', order({ buyer: null }), stored()],
      ['no address', order({ buyer: { name: 'PIIMARK-A', postcode: 'TE1 1ST' } }), stored()],
    ];
    for (const [name, o, known] of cases) expect(await asked(o, known), name).toEqual(nothing);
  });
});
