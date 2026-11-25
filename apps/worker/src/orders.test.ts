import type { TenantContext } from '@omnibridge/core';
import type { StoredOrderPii } from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import type { ChannelOrder } from '@omnibridge/provider-kit';
import { describe, expect, it } from 'vitest';
import { orderIngestStream, ordersOrphanSweepHandler, ordersPiiExpiryHandler } from './orders.ts';

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
  cancelRequested: false,
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

const prepared = <T>(payload: T) => ({
  jobId: 'j',
  envelope: { workspace_id: 'w', idempotency_key: 'k', attempt: 1, type: 't', payload },
  payload,
  attempt: 1,
  progress: () => Promise.resolve(),
});
const tenancy = {
  runWorkspace: <T>(_actor: unknown, fn: (ctx: TenantContext) => Promise<T>) =>
    fn({ workspaceId: 'w', companyIds: [] }),
};
const logger = createLogger({ service: 'test', version: '0', destination: { write: () => true } });
const DAY = 86_400_000;

describe('the nightly orphan sweep (FA-10)', () => {
  it('[ORD-4][DEL-1] it looks only at records a day old, reads every page, and expires only those no order points at', async () => {
    const now = new Date('2026-11-20T03:00:00Z');
    const asked: { before: string; after: string | undefined }[] = [];
    const expired: { refs: readonly string[]; at: string; reason: string }[] = [];
    const pages = [
      { records: ['r1', 'r2'], next: 'r2' },
      { records: ['r3'], next: 'r3' },
      { records: ['r4', 'r5'], next: null },
    ];
    const sweep = ordersOrphanSweepHandler({
      tenancy,
      ingest: { knownPiiRefs: () => Promise.resolve(new Set(['r1', 'r4'])) },
      vault: {
        subjects: (req) => {
          asked.push({ before: req.created_before, after: req.after });
          const page = pages[asked.length - 1];
          return Promise.resolve({
            records: (page?.records ?? []).map((r) => ({ pii_ref: r, subject_id: r })),
            next: page?.next ?? null,
          });
        },
        setExpiry: (req) => {
          expired.push({ refs: req.pii_refs, at: req.delete_after, reason: req.reason });
          return Promise.resolve({ updated: req.pii_refs.length });
        },
      },
      logger,
      now: () => now,
    });
    expect(await sweep.prepare(prepared({}))).toEqual({ orphans: 3 });
    const before = new Date(now.getTime() - DAY).toISOString();
    expect(asked).toEqual([
      { before, after: undefined },
      { before, after: 'r2' },
      { before, after: 'r3' },
    ]);
    expect(expired).toEqual([
      { refs: ['r2'], at: now.toISOString(), reason: 'orphan' },
      { refs: ['r3'], at: now.toISOString(), reason: 'orphan' },
      { refs: ['r5'], at: now.toISOString(), reason: 'orphan' },
    ]);
  });
});

describe('the expiry job (DEL-1)', () => {
  const run = async (dates: {
    placed: number;
    dispatched: number | null;
    delivered: number | null;
  }) => {
    const now = new Date('2026-11-20T10:00:00Z');
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const asked: string[] = [];
    const handler = ordersPiiExpiryHandler({
      tenancy,
      ingest: {
        piiExpiryOf: () =>
          Promise.resolve([
            {
              orderId: 'o',
              piiRef: 'r',
              placedAt: ago(dates.placed),
              dispatchedAt: dates.dispatched === null ? null : ago(dates.dispatched),
              deliveredAt: dates.delivered === null ? null : ago(dates.delivered),
            },
          ]),
        retentionDays: () => Promise.resolve(25),
      },
      vault: {
        setExpiry: (req) => {
          asked.push(req.delete_after);
          return Promise.resolve({ updated: 1 });
        },
      },
      now: () => now,
    });
    await handler.prepare(prepared({ order_id: 'o', reason: 'dispatch' as const }));
    return (Date.parse(asked[0] ?? '') - now.getTime()) / DAY;
  };

  it('[DEL-1][AT-8] delivery wins over dispatch, the limit is placement + 90 days, and a past date is sent as now', async () => {
    expect(await run({ placed: 20, dispatched: 18, delivered: null })).toBe(7);
    expect(await run({ placed: 20, dispatched: 18, delivered: 10 })).toBe(15);
    expect(await run({ placed: 80, dispatched: 10, delivered: 1 })).toBe(10);
    expect(await run({ placed: 80, dispatched: 60, delivered: null })).toBe(0);
    expect(await run({ placed: 120, dispatched: 100, delivered: 99 })).toBe(0);
  });

  it('[DEL-1] an order the job is not given changes nothing', async () => {
    const handler = ordersPiiExpiryHandler({
      tenancy,
      ingest: { piiExpiryOf: () => Promise.resolve([]), retentionDays: () => Promise.resolve(25) },
      vault: { setExpiry: () => Promise.reject(new Error('not asked')) },
    });
    const job = prepared({ order_id: 'o', reason: 'delivery' as const });
    expect(await handler.prepare(job)).toEqual({ updated: 0 });
  });
});

describe('the vault-first step for a stored order (ORD-4)', () => {
  it('[ORD-4] a paid order waiting on both sides has its address corrected', async () => {
    const whole = { calls: ['replace'], kind: 'replaced', buyer: null };
    expect(await asked(order(), stored())).toEqual(whole);
    expect(await asked(order(), stored({ status: 'label_created' }))).toEqual(whole);
    // Paid on either side is paid.
    expect(await asked(order({ paidAt: null }), stored())).toEqual(whole);
    expect(await asked(order(), stored({ paidAt: null }))).toEqual(whole);
  });

  it('[DEL-1] a record not stored yet counts from the earlier of a stand-in and the real date', async () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    const kind = async (stand: number, real: number | null, dispatchEstimated = true) =>
      (
        await asked(
          order({
            state: 'dispatched',
            placedAt: ago(50),
            updatedAt: ago(0),
            dispatchedAt: real === null ? null : ago(real),
          }),
          stored({
            settled: false,
            piiRef: null,
            live: false,
            status: 'dispatched',
            dispatchedAt: ago(stand),
            dispatchEstimated,
          }),
        )
      ).kind;
    expect(await kind(10, null)).toBe('stored');
    expect(await kind(10, 40)).toBe('none');
    // A window that has passed is never started again, and a real stored date stands.
    expect(await kind(40, 1)).toBe('none');
    expect(await kind(10, 40, false)).toBe('stored');
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
