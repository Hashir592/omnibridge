import { randomUUID } from 'node:crypto';
import { pence, type TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogueRepository } from './catalogue.ts';
import { migrateMain } from './migrate.ts';
import { OrderReads, type OrderFilter } from './order-reads.ts';
import { OrderIngest, type IncomingOrder, type OrderIngestPorts } from './orders.ts';
import { OutboundWriteRepository } from './outbound.ts';
import type { MainDb } from './schema.ts';
import { StockEngine } from './stock.ts';
import { Tenancy, withTenantTransaction } from './tenant.ts';

const ROLES = ['ob_owner', 'ob_app'] as const;
const p = (n: number) => pence(BigInt(n));

/**
 * T-1001 order ingest on real PostgreSQL (ORD-3, ORD-4, VAT-1 to VAT-7, FA-10 to FA-12, FA-16):
 * the sink of the sync job, after the vault-first step. Every test drives `apply` the way a poll
 * does, including replays and late, out-of-order updates.
 */
describe('order ingest (T-1001)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let catalogue: CatalogueRepository;
  let writes: OutboundWriteRepository;
  let clock = new Date('2026-11-10T12:00:00.000Z');
  const calls: { op: 'cancel' | 'shorten' | 'total'; orderId: string; detail: string }[] = [];
  const ports: OrderIngestPorts = {
    cancelPii: (_ctx, input) => {
      calls.push({ op: 'cancel', orderId: input.orderId, detail: input.piiSubject });
      return Promise.resolve();
    },
    shortenPii: (_ctx, input) => {
      const detail = input.real === true ? `${input.reason} real` : input.reason;
      calls.push({ op: 'shorten', orderId: input.orderId, detail });
      return Promise.resolve();
    },
    totalMismatch: (_ctx, input) => {
      calls.push({ op: 'total', orderId: input.orderId, detail: input.channelAccountId });
      return Promise.resolve();
    },
    lateMapped: (_ctx, input) => {
      late.push({ listingId: input.listingId, masterSkuId: input.masterSkuId, key: input.key });
      return Promise.resolve();
    },
    regroup: (_ctx, input) => {
      regroups.push(input.channelAccountId);
      return Promise.resolve();
    },
  };
  const regroups: string[] = [];
  const late: { listingId: string; masterSkuId: string; key: string }[] = [];
  const oversold: string[] = [];
  let ingest: OrderIngest;
  let stock: StockEngine;

  interface World {
    ctx: TenantContext;
    company: string;
    account: string;
    std: string;
    zero: string;
    listings: { std: string; zero: string; unmapped: string };
  }

  const world = async (): Promise<World> => {
    const ctx: TenantContext = { workspaceId: randomUUID(), companyIds: [randomUUID()] };
    const company = ctx.companyIds[0] ?? '';
    const account = randomUUID();
    await withTenantTransaction(db, ctx, async (trx) => {
      await trx
        .insertInto('app.workspaces')
        .values({ id: ctx.workspaceId, name: 'Orders' })
        .execute();
      await trx
        .insertInto('app.companies')
        .values({
          id: company,
          workspace_id: ctx.workspaceId,
          legal_name: 'Orders Ltd',
          trading_name: 'Orders',
          address_line1: '1 Test Street',
          address_city: 'Testville',
          address_postcode: 'TE1 1ST',
        })
        .execute();
      await trx
        .insertInto('app.channel_accounts')
        .values({
          id: account,
          workspace_id: ctx.workspaceId,
          company_id: company,
          provider: 'ebay',
          display_name: 'ebay',
        })
        .execute();
      // Connected on 1 Nov: orders placed before it are cutover history (FA-16).
      await sql`UPDATE app.channel_accounts SET created_at = '2026-11-01T00:00:00Z'
                 WHERE id = ${account}::uuid`.execute(trx);
    });
    const std = await catalogue.createSku(
      ctx,
      {
        sku: 'STD-1',
        title: 'Standard',
        shortDescription: 's',
        weightG: 1,
        vatType: 'standard',
        firstCogs: { cogsPence: p(400), effectiveFrom: '2026-01-01' },
      },
      null,
      clock,
    );
    const zero = await catalogue.createSku(
      ctx,
      {
        sku: 'ZERO-1',
        title: 'Zero',
        shortDescription: 'z',
        weightG: 1,
        vatType: 'zero',
        firstCogs: { cogsPence: p(200), effectiveFrom: '2026-01-01' },
      },
      null,
      clock,
    );
    const found = await catalogue.upsertDiscovered(
      ctx,
      account,
      'ebay',
      ['STD-1', 'ZERO-1', 'NEW-ITEM'].map((code) => ({
        externalSku: code,
        externalId: `${code}-id`,
        title: null,
        fulfilment: null,
        inventoryApi: null,
        quantity: null,
      })),
      clock,
    );
    const listingOf = async (code: string) => {
      const { rows } = await withTenantTransaction(db, ctx, (trx) =>
        sql<{ id: string }>`SELECT id FROM app.listings WHERE external_sku = ${code}`.execute(trx),
      );
      return rows[0]?.id ?? '';
    };
    expect(found.autoMapped).toHaveLength(2);
    for (const sku of [std, zero]) {
      await stock.stockIn(ctx, sku, { quantity: 10, clientRef: randomUUID(), userId: null });
    }
    return {
      ctx,
      company,
      account,
      std,
      zero,
      listings: {
        std: await listingOf('STD-1'),
        zero: await listingOf('ZERO-1'),
        unmapped: await listingOf('NEW-ITEM'),
      },
    };
  };

  const order = (over: Partial<IncomingOrder> = {}): IncomingOrder => ({
    externalId: `ORD-${randomUUID().slice(0, 8)}`,
    rawStatus: 'NOT_STARTED/PAID',
    state: 'awaiting_dispatch',
    updatedAt: new Date('2026-11-10T09:00:00.000Z'),
    placedAt: new Date('2026-11-10T08:00:00.000Z'),
    paidAt: new Date('2026-11-10T08:01:00.000Z'),
    shipBy: null,
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    discount: p(0),
    shipping: p(300),
    channelTotal: null,
    shipToCountry: 'GB',
    fba: false,
    lines: [
      { lineId: 'L1', sku: 'STD-1', quantity: 1, title: 'Standard', linePrice: p(1200) },
      { lineId: 'L2', sku: 'ZERO-1', quantity: 1, title: 'Zero', linePrice: p(600) },
    ],
    refunds: [],
    pii: { kind: 'stored', piiRef: randomUUID() },
    ...over,
  });

  const q = async <T extends object>(w: World, query: ReturnType<typeof sql<T>>) =>
    (await withTenantTransaction(db, w.ctx, (trx) => query.execute(trx))).rows;
  const orderRow = async (w: World, externalId: string) =>
    (
      await q<Record<string, unknown>>(
        w,
        sql`SELECT * FROM app.orders WHERE external_order_id = ${externalId}`,
      )
    )[0];
  const ledger = (w: World, orderId: unknown) =>
    q<{
      kind: string;
      group_key: string;
      gross_pence: string;
      vat_pence: string;
      tax_point_date: string;
      period_date: string;
      provisional: boolean;
    }>(
      w,
      sql`SELECT kind, group_key, gross_pence, vat_pence, provisional,
                 to_char(tax_point_date, 'YYYY-MM-DD') AS tax_point_date,
                 to_char(period_date, 'YYYY-MM-DD') AS period_date
            FROM app.vat_ledger WHERE order_id = ${String(orderId)}::uuid ORDER BY created_at, group_key`,
    );
  const movements = (w: World, orderId: unknown) =>
    q<{ kind: string; order_line_id: string }>(
      w,
      sql`SELECT m.kind, m.order_line_id FROM app.stock_movements m
           JOIN app.order_lines l ON l.workspace_id = m.workspace_id AND l.id::text = m.order_line_id
          WHERE l.order_id = ${String(orderId)}::uuid ORDER BY m.created_at, m.kind`,
    );

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 4 }),
      }),
    });
    catalogue = new CatalogueRepository(db);
    writes = new OutboundWriteRepository(db);
    stock = new StockEngine(db, {
      pushes: { enqueue: (ctx, input) => writes.insert(ctx, input, clock) },
      notifier: {
        raise: (_ctx, input) => {
          if (input.type === 'inventory.oversold') oversold.push(input.record.id);
          return Promise.resolve({ id: randomUUID(), created: true, reopened: false } as never);
        },
        resolve: () => Promise.resolve(true),
      },
      demand: {
        lockOrders: (ctx, listingId) => ingest.lockOrders(ctx, listingId),
        openLines: (ctx, listingId) => ingest.openLines(ctx, listingId),
        markOversold: (ctx, orderLineId) => ingest.markOversold(ctx, orderLineId),
      },
      now: () => clock,
    });
    ingest = new OrderIngest(db, { catalogue, stock, ports, now: () => clock });
  }, 300_000);

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  it('[AT-15][VAT-1][VAT-3][VAT-4] a paid order writes sale VAT per rate group at the tax point', async () => {
    const w = await world();
    const o = order();
    await ingest.apply(w.ctx, w.account, [o]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({
      status: 'awaiting_dispatch',
      gross_pence: '2100',
      vat_pence: '233',
    });
    const rows = await ledger(w, row?.id);
    expect(
      rows.map((r) => [r.kind, r.group_key, r.gross_pence, r.vat_pence, r.tax_point_date]),
    ).toEqual([
      ['sale', 'rate:2000', '1400', '233', '2026-11-10'],
      ['sale', 'zero:zero', '700', '0', '2026-11-10'],
    ]);
    const lines = await q<{
      vat_pence: string;
      vat_type: string;
      vat_rate_bp: string;
      cogs_pence: string;
    }>(
      w,
      sql`SELECT vat_pence, vat_type, vat_rate_bp, cogs_pence FROM app.order_lines
           WHERE order_id = ${String(row?.id)}::uuid ORDER BY line_no`,
    );
    expect(lines).toEqual([
      { vat_pence: '233', vat_type: 'standard', vat_rate_bp: '2000', cogs_pence: '400' },
      { vat_pence: '0', vat_type: 'zero', vat_rate_bp: '0', cogs_pence: '200' },
    ]);
  });

  it('[ORD-3][ORD-4] a replayed page and late, out-of-order updates never duplicate an order, line, ledger row or movement', async () => {
    const w = await world();
    const o = order();
    for (let i = 0; i < 3; i++) await ingest.apply(w.ctx, w.account, [o]);
    const dispatched = {
      ...o,
      state: 'dispatched' as const,
      rawStatus: 'FULFILLED/PAID',
      updatedAt: new Date('2026-11-11T09:00:00Z'),
      dispatchedAt: new Date('2026-11-11T09:00:00Z'),
    };
    await ingest.apply(w.ctx, w.account, [dispatched]);
    await ingest.apply(w.ctx, w.account, [dispatched]);
    // A late copy of the first update arrives after the dispatch: it never moves the order back.
    await ingest.apply(w.ctx, w.account, [o]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({ status: 'dispatched', raw_status: 'FULFILLED/PAID' });
    const counts = await q<{ orders: string; lines: string; events: string }>(
      w,
      sql`SELECT (SELECT count(*) FROM app.orders WHERE external_order_id = ${o.externalId}) AS orders,
                 (SELECT count(*) FROM app.order_lines WHERE order_id = ${String(row?.id)}::uuid) AS lines,
                 (SELECT count(*) FROM app.order_status_events WHERE order_id = ${String(row?.id)}::uuid) AS events`,
    );
    expect(counts[0]).toEqual({ orders: '1', lines: '2', events: '2' });
    expect(await ledger(w, row?.id)).toHaveLength(2);
    expect((await movements(w, row?.id)).map((m) => m.kind).sort()).toEqual([
      'dispatch',
      'dispatch',
      'reserve',
      'reserve',
    ]);
  });

  it('[AT-16][VAT-5] a £6 refund on a £12 standard line reduces output VAT by £1.00 in the refund quarter', async () => {
    const w = await world();
    const o = order({
      lines: [{ lineId: 'L1', sku: 'STD-1', quantity: 1, title: null, linePrice: p(1200) }],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    const refunded = {
      ...o,
      state: 'dispatched' as const,
      dispatchedAt: new Date('2026-11-11T09:00:00Z'),
      updatedAt: new Date('2027-01-05T10:00:00Z'),
      refunds: [
        {
          refundId: 'R1',
          refundedAt: new Date('2027-01-05T10:00:00Z'),
          amount: p(600),
          lines: null,
        },
      ],
    };
    await ingest.apply(w.ctx, w.account, [refunded]);
    await ingest.apply(w.ctx, w.account, [refunded]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({ status: 'partly_refunded' });
    const rows = await ledger(w, row?.id);
    expect(
      rows
        .filter((r) => r.kind === 'refund')
        .map((r) => [r.gross_pence, r.vat_pence, r.tax_point_date]),
    ).toEqual([['-600', '-100', '2027-01-05']]);
  });

  it('[VAT-5] two £7 refunds on a £14 standard group give back 233p in total (FA-12 cap)', async () => {
    const w = await world();
    const o = order({
      lines: [{ lineId: 'L1', sku: 'STD-1', quantity: 2, title: null, linePrice: p(1400) }],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    const r1 = {
      refundId: 'R1',
      refundedAt: new Date('2026-11-12T10:00:00Z'),
      amount: p(700),
      lines: null,
    };
    const r2 = {
      refundId: 'R2',
      refundedAt: new Date('2026-11-13T10:00:00Z'),
      amount: p(700),
      lines: null,
    };
    const shipped = {
      state: 'dispatched' as const,
      dispatchedAt: new Date('2026-11-11T09:00:00Z'),
    };
    await ingest.apply(w.ctx, w.account, [
      { ...o, ...shipped, updatedAt: new Date('2026-11-12T10:00:00Z'), refunds: [r1] },
    ]);
    await ingest.apply(w.ctx, w.account, [
      { ...o, ...shipped, updatedAt: new Date('2026-11-13T10:00:00Z'), refunds: [r1, r2] },
    ]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({ status: 'refunded' });
    const refunds = (await ledger(w, row?.id)).filter((r) => r.kind === 'refund');
    expect(refunds.map((r) => r.vat_pence)).toEqual(['-117', '-116']);
  });

  it('[VAT-6] an order cancelled before payment is captured has no VAT; its stock is released', async () => {
    const w = await world();
    const o = order({ state: 'pending_payment', rawStatus: 'NOT_STARTED/PENDING', paidAt: null });
    await ingest.apply(w.ctx, w.account, [o]);
    const cancelled = {
      ...o,
      state: 'cancelled' as const,
      rawStatus: 'CANCELED',
      updatedAt: new Date('2026-11-10T10:00:00Z'),
    };
    await ingest.apply(w.ctx, w.account, [cancelled]);
    await ingest.apply(w.ctx, w.account, [{ ...o, updatedAt: new Date('2026-11-10T11:00:00Z') }]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({ status: 'cancelled' });
    expect(await ledger(w, row?.id)).toEqual([]);
    expect((await movements(w, row?.id)).map((m) => m.kind).sort()).toEqual([
      'release',
      'release',
      'reserve',
      'reserve',
    ]);
  });

  it('[DEL-1][ORD-4] cancellation deletes the buyer record once; dispatch and delivery move its expiry', async () => {
    const w = await world();
    const cancelled = order();
    await ingest.apply(w.ctx, w.account, [cancelled]);
    const gone = {
      ...cancelled,
      state: 'cancelled' as const,
      updatedAt: new Date('2026-11-10T10:00:00Z'),
    };
    await ingest.apply(w.ctx, w.account, [gone]);
    await ingest.apply(w.ctx, w.account, [gone]);
    const shipped = order();
    await ingest.apply(w.ctx, w.account, [shipped]);
    const d1 = {
      ...shipped,
      state: 'dispatched' as const,
      dispatchedAt: new Date('2026-11-11T09:00:00Z'),
      updatedAt: new Date('2026-11-11T09:00:00Z'),
    };
    await ingest.apply(w.ctx, w.account, [d1]);
    await ingest.apply(w.ctx, w.account, [d1]);
    await ingest.apply(w.ctx, w.account, [
      {
        ...d1,
        state: 'delivered',
        deliveredAt: new Date('2026-11-12T09:00:00Z'),
        updatedAt: new Date('2026-11-12T09:00:00Z'),
      },
    ]);
    const cancelId = String((await orderRow(w, cancelled.externalId))?.id);
    const shipId = String((await orderRow(w, shipped.externalId))?.id);
    expect(calls.filter((c) => c.orderId === cancelId)).toEqual([
      { op: 'cancel', orderId: cancelId, detail: `${w.account}:${cancelled.externalId}` },
    ]);
    expect(calls.filter((c) => c.orderId === shipId).map((c) => c.detail)).toEqual([
      'dispatch',
      'delivery',
    ]);
  });

  it('[ORD-4] a refused or missing buyer record keeps the order with no customer details (FA-16, ADR-068)', async () => {
    const w = await world();
    const refused = order({ pii: { kind: 'refused' } });
    const none = order({ pii: { kind: 'none' } });
    await ingest.apply(w.ctx, w.account, [refused, none]);
    const r = await orderRow(w, refused.externalId);
    const n = await orderRow(w, none.externalId);
    expect(r?.pii_ref).toBeNull();
    expect(r?.pii_deleted_at).toBeInstanceOf(Date);
    expect(n).toMatchObject({ pii_ref: null, pii_deleted_at: null });
  });

  it('[AT-6][VAT-7] a later COGS or VAT-type change leaves earlier orders alone; snapshots are write-once', async () => {
    const w = await world();
    const before = order();
    await ingest.apply(w.ctx, w.account, [before]);
    await catalogue.setCogs(w.ctx, w.std, p(550), '2026-11-15', null, clock);
    await catalogue.updateSku(
      w.ctx,
      w.std,
      { vat: { vatType: 'reduced', effectiveFrom: '2026-11-15' } },
      null,
      clock,
    );
    const after = order({
      placedAt: new Date('2026-11-16T08:00:00Z'),
      updatedAt: new Date('2026-11-16T09:00:00Z'),
    });
    await ingest.apply(w.ctx, w.account, [after]);
    const line = async (externalId: string) =>
      (
        await q<{ id: string; cogs_pence: string; vat_type: string; vat_rate_bp: string }>(
          w,
          sql`SELECT l.id, l.cogs_pence, l.vat_type, l.vat_rate_bp FROM app.order_lines l
               JOIN app.orders o ON o.workspace_id = l.workspace_id AND o.id = l.order_id
              WHERE o.external_order_id = ${externalId} AND l.line_no = 1`,
        )
      )[0];
    expect(await line(before.externalId)).toMatchObject({
      cogs_pence: '400',
      vat_type: 'standard',
      vat_rate_bp: '2000',
    });
    expect(await line(after.externalId)).toMatchObject({
      cogs_pence: '550',
      vat_type: 'reduced',
      vat_rate_bp: '500',
    });
    const id = (await line(before.externalId))?.id ?? '';
    await expect(
      q(w, sql<object>`UPDATE app.order_lines SET cogs_pence = 999 WHERE id = ${id}::uuid`),
    ).rejects.toThrow(/write-once/);
    await expect(
      q(w, sql<object>`UPDATE app.order_lines SET vat_rate_bp = 500 WHERE id = ${id}::uuid`),
    ).rejects.toThrow(/write-once/);
  });

  it('[VAT-2][CAT-6] an unmapped line counts at the default rate and is provisional; mapping fills it once and back-fills stock (FA-11)', async () => {
    const w = await world();
    const o = order({
      lines: [{ lineId: 'L1', sku: 'NEW-ITEM', quantity: 2, title: null, linePrice: p(1200) }],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({ unmapped: true, vat_pence: '200' });
    expect(
      (await ledger(w, row?.id)).map((r) => [r.group_key, r.vat_pence, r.provisional]),
    ).toEqual([['rate:2000', '200', true]]);
    expect(await movements(w, row?.id)).toEqual([]);
    // Mapped to the zero-rated SKU: the snapshot fills with the order date's values, once.
    const change = await catalogue.mapListing(
      w.ctx,
      w.listings.unmapped,
      w.zero,
      'manual',
      null,
      clock,
    );
    expect(change).not.toBeNull();
    await stock.onListingMapped(w.ctx, {
      listingId: w.listings.unmapped,
      masterSkuId: w.zero,
      previousMasterSkuId: null,
    });
    expect(await ingest.fillSnapshots(w.ctx, w.listings.unmapped)).toEqual({ filled: 1 });
    expect(await ingest.fillSnapshots(w.ctx, w.listings.unmapped)).toEqual({ filled: 0 });
    const after = await orderRow(w, o.externalId);
    expect(after).toMatchObject({ unmapped: false, vat_pence: '0' });
    const rows = await ledger(w, row?.id);
    // The provisional group comes off and the zero group goes on, in the open period (VQ-3).
    expect(
      rows
        .filter((r) => r.kind === 'adjustment')
        .map((r) => [r.group_key, r.gross_pence, r.vat_pence]),
    ).toEqual([
      ['rate:2000', '-1200', '-200'],
      ['zero:zero', '1200', '0'],
    ]);
    expect((await movements(w, row?.id)).map((m) => m.kind)).toEqual(['reserve']);
  });

  it('[VAT-2][VAT-3][FIN-1] mapping many lines of one listing at once loses no VAT ledger row', async () => {
    for (const target of ['zero', 'reduced'] as const) {
      const w = await world();
      const lines = Array.from({ length: 8 }, (_, i) => ({
        lineId: `L${String(i + 1)}`,
        sku: 'NEW-ITEM',
        quantity: 1,
        title: null,
        linePrice: p(1200),
      }));
      const o = order({ lines, shipping: p(0) });
      await ingest.apply(w.ctx, w.account, [o]);
      // A refund made while the lines are provisional is re-based with them.
      await ingest.apply(w.ctx, w.account, [
        {
          ...o,
          state: 'dispatched',
          dispatchedAt: new Date('2026-11-11T09:00:00Z'),
          updatedAt: new Date('2026-11-12T09:00:00Z'),
          refunds: [
            {
              refundId: 'R1',
              refundedAt: new Date('2026-11-12T09:00:00Z'),
              amount: p(1200),
              lines: null,
            },
          ],
        },
      ]);
      let sku = w.zero;
      if (target === 'reduced') {
        sku = await catalogue.createSku(
          w.ctx,
          {
            sku: 'RED-1',
            title: 'Reduced',
            shortDescription: 'r',
            weightG: 1,
            vatType: 'reduced',
            firstCogs: { cogsPence: p(200), effectiveFrom: '2026-01-01' },
          },
          null,
          clock,
        );
      }
      await catalogue.mapListing(w.ctx, w.listings.unmapped, sku, 'manual', null, clock);
      expect(await ingest.fillSnapshots(w.ctx, w.listings.unmapped)).toEqual({ filled: 8 });
      const row = await orderRow(w, o.externalId);
      const totals = await q<{ group_key: string; gross: string; vat: string }>(
        w,
        sql`SELECT group_key, sum(gross_pence) AS gross, sum(vat_pence) AS vat FROM app.vat_ledger
             WHERE order_id = ${String(row?.id)}::uuid GROUP BY group_key ORDER BY group_key`,
      );
      // 8 x £12 less the £12 refund, all in the mapped group; the provisional group nets to 0.
      expect(totals.filter((t) => t.gross !== '0' || t.vat !== '0')).toEqual([
        target === 'zero'
          ? { group_key: 'zero:zero', gross: '8400', vat: '0' }
          : { group_key: 'rate:500', gross: '8400', vat: '400' },
      ]);
    }
  });

  it('[VAT-5][FIN-1] a refund that lists one line twice keeps the whole amount on that line', async () => {
    const w = await world();
    const o = order({ shipping: p(0) });
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [
      {
        ...o,
        state: 'dispatched',
        dispatchedAt: new Date('2026-11-11T09:00:00Z'),
        updatedAt: new Date('2026-11-12T09:00:00Z'),
        refunds: [
          {
            refundId: 'R1',
            refundedAt: new Date('2026-11-12T09:00:00Z'),
            amount: p(800),
            lines: [
              { lineId: 'L1', quantity: 1, amount: p(600) },
              { lineId: 'L1', quantity: 0, amount: p(200) },
            ],
          },
        ],
      },
    ]);
    const row = await orderRow(w, o.externalId);
    const stored = await q<{ quantity: string; amount_pence: string }>(
      w,
      sql`SELECT rl.quantity, rl.amount_pence FROM app.refund_lines rl
            JOIN app.refunds r ON r.workspace_id = rl.workspace_id AND r.id = rl.refund_id
           WHERE r.order_id = ${String(row?.id)}::uuid`,
    );
    expect(stored).toEqual([{ quantity: '1', amount_pence: '800' }]);
    const refunds = (await ledger(w, row?.id)).filter((r) => r.kind === 'refund');
    expect(refunds.map((r) => [r.group_key, r.gross_pence])).toEqual([['rate:2000', '-800']]);
  });

  /** A SKU code the channel sells before any scan has seen its listing. */
  const lateItem = async (w: World, vatType: 'zero' | 'standard' = 'zero', onHand = 10) => {
    const sku = await catalogue.createSku(
      w.ctx,
      {
        sku: 'LATE-ITEM',
        title: 'Late',
        shortDescription: 'l',
        weightG: 1,
        vatType,
        firstCogs: { cogsPence: p(300), effectiveFrom: '2026-01-01' },
      },
      null,
      clock,
    );
    await stock.stockIn(w.ctx, sku, { quantity: onHand, clientRef: randomUUID(), userId: null });
    return sku;
  };
  const discover = (w: World, code = 'LATE-ITEM', account = w.account) =>
    catalogue.upsertDiscovered(
      w.ctx,
      account,
      'ebay',
      [
        {
          externalSku: code,
          externalId: `${code}-id`,
          title: null,
          fulfilment: null,
          inventoryApi: null,
          quantity: null,
        },
      ],
      clock,
    );
  const lateOrder = (over: Partial<IncomingOrder> = {}, quantity = 1) =>
    order({
      lines: [{ lineId: 'L1', sku: 'LATE-ITEM', quantity, title: null, linePrice: p(1200) }],
      shipping: p(0),
      ...over,
    });
  /** What the catalogue.listing_mapped job runs (CAT-6). */
  const mapped = async (w: World, change: { listingId: string; masterSkuId: string }) => {
    await stock.onListingMapped(w.ctx, { ...change, previousMasterSkuId: null });
    return ingest.fillSnapshots(w.ctx, change.listingId);
  };
  const level = async (w: World, sku: string) =>
    (
      await q<{ on_hand: string; reserved: string }>(
        w,
        sql`SELECT on_hand, reserved FROM app.stock_levels WHERE master_sku_id = ${sku}::uuid`,
      )
    )[0];
  const totals = (w: World, orderId: unknown) =>
    q<{ group_key: string; gross: string; vat: string }>(
      w,
      sql`SELECT group_key, sum(gross_pence) AS gross, sum(vat_pence) AS vat FROM app.vat_ledger
           WHERE order_id = ${String(orderId)}::uuid GROUP BY group_key ORDER BY group_key`,
    );
  const shippedOn = (o: IncomingOrder): IncomingOrder => ({
    ...o,
    state: 'dispatched',
    rawStatus: 'FULFILLED/PAID',
    dispatchedAt: new Date('2026-11-11T09:00:00Z'),
    updatedAt: new Date('2026-11-11T09:00:00Z'),
  });

  it('[CAT-6][INV-3][VAT-2] an order stored before its listing is discovered is linked when the scan matches it', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const o = lateOrder({}, 2);
    await ingest.apply(w.ctx, w.account, [o]);
    const id = (await orderRow(w, o.externalId))?.id;
    expect(await totals(w, id)).toEqual([{ group_key: 'rate:2000', gross: '1200', vat: '200' }]);
    const { autoMapped } = await discover(w);
    const change = autoMapped[0];
    if (change?.masterSkuId == null) throw new Error('not matched');
    expect(await mapped(w, { listingId: change.listingId, masterSkuId: sku })).toEqual({
      filled: 1,
    });
    // The job may run again: nothing moves or fills twice.
    expect(await mapped(w, { listingId: change.listingId, masterSkuId: sku })).toEqual({
      filled: 0,
    });
    expect(await orderRow(w, o.externalId)).toMatchObject({ unmapped: false, vat_pence: '0' });
    expect(await totals(w, id)).toEqual([
      { group_key: 'rate:2000', gross: '0', vat: '0' },
      { group_key: 'zero:zero', gross: '1200', vat: '0' },
    ]);
    expect(await level(w, sku)).toEqual({ on_hand: '10', reserved: '2' });
    // From here on it is an ordinary line: dispatch ships what it reserved.
    await ingest.apply(w.ctx, w.account, [shippedOn(o)]);
    expect(await level(w, sku)).toEqual({ on_hand: '8', reserved: '0' });
  });

  it('[CAT-6][INV-3][VAT-2] an order stored before its listing is discovered is linked when a person maps it', async () => {
    const w = await world();
    const o = lateOrder();
    await ingest.apply(w.ctx, w.account, [o]);
    expect((await discover(w)).autoMapped).toEqual([]);
    const [listing] = await q<{ id: string }>(
      w,
      sql`SELECT id FROM app.listings WHERE external_sku = 'LATE-ITEM'`,
    );
    const listingId = listing?.id ?? '';
    await catalogue.mapListing(w.ctx, listingId, w.zero, 'manual', null, clock);
    expect(await mapped(w, { listingId, masterSkuId: w.zero })).toEqual({ filled: 1 });
    expect(await orderRow(w, o.externalId)).toMatchObject({ unmapped: false, vat_pence: '0' });
    expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '1' });
  });

  it('[CAT-6][INV-3] an order dispatched before its listing was discovered takes its stock on mapping', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const o = lateOrder({}, 3);
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [shippedOn(o)]);
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    expect(await mapped(w, { listingId, masterSkuId: sku })).toEqual({ filled: 1 });
    expect(await level(w, sku)).toEqual({ on_hand: '7', reserved: '0' });
  });

  it('[CAT-6][INV-3] back-fill leaves cancelled orders and history from before the account alone', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const history = lateOrder({
      placedAt: new Date('2026-10-20T08:00:00Z'),
      updatedAt: new Date('2026-10-20T09:00:00Z'),
    });
    const cancelled = lateOrder();
    await ingest.apply(w.ctx, w.account, [history, cancelled]);
    await ingest.apply(w.ctx, w.account, [
      { ...cancelled, state: 'cancelled', updatedAt: new Date('2026-11-10T10:00:00Z') },
    ]);
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    // Their VAT snapshots still fill; their stock does not move.
    expect(await mapped(w, { listingId, masterSkuId: sku })).toEqual({ filled: 2 });
    expect(await level(w, sku)).toEqual({ on_hand: '10', reserved: '0' });
  });

  it('[CAT-6][TEN-5] a late line is linked only to a listing of its own channel account', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const other = randomUUID();
    await withTenantTransaction(db, w.ctx, (trx) =>
      trx
        .insertInto('app.channel_accounts')
        .values({
          id: other,
          workspace_id: w.ctx.workspaceId,
          company_id: w.company,
          provider: 'ebay',
          display_name: 'other',
        })
        .execute(),
    );
    const o = lateOrder();
    await ingest.apply(w.ctx, w.account, [o]);
    const listingId = (await discover(w, 'LATE-ITEM', other)).autoMapped[0]?.listingId ?? '';
    expect(await mapped(w, { listingId, masterSkuId: sku })).toEqual({ filled: 0 });
    expect(await orderRow(w, o.externalId)).toMatchObject({ unmapped: true });
    expect(await level(w, sku)).toEqual({ on_hand: '10', reserved: '0' });
  });

  it('[INV-6][CAT-6] a back-fill that takes available below 0 flags the line and the order, and raises Oversold', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const first = lateOrder({ placedAt: new Date('2026-11-10T07:00:00Z') }, 8);
    const second = lateOrder({ placedAt: new Date('2026-11-10T08:00:00Z') }, 5);
    const shipped = lateOrder({ placedAt: new Date('2026-11-10T06:00:00Z') }, 1);
    // Stored newest first: the earliest placed order still gets the stock.
    await ingest.apply(w.ctx, w.account, [second, first, shippedOn(shipped)]);
    oversold.length = 0;
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    await mapped(w, { listingId, masterSkuId: sku });
    await mapped(w, { listingId, masterSkuId: sku });
    expect(await level(w, sku)).toEqual({ on_hand: '9', reserved: '13' });
    const flags = async (o: IncomingOrder) => {
      const row = await orderRow(w, o.externalId);
      const [line] = await q<{ id: string; oversold: boolean }>(
        w,
        sql`SELECT id, oversold FROM app.order_lines WHERE order_id = ${String(row?.id)}::uuid`,
      );
      return { order: row?.oversold, line: line?.oversold, id: line?.id };
    };
    expect(await flags(first)).toMatchObject({ order: false, line: false });
    expect(await flags(shipped)).toMatchObject({ order: false, line: false });
    const hit = await flags(second);
    expect(hit).toMatchObject({ order: true, line: true });
    expect(oversold).toEqual([hit.id]);
  });

  it('[CAT-6][VAT-2] mapping links only the lines of its own SKU', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const line = (lineId: string, code: string) => ({
      lineId,
      sku: code,
      quantity: 1,
      title: null,
      linePrice: p(1200),
    });
    const o = order({
      lines: [line('L1', 'LATE-ITEM'), line('L2', 'OTHER-LATE')],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    expect(await mapped(w, { listingId, masterSkuId: sku })).toEqual({ filled: 1 });
    const lines = await q<{ listing_id: string | null; vat_type: string | null }>(
      w,
      sql`SELECT l.listing_id, l.vat_type FROM app.order_lines l
            JOIN app.orders o ON o.workspace_id = l.workspace_id AND o.id = l.order_id
           WHERE o.external_order_id = ${o.externalId} ORDER BY l.line_no`,
    );
    expect(lines).toEqual([
      { listing_id: listingId, vat_type: 'zero' },
      { listing_id: null, vat_type: null },
    ]);
    expect(await orderRow(w, o.externalId)).toMatchObject({ unmapped: true });
    expect(await level(w, sku)).toEqual({ on_hand: '10', reserved: '1' });
  });

  it('[CAT-6][VAT-2] the snapshot step links late lines by itself, and marks an FBA listing as such', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const o = lateOrder();
    await ingest.apply(w.ctx, w.account, [o]);
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    await q(
      w,
      sql<object>`UPDATE app.listings SET fulfilment = 'fba' WHERE id = ${listingId}::uuid`,
    );
    expect(await ingest.fillSnapshots(w.ctx, listingId)).toEqual({ filled: 1 });
    const [line] = await q<{ fba: boolean; master_sku_id: string }>(
      w,
      sql`SELECT l.fba, l.master_sku_id FROM app.order_lines l WHERE l.listing_id = ${listingId}::uuid`,
    );
    expect(line).toEqual({ fba: true, master_sku_id: sku });
    expect(await orderRow(w, o.externalId)).toMatchObject({ fba: true });
  });

  it('[INV-6][CAT-6] an order that has already shipped is never flagged Oversold by the back-fill', async () => {
    const w = await world();
    const sku = await lateItem(w, 'zero', 1);
    const o = lateOrder({}, 5);
    await ingest.apply(w.ctx, w.account, [shippedOn(o)]);
    oversold.length = 0;
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    await mapped(w, { listingId, masterSkuId: sku });
    expect(await level(w, sku)).toEqual({ on_hand: '-4', reserved: '0' });
    expect(await orderRow(w, o.externalId)).toMatchObject({ oversold: false });
    expect(oversold).toEqual([]);
  });

  it('[CAT-6][TEN-5] a page of one account reports only that account’s late lines', async () => {
    const w = await world();
    await lateItem(w);
    const other = randomUUID();
    await withTenantTransaction(db, w.ctx, (trx) =>
      trx
        .insertInto('app.channel_accounts')
        .values({
          id: other,
          workspace_id: w.ctx.workspaceId,
          company_id: w.company,
          provider: 'ebay',
          display_name: 'other',
        })
        .execute(),
    );
    await ingest.apply(w.ctx, w.account, [lateOrder()]);
    await discover(w);
    late.length = 0;
    await ingest.apply(w.ctx, other, [order()]);
    expect(late).toEqual([]);
    expect(await ingest.reportLateMapped(w.ctx, w.account)).toBe(1);
  });

  it('[CAT-6][INV-4] mapping locks stock before the listing, so a sale of the SKU cannot deadlock with it', async () => {
    const w = await world();
    const sku = await lateItem(w);
    await ingest.apply(w.ctx, w.account, [lateOrder()]);
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    let job: Promise<unknown> = Promise.resolve();
    // A sale in progress: it holds the stock row and then locks the SKU's listings.
    await withTenantTransaction(db, w.ctx, async (trx) => {
      await sql`SELECT 1 FROM app.stock_levels WHERE master_sku_id = ${sku}::uuid FOR UPDATE`.execute(
        trx,
      );
      job = mapped(w, { listingId, masterSkuId: sku });
      await new Promise((r) => setTimeout(r, 300));
      await sql`SELECT 1 FROM app.listings WHERE id = ${listingId}::uuid FOR UPDATE NOWAIT`.execute(
        trx,
      );
    });
    expect(await job).toEqual({ filled: 1 });
  });

  it('[CAT-6][INV-4] mapping never waits for an order that shipped before', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const o = lateOrder();
    await ingest.apply(w.ctx, w.account, [shippedOn(o)]);
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    await mapped(w, { listingId, masterSkuId: sku });
    await withTenantTransaction(db, w.ctx, async (trx) => {
      await sql`SELECT 1 FROM app.orders WHERE external_order_id = ${o.externalId} FOR UPDATE`.execute(
        trx,
      );
      const done = mapped(w, { listingId, masterSkuId: sku }).then(() => 'done');
      const late = new Promise<string>((r) => setTimeout(r, 3000, 'waited'));
      expect(await Promise.race([done, late])).toBe('done');
    });
  });

  it('[CAT-6][INV-3] a dispatch stored while the listing is being mapped is not lost', async () => {
    const w = await world();
    const o = order({
      lines: [{ lineId: 'L1', sku: 'NEW-ITEM', quantity: 2, title: null, linePrice: p(1200) }],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
    const tenancy = new Tenancy(db);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let stored: () => void = () => undefined;
    const isStored = new Promise<void>((r) => (stored = r));
    // The sync job's transaction, held open after it stored the dispatch. The line is linked to a
    // listing that this transaction may still see as unmapped, so it ships nothing itself.
    const unlinked = sql`UPDATE app.order_lines SET listing_id = NULL`;
    await withTenantTransaction(db, w.ctx, (trx) => unlinked.execute(trx));
    const sync = tenancy.runWorkspace({ workspaceId: w.ctx.workspaceId }, async (ctx) => {
      await ingest.apply(ctx, w.account, [shippedOn(o)]);
      stored();
      await gate;
    });
    await isStored;
    const job = mapped(w, { listingId: w.listings.unmapped, masterSkuId: w.zero });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await sync;
    expect(await job).toEqual({ filled: 1 });
    expect(await level(w, w.zero)).toEqual({ on_hand: '8', reserved: '0' });
  });

  it('[INV-3][CAT-6] a line dispatched between its mapping and the event holds nothing reserved', async () => {
    const w = await world();
    const o = order({
      lines: [{ lineId: 'L1', sku: 'NEW-ITEM', quantity: 2, title: null, linePrice: p(1200) }],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
    // The listing is mapped, its event has not run yet: the dispatch moves the stock itself.
    await ingest.apply(w.ctx, w.account, [shippedOn(o)]);
    expect(await level(w, w.zero)).toEqual({ on_hand: '8', reserved: '0' });
    const change = { listingId: w.listings.unmapped, masterSkuId: w.zero };
    expect(await mapped(w, change)).toEqual({ filled: 1 });
    expect(await mapped(w, change)).toEqual({ filled: 0 });
    expect(await level(w, w.zero)).toEqual({ on_hand: '8', reserved: '0' });
  });

  it('[INV-3][CAT-6] a dispatch of a linked line, stored while its listing is mapped, is not lost', async () => {
    const w = await world();
    const o = order({
      lines: [{ lineId: 'L1', sku: 'NEW-ITEM', quantity: 2, title: null, linePrice: p(1200) }],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let stored: () => void = () => undefined;
    const isStored = new Promise<void>((r) => (stored = r));
    // The sync job stores the dispatch while the listing is still unmapped, and is held open.
    const sync = new Tenancy(db).runWorkspace({ workspaceId: w.ctx.workspaceId }, async (ctx) => {
      await ingest.apply(ctx, w.account, [shippedOn(o)]);
      stored();
      await gate;
    });
    await isStored;
    await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
    const job = mapped(w, { listingId: w.listings.unmapped, masterSkuId: w.zero });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await sync;
    expect(await job).toEqual({ filled: 1 });
    expect(await level(w, w.zero)).toEqual({ on_hand: '8', reserved: '0' });
  });

  // ---- F-M10-end-10 and -20: one lock order ------------------------------------------------------

  /** The mapping event as the worker runs it: both listeners in one transaction. */
  const eventTx = (w: World, change: { listingId: string; masterSkuId: string }) =>
    new Tenancy(db).runWorkspace({ workspaceId: w.ctx.workspaceId }, async (ctx) => {
      await stock.onListingMapped(ctx, { ...change, previousMasterSkuId: null });
      return ingest.fillSnapshots(ctx, change.listingId);
    });
  /** One page, in a transaction of its own, as the worker stores it. */
  const pageTx = (w: World, account: string, orders: IncomingOrder[]) =>
    new Tenancy(db).runWorkspace({ workspaceId: w.ctx.workspaceId }, (ctx) =>
      ingest.apply(ctx, account, orders),
    );
  const failures = async (runs: Promise<unknown>[]) =>
    (await Promise.allSettled(runs)).flatMap((r) =>
      r.status === 'rejected' ? [(r.reason as { code?: string }).code ?? String(r.reason)] : [],
    );
  const newItem = (over: Partial<IncomingOrder> = {}) =>
    order({
      lines: [{ lineId: 'L1', sku: 'NEW-ITEM', quantity: 1, title: null, linePrice: p(1200) }],
      shipping: p(0),
      ...over,
    });
  /** `orders`, stored, sorted by the id db-main gave them. */
  const byId = async (w: World, orders: IncomingOrder[]) => {
    await ingest.apply(w.ctx, w.account, orders);
    const ids = new Map<string, string>();
    for (const o of orders) ids.set(o.externalId, String((await orderRow(w, o.externalId))?.id));
    return [...orders].sort((a, b) =>
      (ids.get(a.externalId) ?? '') < (ids.get(b.externalId) ?? '') ? -1 : 1,
    );
  };

  it('[INV-4][CAT-6] a mapping event and a page never deadlock: four open orders in falling id order', async () => {
    const seen: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      const w = await world();
      const open = await byId(
        w,
        Array.from({ length: 4 }, () => newItem()),
      );
      await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
      const change = { listingId: w.listings.unmapped, masterSkuId: w.zero };
      seen.push(
        ...(await failures([
          pageTx(w, w.account, [...open].reverse().map(shippedOn)),
          eventTx(w, change),
        ])),
      );
      expect(await level(w, w.zero)).toEqual({ on_hand: '6', reserved: '0' });
    }
    expect(seen).toEqual([]);
  });

  it('[INV-4][CAT-6] a mapping event and a page never deadlock: a new sale, then four open orders in rising id order', async () => {
    const seen: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      const w = await world();
      const open = await byId(
        w,
        Array.from({ length: 4 }, () => newItem()),
      );
      await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
      const change = { listingId: w.listings.unmapped, masterSkuId: w.zero };
      seen.push(
        ...(await failures([
          pageTx(w, w.account, [newItem(), ...open.map(shippedOn)]),
          eventTx(w, change),
        ])),
      );
      expect(await level(w, w.zero)).toEqual({ on_hand: '6', reserved: '1' });
    }
    expect(seen).toEqual([]);
  });

  it('[INV-4][CAT-6] a mapping event and a page never deadlock: five new sales', async () => {
    const seen: string[] = [];
    for (let run = 0; run < 12; run += 1) {
      const w = await world();
      await ingest.apply(w.ctx, w.account, [newItem()]);
      await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
      const change = { listingId: w.listings.unmapped, masterSkuId: w.zero };
      seen.push(
        ...(await failures([
          pageTx(
            w,
            w.account,
            Array.from({ length: 5 }, () => newItem()),
          ),
          eventTx(w, change),
        ])),
      );
      // A line stored while the event ran is reported by the next page, and then moves too.
      await eventTx(w, change);
      expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '6' });
    }
    expect(seen).toEqual([]);
  });

  it('[INV-4][CAT-6] a mapping event and a page never deadlock: shipped orders that were never priced', async () => {
    const seen: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      const w = await world();
      const all = await byId(
        w,
        Array.from({ length: 6 }, () => newItem()),
      );
      // Every other one shipped before the mapping; a page touches them all again, falling.
      await ingest.apply(w.ctx, w.account, all.filter((_, i) => i % 2 === 0).map(shippedOn));
      await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
      const change = { listingId: w.listings.unmapped, masterSkuId: w.zero };
      const later = (o: IncomingOrder): IncomingOrder => ({
        ...o,
        updatedAt: new Date('2026-11-12T09:00:00Z'),
      });
      seen.push(
        ...(await failures([
          pageTx(
            w,
            w.account,
            [...all].reverse().map((o) => later(shippedOn(o))),
          ),
          eventTx(w, change),
        ])),
      );
    }
    expect(seen).toEqual([]);
  });

  it('[INV-4][CAP-5] two accounts that sell the same SKUs in opposite order never deadlock', async () => {
    const seen: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      const w = await world();
      const other = randomUUID();
      await withTenantTransaction(db, w.ctx, async (trx) => {
        await trx
          .insertInto('app.channel_accounts')
          .values({
            id: other,
            workspace_id: w.ctx.workspaceId,
            company_id: w.company,
            provider: 'website',
            display_name: 'site',
          })
          .execute();
        await sql`UPDATE app.channel_accounts SET created_at = '2026-11-01T00:00:00Z'
                   WHERE id = ${other}::uuid`.execute(trx);
      });
      await catalogue.upsertDiscovered(
        w.ctx,
        other,
        'website',
        ['STD-1', 'ZERO-1'].map((code) => ({
          externalSku: code,
          externalId: `${code}-w`,
          title: null,
          fulfilment: null,
          inventoryApi: null,
          quantity: null,
        })),
        clock,
      );
      const sale = (sku: string) =>
        order({
          lines: [{ lineId: 'L1', sku, quantity: 1, title: null, linePrice: p(1200) }],
        });
      seen.push(
        ...(await failures([
          pageTx(w, w.account, [sale('STD-1'), sale('STD-1'), sale('ZERO-1')]),
          pageTx(w, other, [sale('ZERO-1'), sale('ZERO-1'), sale('STD-1')]),
        ])),
      );
      expect(await level(w, w.std)).toEqual({ on_hand: '10', reserved: '3' });
      expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '3' });
    }
    expect(seen).toEqual([]);
  });

  it('[INV-4][CAP-5] a page that moves no stock never makes a stock movement wait', async () => {
    const w = await world();
    const old = {
      placedAt: new Date('2026-10-20T08:00:00Z'),
      updatedAt: new Date('2026-10-20T09:00:00Z'),
    };
    // History from before the account, and a repeat of an order that is stored already.
    const known = order();
    await ingest.apply(w.ctx, w.account, [known]);
    await new Tenancy(db).runWorkspace({ workspaceId: w.ctx.workspaceId }, async (ctx) => {
      await ingest.apply(ctx, w.account, [order(old), order(old), known]);
      const moved = stock
        .stockIn(w.ctx, w.std, { quantity: 1, clientRef: randomUUID(), userId: null })
        .then(() => 'moved');
      const late = new Promise<string>((r) => setTimeout(r, 3000, 'waited'));
      expect(await Promise.race([moved, late])).toBe('moved');
    });
  });

  it('[CAT-6] a listing matched while an order was being stored is reported by the next page, once per set of lines', async () => {
    const w = await world();
    const sku = await lateItem(w);
    const o = lateOrder();
    await ingest.apply(w.ctx, w.account, [o]);
    // The scan matched it and its event ran before the order was committed: nothing was linked.
    const listingId = (await discover(w)).autoMapped[0]?.listingId ?? '';
    late.length = 0;
    await ingest.apply(w.ctx, w.account, [order()]);
    await ingest.apply(w.ctx, w.account, [order()]);
    expect(late.map((l) => [l.listingId, l.masterSkuId])).toEqual([
      [listingId, sku],
      [listingId, sku],
    ]);
    // The same lines give the same key, so the queue runs the event once; new lines give another.
    expect(new Set(late.map((l) => l.key)).size).toBe(1);
    await mapped(w, { listingId, masterSkuId: sku });
    late.length = 0;
    await ingest.apply(w.ctx, w.account, [order()]);
    expect(late).toEqual([]);
    // A nightly check finds them too, with no new order.
    expect(await ingest.reportLateMapped(w.ctx, w.account)).toBe(0);
  });

  it('[VAT-1][FIN-1] a ledger key taken by a different amount is an error, never a silent skip', async () => {
    const w = await world();
    const unpaid = order({ state: 'pending_payment', paidAt: null });
    await ingest.apply(w.ctx, w.account, [unpaid]);
    const id = String((await orderRow(w, unpaid.externalId))?.id);
    await q(
      w,
      sql<object>`INSERT INTO app.vat_ledger
          (workspace_id, id, company_id, order_id, entry_key, kind, group_key, vat_type, rate_bp,
           provisional, gross_pence, vat_pence, net_pence, tax_point_date, period_date, created_at)
        VALUES (${w.ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${w.company}::uuid,
                ${id}::uuid, ${`sale:${id}:rate:2000`}, 'sale', 'rate:2000', 'standard', 2000,
                false, 1, 0, 1, '2026-11-10', '2026-11-10', now())`,
    );
    const paid = {
      ...unpaid,
      state: 'awaiting_dispatch' as const,
      paidAt: new Date('2026-11-10T10:00:00Z'),
      updatedAt: new Date('2026-11-10T10:00:00Z'),
    };
    await expect(ingest.apply(w.ctx, w.account, [paid])).rejects.toThrow(/ledger/);
  });

  it('[FIN-1][VAT-3] an order whose pence differ from the channel total is reported once; a matching one is not', async () => {
    const w = await world();
    const same = order({ channelTotal: p(2100) });
    const differs = order({ channelTotal: p(2000) });
    const unknown = order();
    await ingest.apply(w.ctx, w.account, [same, differs, unknown]);
    await ingest.apply(w.ctx, w.account, [differs]);
    const ids: string[] = [];
    for (const o of [same, differs, unknown]) {
      ids.push(String((await orderRow(w, o.externalId))?.id));
    }
    expect(calls.filter((c) => c.op === 'total' && ids.includes(c.orderId))).toEqual([
      { op: 'total', orderId: ids[1], detail: w.account },
    ]);
  });

  it('[DEL-1] an order first stored already shipped moves its record expiry at once', async () => {
    const w = await world();
    const bare = order({ state: 'dispatched' });
    const delivered = order({ state: 'delivered', deliveredAt: new Date('2026-11-10T09:00:00Z') });
    const noRecord = order({ state: 'dispatched', pii: { kind: 'none' } });
    const waiting = order();
    await ingest.apply(w.ctx, w.account, [bare, delivered, noRecord, waiting]);
    const details = async (o: IncomingOrder) => {
      const id = String((await orderRow(w, o.externalId))?.id);
      return calls.filter((c) => c.op === 'shorten' && c.orderId === id).map((c) => c.detail);
    };
    expect(await details(bare)).toEqual(['dispatch']);
    expect(await details(delivered)).toEqual(['delivery']);
    expect(await details(noRecord)).toEqual([]);
    expect(await details(waiting)).toEqual([]);
    // No ship date from the channel and no ship-by: a late edit is never taken for the dispatch.
    expect((await orderRow(w, bare.externalId))?.dispatched_at).toEqual(bare.placedAt);
    const by = new Date('2026-11-10T08:30:00Z');
    const early = order({ state: 'dispatched', shipBy: by });
    const late = order({ state: 'dispatched', shipBy: new Date('2026-11-15T08:00:00Z') });
    await ingest.apply(w.ctx, w.account, [early, late]);
    expect((await orderRow(w, early.externalId))?.dispatched_at).toEqual(by);
    expect((await orderRow(w, late.externalId))?.dispatched_at).toEqual(late.updatedAt);
    // Seen waiting before: the update that shows it shipped is the dispatch.
    const shown = new Date('2026-11-12T09:00:00Z');
    await ingest.apply(w.ctx, w.account, [{ ...waiting, state: 'dispatched', updatedAt: shown }]);
    expect((await orderRow(w, waiting.externalId))?.dispatched_at).toEqual(shown);
  });

  it('[DEL-1][ORD-6][INV-3] the first real dispatch date replaces a stand-in once, and moves nothing else', async () => {
    const w = await world();
    const o = order();
    await ingest.apply(w.ctx, w.account, [o]);
    const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9));
    const send = (over: Partial<IncomingOrder>) =>
      ingest.apply(w.ctx, w.account, [{ ...o, pii: { kind: 'unchanged' }, ...over }]);
    const state = async () => {
      const row = await orderRow(w, o.externalId);
      return {
        at: row?.dispatched_at,
        estimated: row?.dispatch_estimated,
        shortened: calls
          .filter((c) => c.op === 'shorten' && c.orderId === row?.id)
          .map((c) => c.detail),
      };
    };
    expect(await state()).toEqual({ at: null, estimated: false, shortened: [] });
    await send({ state: 'dispatched', updatedAt: at(14) });
    expect(await state()).toEqual({ at: at(14), estimated: true, shortened: ['dispatch'] });
    const row = await orderRow(w, o.externalId);
    const before = { moves: await movements(w, row?.id), vat: await ledger(w, row?.id) };
    const levels = [await level(w, w.std), await level(w, w.zero)];
    // Another update with no real date changes nothing.
    await send({ state: 'dispatched', updatedAt: at(15) });
    expect(await state()).toEqual({ at: at(14), estimated: true, shortened: ['dispatch'] });
    await send({ state: 'dispatched', updatedAt: at(16), dispatchedAt: at(12) });
    const real = { at: at(12), estimated: false, shortened: ['dispatch', 'dispatch real'] };
    expect(await state()).toEqual(real);
    // A second real date, earlier or later, changes nothing, and neither does a repeat.
    for (const day of [12, 11, 13]) {
      await send({ state: 'dispatched', updatedAt: at(17 + day), dispatchedAt: at(day) });
    }
    expect(await state()).toEqual(real);
    expect(await movements(w, row?.id)).toEqual(before.moves);
    expect(await ledger(w, row?.id)).toEqual(before.vat);
    expect([await level(w, w.std), await level(w, w.zero)]).toEqual(levels);
  });

  it('[DEL-1][ORD-6] a stand-in is marked as one, however it was found; a real date never is', async () => {
    const w = await world();
    const day = new Date('2026-11-12T09:00:00Z');
    const marked = async (o: IncomingOrder) => {
      await ingest.apply(w.ctx, w.account, [o]);
      return (await orderRow(w, o.externalId))?.dispatch_estimated;
    };
    expect(await marked(order())).toBe(false);
    expect(await marked(order({ state: 'dispatched' }))).toBe(true);
    expect(await marked(order({ state: 'dispatched', dispatchedAt: day }))).toBe(false);
    // A delivery time says when it arrived, not when it left.
    expect(await marked(order({ state: 'delivered', deliveredAt: day }))).toBe(true);
    expect(await marked(order({ state: 'delivered', deliveredAt: day, dispatchedAt: day }))).toBe(
      false,
    );
    // Seen waiting, then shipped with a real date at once.
    const o = order();
    await ingest.apply(w.ctx, w.account, [o]);
    expect(await marked({ ...o, state: 'dispatched', dispatchedAt: day, updatedAt: day })).toBe(
      false,
    );
  });

  it('[DEL-1] a real dispatch date moves no expiry of a record that is gone, or once delivery is known', async () => {
    const w = await world();
    const day = new Date('2026-11-12T09:00:00Z');
    const later = new Date('2026-11-13T09:00:00Z');
    const shown = { state: 'dispatched' as const, updatedAt: day };
    const gone = order({ state: 'dispatched', pii: { kind: 'refused' } });
    const none = order({ state: 'dispatched', pii: { kind: 'none' } });
    const delivered = order({ state: 'delivered', deliveredAt: day });
    await ingest.apply(w.ctx, w.account, [gone, none, delivered]);
    calls.length = 0;
    await ingest.apply(
      w.ctx,
      w.account,
      [gone, none, delivered].map((o) => ({
        ...o,
        ...shown,
        pii: { kind: 'unchanged' as const },
        updatedAt: later,
        dispatchedAt: day,
      })),
    );
    expect(calls.filter((c) => c.op === 'shorten')).toEqual([]);
    expect((await orderRow(w, gone.externalId))?.dispatched_at).toEqual(day);
  });

  it('[DEL-1] a record that arrives after the order shipped has its expiry moved too', async () => {
    const w = await world();
    const o = order({ state: 'dispatched', pii: { kind: 'none' } });
    await ingest.apply(w.ctx, w.account, [o]);
    const id = String((await orderRow(w, o.externalId))?.id);
    const later = { ...o, updatedAt: new Date('2026-11-12T09:00:00Z') };
    await ingest.apply(w.ctx, w.account, [
      { ...later, pii: { kind: 'stored', piiRef: randomUUID() } },
    ]);
    await ingest.apply(w.ctx, w.account, [{ ...later, pii: { kind: 'unchanged' } }]);
    expect(calls.filter((c) => c.orderId === id).map((c) => c.detail)).toEqual(['dispatch']);
  });

  it('[FIN-1] the amounts an order was stored with never change', async () => {
    const w = await world();
    const o = order();
    await ingest.apply(w.ctx, w.account, [o]);
    for (const column of ['goods_pence', 'discount_pence', 'shipping_pence', 'gross_pence']) {
      await expect(
        q(
          w,
          sql<object>`UPDATE app.orders SET ${sql.ref(column)} = 1
                       WHERE external_order_id = ${o.externalId}`,
        ),
        column,
      ).rejects.toThrow(/never change/);
    }
  });

  // ---- F-M10-end-05 (ADR-081 1 to 3): amounts follow the channel until payment, never after ------

  const pending = (over: Partial<IncomingOrder> = {}): IncomingOrder =>
    order({
      state: 'pending_payment',
      rawStatus: 'NOT_STARTED/PENDING',
      paidAt: null,
      pii: { kind: 'none' },
      lines: [{ lineId: 'L1', sku: 'STD-1', quantity: 1, title: 'Standard', linePrice: p(1200) }],
      shipping: p(600),
      ...over,
    });
  /** The same order, `n` hours later. */
  const next = (o: IncomingOrder, n: number, over: Partial<IncomingOrder> = {}): IncomingOrder => ({
    ...o,
    updatedAt: new Date(o.updatedAt.getTime() + n * 3_600_000),
    ...over,
  });
  const paid = {
    state: 'awaiting_dispatch' as const,
    rawStatus: 'NOT_STARTED/PAID',
    paidAt: new Date('2026-11-10T11:00:00.000Z'),
  };
  const lineRows = (w: World, orderId: unknown, live = true) =>
    q<{
      id: string;
      line_no: string;
      external_line_id: string;
      external_sku: string;
      quantity: string;
      unit_gross_pence: string;
      line_gross_pence: string;
      discount_pence: string;
      shipping_pence: string;
      vat_pence: string;
      vat_type: string | null;
      cogs_pence: string | null;
    }>(
      w,
      sql`SELECT id, line_no, external_line_id, external_sku, quantity, unit_gross_pence,
                 line_gross_pence, discount_pence, shipping_pence, vat_pence, vat_type, cogs_pence
            FROM app.order_lines
           WHERE order_id = ${String(orderId)}::uuid AND (removed_at IS NULL) = ${live}
           ORDER BY line_no`,
    );
  const notices = (orderId: unknown) =>
    calls.filter((c) => c.op === 'total' && c.orderId === orderId).length;
  const line = (
    lineId: string,
    sku: string,
    quantity: number,
    price: bigint,
  ): IncomingOrder['lines'][number] => ({
    lineId,
    sku,
    quantity,
    title: null,
    linePrice: pence(price),
  });

  it('[VAT-3][VAT-6] the update that captures payment sets discount, shipping and gross, then books the VAT', async () => {
    const w = await world();
    const o = pending();
    await ingest.apply(w.ctx, w.account, [o]);
    expect(await orderRow(w, o.externalId)).toMatchObject({
      gross_pence: '1800',
      vat_pence: '300',
    });
    const first = await lineRows(w, (await orderRow(w, o.externalId))?.id);
    await ingest.apply(w.ctx, w.account, [
      next(o, 1, { ...paid, shipping: p(300), discount: p(120) }),
    ]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({
      goods_pence: '1200',
      discount_pence: '120',
      shipping_pence: '300',
      gross_pence: '1380',
      vat_pence: '230',
      amounts_differ: [],
    });
    expect(await lineRows(w, row?.id)).toEqual([
      { ...first[0], discount_pence: '120', shipping_pence: '300', vat_pence: '230' },
    ]);
    expect(await totals(w, row?.id)).toEqual([
      { group_key: 'rate:2000', gross: '1380', vat: '230' },
    ]);
  });

  it('[VAT-3][FIN-1] before payment a new price replaces the line price in place; an older or repeated update changes nothing', async () => {
    const w = await world();
    const o = pending({ lines: [line('L1', 'STD-1', 2, 2400n), line('L2', 'ZERO-1', 1, 600n)] });
    await ingest.apply(w.ctx, w.account, [o]);
    const id = (await orderRow(w, o.externalId))?.id;
    const before = await lineRows(w, id);
    const cheaper = next(o, 2, {
      lines: [line('L1', 'STD-1', 2, 1800n), line('L2', 'ZERO-1', 1, 600n)],
    });
    await ingest.apply(w.ctx, w.account, [cheaper]);
    const after = await lineRows(w, id);
    expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(after.map((l) => [l.unit_gross_pence, l.line_gross_pence])).toEqual([
      ['900', '1800'],
      ['600', '600'],
    ]);
    const stored = await orderRow(w, o.externalId);
    // 1800 + 450 of the shipping at 20%; 600 + 150 at 0%.
    expect(stored).toMatchObject({ goods_pence: '2400', gross_pence: '3000', vat_pence: '375' });
    expect(after.map((l) => [l.shipping_pence, l.vat_pence])).toEqual([
      ['450', '375'],
      ['150', '0'],
    ]);
    // Older, and the same time with other amounts.
    await ingest.apply(w.ctx, w.account, [next(o, 1, { shipping: p(0) })]);
    await ingest.apply(w.ctx, w.account, [{ ...cheaper, shipping: p(0) }]);
    expect(await orderRow(w, o.externalId)).toMatchObject({ gross_pence: '3000' });
    expect(await lineRows(w, id)).toEqual(after);
    expect(notices(id)).toBe(0);
    expect(await ledger(w, id)).toEqual([]);
  });

  it('[INV-3][VAT-3][FIN-1] before payment a changed, dropped or added line closes the old one and takes its own stock', async () => {
    const w = await world();
    const o = pending({ lines: [line('L1', 'STD-1', 1, 1200n), line('L2', 'ZERO-1', 2, 1200n)] });
    await ingest.apply(w.ctx, w.account, [o]);
    const id = (await orderRow(w, o.externalId))?.id;
    const [first, second] = await lineRows(w, id);
    expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '2' });
    await ingest.apply(w.ctx, w.account, [
      next(o, 1, { lines: [line('L1', 'STD-1', 1, 1200n), line('L2', 'ZERO-1', 5, 3000n)] }),
    ]);
    let live = await lineRows(w, id);
    expect(live.map((l) => [l.external_line_id, l.quantity, l.line_no, l.vat_type])).toEqual([
      ['L1', '1', '1', 'standard'],
      ['L2', '5', '3', 'zero'],
    ]);
    expect(live[0]?.id).toBe(first?.id);
    expect((await lineRows(w, id, false)).map((l) => [l.id, l.quantity])).toEqual([
      [second?.id, '2'],
    ]);
    expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '5' });
    // Another SKU under the same line ID, the second line dropped, a third added.
    await ingest.apply(w.ctx, w.account, [
      next(o, 2, { lines: [line('L1', 'ZERO-1', 1, 600n), line('L3', 'STD-1', 3, 3600n)] }),
    ]);
    live = await lineRows(w, id);
    expect(live.map((l) => [l.external_line_id, l.external_sku, l.quantity])).toEqual([
      ['L1', 'ZERO-1', '1'],
      ['L3', 'STD-1', '3'],
    ]);
    expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '1' });
    expect(await level(w, w.std)).toEqual({ on_hand: '10', reserved: '3' });
    expect(await orderRow(w, o.externalId)).toMatchObject({
      goods_pence: '4200',
      gross_pence: '4800',
    });
    // A dropped line that comes back is a new line; then everything ships once.
    await ingest.apply(w.ctx, w.account, [
      next(o, 3, {
        ...paid,
        lines: [line('L1', 'ZERO-1', 1, 600n), line('L2', 'ZERO-1', 2, 1200n)],
      }),
    ]);
    expect((await lineRows(w, id)).map((l) => l.external_line_id)).toEqual(['L1', 'L2']);
    expect(await level(w, w.std)).toEqual({ on_hand: '10', reserved: '0' });
    expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '3' });
    expect(await totals(w, id)).toEqual([{ group_key: 'zero:zero', gross: '2400', vat: '0' }]);
    await ingest.apply(w.ctx, w.account, [
      next(o, 4, { ...paid, state: 'dispatched', lines: [], dispatchedAt: clock }),
    ]);
    expect(await level(w, w.zero)).toEqual({ on_hand: '7', reserved: '0' });
    expect(await level(w, w.std)).toEqual({ on_hand: '10', reserved: '0' });
  });

  it('[VAT-7][AT-6] a line added before payment takes the snapshot of the placed date', async () => {
    const w = await world();
    const o = pending();
    await ingest.apply(w.ctx, w.account, [o]);
    await catalogue.setCogs(w.ctx, w.zero, p(999), '2026-11-11', null, clock);
    await ingest.apply(w.ctx, w.account, [
      next(o, 30, {
        lines: [line('L1', 'STD-1', 1, 1200n), line('L2', 'ZERO-1', 1, 600n)],
      }),
    ]);
    const rows = await lineRows(w, (await orderRow(w, o.externalId))?.id);
    expect(rows.map((l) => l.cogs_pence)).toEqual(['400', '200']);
  });

  it('[ORD-1][ORD-2][ORD-6] a closed line is in no total, list, search or detail', async () => {
    const w = await world();
    const o = pending({ lines: [line('L1', 'STD-1', 1, 1200n), line('L2', 'ZERO-1', 2, 1200n)] });
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [next(o, 1, { lines: [line('L1', 'STD-1', 1, 1200n)] })]);
    const reads = new OrderReads(db, { now: () => clock });
    const page = (f: OrderFilter) => reads.list(w.ctx, f, { offset: 0, limit: 10 }, 100);
    const { items } = await page({});
    expect(items.map((r) => [r.skus, r.itemCount, r.grossPence])).toEqual([[['STD-1'], 1, 1800n]]);
    expect((await page({ q: 'ZERO-1' })).items).toEqual([]);
    expect((await page({ q: 'STD-1' })).items).toHaveLength(1);
    const detail = await reads.detail(w.ctx, items[0]?.id ?? '');
    expect(detail?.lines.map((l) => l.sku)).toEqual(['STD-1']);
    expect(detail?.money).toMatchObject({ goodsPence: 1200n, grossPence: 1800n, vatPence: 300n });
    expect(detail?.money.vatGroups.map((g) => g.key)).toEqual(['rate:2000']);
  });

  it('[CAT-6][VAT-2] a closed line is never linked, reported, back-filled or filled', async () => {
    const w = await world();
    const o = pending({
      lines: [line('L1', 'NEW-ITEM', 1, 1200n), line('L2', 'LATER-ITEM', 1, 600n)],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    const id = (await orderRow(w, o.externalId))?.id;
    expect((await orderRow(w, o.externalId))?.unmapped).toBe(true);
    await ingest.apply(w.ctx, w.account, [next(o, 1, { lines: [line('L3', 'STD-1', 1, 1200n)] })]);
    expect((await orderRow(w, o.externalId))?.unmapped).toBe(false);
    const closed = await lineRows(w, id, false);
    await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
    late.length = 0;
    expect(await ingest.reportLateMapped(w.ctx, w.account)).toBe(0);
    expect(await mapped(w, { listingId: w.listings.unmapped, masterSkuId: w.zero })).toEqual({
      filled: 0,
    });
    expect(await lineRows(w, id, false)).toEqual(closed);
    expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '0' });
    expect(await ingest.openLines(w.ctx, w.listings.unmapped)).toEqual([]);
  });

  it('[INV-6][ORD-1] the Oversold flag goes when its line is closed, and comes with the new one', async () => {
    const w = await world();
    const o = pending({ lines: [line('L1', 'STD-1', 50, 60000n)] });
    await ingest.apply(w.ctx, w.account, [o]);
    expect((await orderRow(w, o.externalId))?.oversold).toBe(true);
    await ingest.apply(w.ctx, w.account, [next(o, 1, { lines: [line('L1', 'STD-1', 5, 6000n)] })]);
    expect((await orderRow(w, o.externalId))?.oversold).toBe(false);
    await ingest.apply(w.ctx, w.account, [
      next(o, 2, { lines: [line('L1', 'STD-1', 40, 48000n)] }),
    ]);
    expect((await orderRow(w, o.externalId))?.oversold).toBe(true);
    expect(await level(w, w.std)).toEqual({ on_hand: '10', reserved: '40' });
  });

  it('[FIN-1][VAT-6][ORD-6] after payment a different total or line set changes nothing: one mark and one notice', async () => {
    const w = await world();
    const o = pending({ ...paid });
    await ingest.apply(w.ctx, w.account, [o]);
    const frozen = async () => {
      const row = await orderRow(w, o.externalId);
      const moving = ['amounts_differ', 'source_updated_at', 'updated_at'];
      const rest = Object.fromEntries(
        Object.entries(row ?? {}).filter(([k]) => !moving.includes(k)),
      );
      const differ = row?.amounts_differ;
      return {
        differ,
        rest,
        lines: await lineRows(w, row?.id),
        closed: await lineRows(w, row?.id, false),
        vat: await ledger(w, row?.id),
        stock: await level(w, w.std),
      };
    };
    const id = (await orderRow(w, o.externalId))?.id;
    const was = await frozen();
    expect(was.differ).toEqual([]);
    const changes: Partial<IncomingOrder>[] = [
      { shipping: p(500) },
      { discount: p(10) },
      { lines: [line('L1', 'STD-1', 1, 1100n)] },
      { lines: [line('L1', 'STD-1', 2, 1200n)] },
      { lines: [line('L1', 'ZERO-1', 1, 1200n)] },
      { lines: [line('L9', 'STD-1', 1, 1200n)] },
      { lines: [line('L1', 'STD-1', 1, 1200n), line('L2', 'ZERO-1', 1, 0n)] },
      { lines: [] },
    ];
    for (const [i, change] of changes.entries()) {
      await ingest.apply(w.ctx, w.account, [next(o, 2 * i + 1, change)]);
      expect(await frozen(), JSON.stringify(Object.keys(change))).toEqual({
        ...was,
        differ: ['late_change'],
      });
      expect(notices(id)).toBe(i + 1);
      // A repeat of the difference is not a second notice; the stored amounts again clear the mark.
      await ingest.apply(w.ctx, w.account, [next(o, 2 * i + 1.5, change)]);
      expect(notices(id)).toBe(i + 1);
      await ingest.apply(w.ctx, w.account, [next(o, 2 * i + 2)]);
      expect((await frozen()).differ).toEqual([]);
    }
    // An older update says nothing about the order now.
    await ingest.apply(w.ctx, w.account, [next(o, 0.5, { shipping: p(1) })]);
    expect((await frozen()).differ).toEqual([]);
  });

  it('[FIN-1][VAT-6] an order cancelled unpaid is frozen too', async () => {
    const w = await world();
    const o = pending();
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [next(o, 1, { state: 'cancelled', cancelledAt: clock })]);
    const id = (await orderRow(w, o.externalId))?.id;
    await ingest.apply(w.ctx, w.account, [
      next(o, 2, { state: 'cancelled', lines: [line('L1', 'STD-1', 3, 3600n)] }),
    ]);
    expect(await orderRow(w, o.externalId)).toMatchObject({
      gross_pence: '1800',
      amounts_differ: ['late_change'],
      status: 'cancelled',
    });
    expect((await lineRows(w, id)).map((l) => l.quantity)).toEqual(['1']);
    expect(notices(id)).toBe(1);
    expect(await level(w, w.std)).toEqual({ on_hand: '10', reserved: '0' });
    expect(await ledger(w, id)).toEqual([]);
  });

  it('[INV-3] an update that cancels an unpaid order with other lines leaves no stock reserved', async () => {
    const w = await world();
    const o = pending();
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [
      next(o, 1, {
        state: 'cancelled',
        cancelledAt: clock,
        lines: [line('L1', 'STD-1', 4, 4800n), line('L2', 'ZERO-1', 1, 600n)],
      }),
    ]);
    expect(await level(w, w.std)).toEqual({ on_hand: '10', reserved: '0' });
    expect(await level(w, w.zero)).toEqual({ on_hand: '10', reserved: '0' });
  });

  it('[INV-3][FIN-1] an unpaid order that has shipped keeps its lines: other lines are only marked', async () => {
    const w = await world();
    const o = pending();
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [
      next(o, 1, { state: 'dispatched', dispatchedAt: clock, shipping: p(100) }),
    ]);
    expect(await orderRow(w, o.externalId)).toMatchObject({ gross_pence: '1300' });
    const id = (await orderRow(w, o.externalId))?.id;
    await ingest.apply(w.ctx, w.account, [
      next(o, 2, { state: 'dispatched', lines: [line('L1', 'STD-1', 4, 4800n)] }),
    ]);
    expect(await orderRow(w, o.externalId)).toMatchObject({
      gross_pence: '1300',
      amounts_differ: ['late_change'],
    });
    expect((await lineRows(w, id)).map((l) => l.quantity)).toEqual(['1']);
    expect(await level(w, w.std)).toEqual({ on_hand: '9', reserved: '0' });
    // A new price is still taken, and the mark goes with it.
    await ingest.apply(w.ctx, w.account, [
      next(o, 3, { state: 'dispatched', lines: [line('L1', 'STD-1', 1, 900n)], shipping: p(100) }),
    ]);
    expect(await orderRow(w, o.externalId)).toMatchObject({
      gross_pence: '1000',
      amounts_differ: [],
    });
  });

  it('[FIN-1][ORD-6] pence that differ from the channel total are marked until a newer update adds up', async () => {
    const w = await world();
    const o = pending({ channelTotal: p(1700) });
    await ingest.apply(w.ctx, w.account, [o]);
    const id = (await orderRow(w, o.externalId))?.id;
    const differ = async () => (await orderRow(w, o.externalId))?.amounts_differ;
    expect(await differ()).toEqual(['channel_total']);
    expect(notices(id)).toBe(1);
    await ingest.apply(w.ctx, w.account, [next(o, 1, { channelTotal: p(1750) })]);
    expect(await differ()).toEqual(['channel_total']);
    expect(notices(id)).toBe(1);
    await ingest.apply(w.ctx, w.account, [next(o, 2, { channelTotal: p(1800) })]);
    expect(await differ()).toEqual([]);
    await ingest.apply(w.ctx, w.account, [next(o, 3, { ...paid, channelTotal: p(1790) })]);
    expect(await differ()).toEqual(['channel_total']);
    expect(notices(id)).toBe(2);
    // Fixed now: a channel total that differs from the stored gross is a late change.
    const fixed = order({ channelTotal: p(2100) });
    await ingest.apply(w.ctx, w.account, [fixed]);
    expect((await orderRow(w, fixed.externalId))?.amounts_differ).toEqual([]);
    await ingest.apply(w.ctx, w.account, [next(fixed, 1, { channelTotal: p(2000) })]);
    expect((await orderRow(w, fixed.externalId))?.amounts_differ).toEqual(['late_change']);
    const reads = new OrderReads(db, { now: () => clock });
    expect((await reads.detail(w.ctx, String(id)))?.money.amountsDiffer).toEqual(['channel_total']);
  });

  it('[VAT-5][FIN-1] a refund above what is left keeps its amount, books VAT up to what is left, and marks the order', async () => {
    const w = await world();
    const o = order({
      lines: [line('L1', 'STD-1', 1, 1200n)],
      shipping: p(0),
      state: 'dispatched',
      dispatchedAt: new Date('2026-11-10T10:00:00Z'),
    });
    const refund = (refundId: string, amount: bigint) => ({
      refundId,
      refundedAt: new Date('2026-11-12T09:00:00Z'),
      amount: pence(amount),
      lines: null,
    });
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [next(o, 1, { refunds: [refund('R1', 1200n)] })]);
    expect((await orderRow(w, o.externalId))?.amounts_differ).toEqual([]);
    await ingest.apply(w.ctx, w.account, [
      next(o, 2, { refunds: [refund('R1', 1200n), refund('R2', 300n)] }),
    ]);
    const row = await orderRow(w, o.externalId);
    expect(row?.amounts_differ).toEqual(['refund_above']);
    expect(await totals(w, row?.id)).toEqual([{ group_key: 'rate:2000', gross: '0', vat: '0' }]);
    expect(
      await q(
        w,
        sql<object>`SELECT amount_pence, vat_pence FROM app.refunds
                     WHERE order_id = ${String(row?.id)}::uuid ORDER BY amount_pence`,
      ),
    ).toEqual([
      { amount_pence: '300', vat_pence: '0' },
      { amount_pence: '1200', vat_pence: '200' },
    ]);
    // The mark stays with the refund, whatever later updates say.
    await ingest.apply(w.ctx, w.account, [next(o, 3, { refunds: [] })]);
    expect((await orderRow(w, o.externalId))?.amounts_differ).toEqual(['refund_above']);
    expect(notices(row?.id)).toBe(0);
  });

  it('[FIN-1][VAT-6] the database fixes amounts and lines at payment or an unpaid cancellation, and not before', async () => {
    const w = await world();
    const o = pending({ lines: [line('L1', 'STD-1', 1, 1200n), line('L2', 'ZERO-1', 1, 600n)] });
    await ingest.apply(w.ctx, w.account, [o]);
    const id = String((await orderRow(w, o.externalId))?.id);
    const run = (query: ReturnType<typeof sql<object>>) => q(w, query);
    const one = sql`WHERE order_id = ${id}::uuid AND external_line_id = 'L1'`;
    // Open: amounts, prices and closing are free; identity, SKU and quantity never are.
    await run(sql`UPDATE app.orders SET gross_pence = gross_pence + 1 WHERE id = ${id}::uuid`);
    await run(
      sql`UPDATE app.order_lines SET line_gross_pence = 1201, unit_gross_pence = 1201 ${one}`,
    );
    const never = [
      sql<object>`UPDATE app.order_lines SET quantity = 2 ${one}`,
      sql<object>`UPDATE app.order_lines SET external_sku = 'OTHER' ${one}`,
      sql<object>`UPDATE app.order_lines SET external_line_id = 'L7' ${one}`,
      sql<object>`UPDATE app.order_lines SET line_no = 7 ${one}`,
    ];
    for (const query of never) await expect(run(query)).rejects.toThrow(/write-once/);
    await run(sql`UPDATE app.order_lines SET removed_at = now()
                   WHERE order_id = ${id}::uuid AND external_line_id = 'L2'`);
    const closed = [
      sql<object>`UPDATE app.order_lines SET removed_at = NULL WHERE external_line_id = 'L2'`,
      sql<object>`UPDATE app.order_lines SET removed_at = now() + interval '1 day' WHERE external_line_id = 'L2'`,
      sql<object>`UPDATE app.order_lines SET line_gross_pence = 1 WHERE external_line_id = 'L2'`,
      sql<object>`UPDATE app.order_lines SET vat_pence = 1 WHERE external_line_id = 'L2'`,
    ];
    for (const query of closed) await expect(run(query)).rejects.toThrow(/write-once/);
    const insert = sql<object>`
      INSERT INTO app.order_lines (workspace_id, id, company_id, order_id, line_no, external_line_id,
        quantity, unit_gross_pence, line_gross_pence, provisional_rate_bp, stored_unmapped, created_at)
      SELECT workspace_id, gen_random_uuid(), company_id, id, 9, 'L9', 1, 1, 1, 2000, true, now()
        FROM app.orders WHERE id = ${id}::uuid`;
    const frozen = async () => {
      for (const column of ['goods_pence', 'discount_pence', 'shipping_pence', 'gross_pence']) {
        await expect(
          run(sql<object>`UPDATE app.orders SET ${sql.ref(column)} = 1 WHERE id = ${id}::uuid`),
          column,
        ).rejects.toThrow(/never change/);
      }
      for (const change of ['line_gross_pence = 1', 'unit_gross_pence = 1', 'removed_at = now()']) {
        await expect(
          run(sql<object>`UPDATE app.order_lines SET ${sql.raw(change)} ${one}`),
          change,
        ).rejects.toThrow(/write-once/);
      }
      await expect(run(insert), 'insert').rejects.toThrow(/write-once/);
    };
    // Payment recorded: fixed for good, and it can never be unrecorded.
    await run(sql`UPDATE app.orders SET vat_recorded_at = now() WHERE id = ${id}::uuid`);
    await frozen();
    await expect(
      run(sql<object>`UPDATE app.orders SET vat_recorded_at = NULL WHERE id = ${id}::uuid`),
    ).rejects.toThrow(/never change/);
    const c = pending();
    await ingest.apply(w.ctx, w.account, [c, next(c, 1, { state: 'cancelled' })]);
    const cancelled = String((await orderRow(w, c.externalId))?.id);
    await expect(
      run(sql<object>`UPDATE app.orders SET gross_pence = 1 WHERE id = ${cancelled}::uuid`),
    ).rejects.toThrow(/never change/);
    await expect(
      run(
        sql<object>`UPDATE app.order_lines SET line_gross_pence = 1 WHERE order_id = ${cancelled}::uuid`,
      ),
    ).rejects.toThrow(/write-once/);
  });

  it('[ORD-9] a group recompute is asked for only when an order enters or leaves the ones that can group', async () => {
    const w = await world();
    const asked = async (...orders: IncomingOrder[]) => {
      regroups.length = 0;
      await ingest.apply(w.ctx, w.account, orders);
      return regroups.length;
    };
    const ref = { kind: 'stored' as const, piiRef: randomUUID() };
    const o = order();
    // One per call, however many new orders it stores.
    expect(await asked(o, order())).toBe(1);
    expect(await asked(next(o, 1, { pii: { kind: 'unchanged' } }))).toBe(0);
    expect(await asked(next(o, 2, { pii: { kind: 'unchanged' }, rawStatus: 'OTHER' }))).toBe(0);
    // The buyer's record was corrected.
    expect(await asked(next(o, 3, { pii: { kind: 'replaced' } }))).toBe(1);
    const gone = { state: 'dispatched' as const, dispatchedAt: clock };
    expect(await asked(next(o, 4, { ...gone, pii: { kind: 'unchanged' } }))).toBe(1);
    expect(await asked(next(o, 5, { ...gone, pii: { kind: 'replaced' } }))).toBe(0);
    // First seen shipped, unpaid or without a buyer record: in no group, now or before.
    expect(await asked(order(gone), pending(), order({ pii: { kind: 'none' } }))).toBe(0);
    // Paid, then its record comes, then cancelled.
    const late = pending();
    await ingest.apply(w.ctx, w.account, [late]);
    expect(await asked(next(late, 1, paid))).toBe(0);
    expect(await asked(next(late, 2, { ...paid, pii: ref }))).toBe(1);
    expect(await asked(next(late, 3, { ...paid, state: 'cancelled' }))).toBe(1);
    // An FBA order is never grouped.
    expect(await asked(order({ fba: true }))).toBe(0);
  });

  it('[ORD-3][INV-3] a channel that reports delivery without a dispatch time still dispatches the stock', async () => {
    const w = await world();
    const o = order({ placedAt: new Date('2026-11-10T08:00:00Z') });
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [
      {
        ...o,
        state: 'delivered',
        deliveredAt: new Date('2026-11-12T09:00:00Z'),
        updatedAt: new Date('2026-11-12T09:00:00Z'),
      },
    ]);
    const row = await orderRow(w, o.externalId);
    expect(row).toMatchObject({ status: 'delivered' });
    expect(row?.dispatched_at).toEqual(new Date('2026-11-12T09:00:00Z'));
    expect((await movements(w, row?.id)).map((m) => m.kind).sort()).toEqual([
      'dispatch',
      'dispatch',
      'reserve',
      'reserve',
    ]);
  });

  it('[VAT-5][CAT-6] a refund recorded while a line was provisional is re-based when the listing is mapped (FA-11)', async () => {
    const w = await world();
    const o = order({
      lines: [{ lineId: 'L1', sku: 'NEW-ITEM', quantity: 1, title: null, linePrice: p(1200) }],
      shipping: p(0),
    });
    await ingest.apply(w.ctx, w.account, [o]);
    await ingest.apply(w.ctx, w.account, [
      {
        ...o,
        state: 'dispatched',
        dispatchedAt: new Date('2026-11-11T09:00:00Z'),
        updatedAt: new Date('2026-11-12T09:00:00Z'),
        refunds: [
          {
            refundId: 'R1',
            refundedAt: new Date('2026-11-12T09:00:00Z'),
            amount: p(600),
            lines: null,
          },
        ],
      },
    ]);
    const row = await orderRow(w, o.externalId);
    await catalogue.mapListing(w.ctx, w.listings.unmapped, w.zero, 'manual', null, clock);
    await ingest.fillSnapshots(w.ctx, w.listings.unmapped);
    const totals = await q<{ group_key: string; gross: string; vat: string }>(
      w,
      sql`SELECT group_key, sum(gross_pence) AS gross, sum(vat_pence) AS vat FROM app.vat_ledger
           WHERE order_id = ${String(row?.id)}::uuid GROUP BY group_key ORDER BY group_key`,
    );
    // The provisional 20% group nets to nothing; the zero group holds the sale less the refund.
    expect(totals).toEqual([
      { group_key: 'rate:2000', gross: '0', vat: '0' },
      { group_key: 'zero:zero', gross: '600', vat: '0' },
    ]);
  });

  it('[ORD-4] an order placed before its account was connected moves no stock (FA-16 cutover)', async () => {
    const w = await world();
    const old = order({
      placedAt: new Date('2026-10-20T08:00:00Z'),
      updatedAt: new Date('2026-10-20T09:00:00Z'),
    });
    await ingest.apply(w.ctx, w.account, [old]);
    const row = await orderRow(w, old.externalId);
    expect(row).toMatchObject({ stock_moves: false, status: 'awaiting_dispatch' });
    expect(await movements(w, row?.id)).toEqual([]);
    await ingest.apply(w.ctx, w.account, [
      {
        ...old,
        state: 'dispatched',
        dispatchedAt: new Date('2026-11-02T09:00:00Z'),
        updatedAt: new Date('2026-11-02T09:00:00Z'),
      },
    ]);
    expect(await movements(w, row?.id)).toEqual([]);
  });

  it('[INV-5][TEN-5] the stock change log names the order, and only to users who can see its company', async () => {
    const w = await world();
    const o = order();
    await ingest.apply(w.ctx, w.account, [o]);
    const log = await stock.listMovements(
      w.ctx,
      { skuId: w.std, kind: 'reserve', offset: 0, limit: 5 },
      5,
    );
    expect(log.items.map((m) => m.orderRef)).toEqual([o.externalId]);
    const other: TenantContext = { workspaceId: w.ctx.workspaceId, companyIds: [randomUUID()] };
    const hidden = await stock.listMovements(
      other,
      { skuId: w.std, kind: 'reserve', offset: 0, limit: 5 },
      5,
    );
    expect(hidden.items.map((m) => [m.orderRef, m.companyVisible])).toEqual([[null, false]]);
  });

  it('[TEN-5][TEN-1] orders, lines, refunds and VAT rows are company-scoped: another company sees none', async () => {
    const w = await world();
    await ingest.apply(w.ctx, w.account, [order()]);
    const other: TenantContext = { workspaceId: w.ctx.workspaceId, companyIds: [randomUUID()] };
    const seen = await withTenantTransaction(db, other, (trx) =>
      sql<{
        n: string;
      }>`SELECT (SELECT count(*) FROM app.orders) + (SELECT count(*) FROM app.order_lines)
                                + (SELECT count(*) FROM app.vat_ledger) + (SELECT count(*) FROM app.order_status_events) AS n`.execute(
        trx,
      ),
    );
    expect(seen.rows[0]?.n).toBe('0');
    clock = new Date(clock.getTime());
  });
});
