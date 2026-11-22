import { randomUUID } from 'node:crypto';
import { pence, type TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogueRepository } from './catalogue.ts';
import { migrateMain } from './migrate.ts';
import { OrderIngest, type IncomingOrder, type OrderIngestPorts } from './orders.ts';
import { OutboundWriteRepository } from './outbound.ts';
import type { MainDb } from './schema.ts';
import { StockEngine } from './stock.ts';
import { withTenantTransaction } from './tenant.ts';

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
  const calls: { op: 'cancel' | 'shorten'; orderId: string; detail: string }[] = [];
  const ports: OrderIngestPorts = {
    cancelPii: (_ctx, input) => {
      calls.push({ op: 'cancel', orderId: input.orderId, detail: input.piiSubject });
      return Promise.resolve();
    },
    shortenPii: (_ctx, input) => {
      calls.push({ op: 'shorten', orderId: input.orderId, detail: input.reason });
      return Promise.resolve();
    },
  };
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
        raise: () => Promise.resolve({ id: randomUUID(), created: true, reopened: false } as never),
        resolve: () => Promise.resolve(true),
      },
      demand: { openLines: (ctx, listingId) => ingest.openLines(ctx, listingId) },
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

  it('[VAT-5][FA-11] a refund recorded while a line was provisional is re-based when the listing is mapped', async () => {
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
