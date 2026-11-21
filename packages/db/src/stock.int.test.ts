import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogueRepository } from './catalogue.ts';
import { migrateMain } from './migrate.ts';
import { OutboundWriteRepository } from './outbound.ts';
import type { MainDb } from './schema.ts';
import { StockEngine, StockRefused, type UnmappedDemand } from './stock.ts';
import { withTenantTransaction } from './tenant.ts';

const ROLES = ['ob_owner', 'ob_app'] as const;
const NOW = new Date('2026-11-22T10:00:00.000Z');

interface Notice {
  op: 'raise' | 'resolve';
  type: string;
  id: string;
}

/**
 * The T-0901 stock engine on real PostgreSQL (ADR-078 5): movements append-only under a unique
 * key, on hand only through movements under the stock row's lock, writes queued through the
 * outbound table only when a target changes, and every C7.3 edge case of manual allocation.
 */
describe('stock engine (T-0901)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let owner: pg.Pool;
  let catalogue: CatalogueRepository;
  let writes: OutboundWriteRepository;
  const notices: Notice[] = [];
  let clock = NOW;
  const demand: { lines: Map<string, Awaited<ReturnType<UnmappedDemand['openLines']>>> } = {
    lines: new Map(),
  };

  const engine = () =>
    new StockEngine(db, {
      pushes: { enqueue: (ctx, input) => writes.insert(ctx, input, clock) },
      notifier: {
        raise: (_ctx, input) => {
          notices.push({ op: 'raise', type: input.type, id: input.record.id });
          return Promise.resolve({ id: randomUUID(), created: true, reopened: false } as never);
        },
        resolve: (_ctx, type, record) => {
          notices.push({ op: 'resolve', type, id: record.id });
          return Promise.resolve(true);
        },
      },
      demand: {
        openLines: (_ctx, listingId) => Promise.resolve(demand.lines.get(listingId) ?? []),
      },
      now: () => clock,
    });

  interface World {
    ctx: TenantContext;
    company: string;
    accounts: Record<'ebay1' | 'ebay2' | 'website' | 'amazon', string>;
    sku: string;
    listings: Record<'ebay1' | 'ebay2' | 'website' | 'fba', string>;
  }

  /** A workspace with one SKU listed on two eBay accounts, the website and Amazon FBA. */
  const world = async (onHand = 186, code = 'BB-BAM-M100'): Promise<World> => {
    const ctx: TenantContext = { workspaceId: randomUUID(), companyIds: [randomUUID()] };
    const company = ctx.companyIds[0] ?? '';
    const accounts = { ebay1: '', ebay2: '', website: '', amazon: '' };
    await withTenantTransaction(db, ctx, async (trx) => {
      await trx
        .insertInto('app.workspaces')
        .values({ id: ctx.workspaceId, name: 'Stock' })
        .execute();
      await trx
        .insertInto('app.companies')
        .values({
          id: company,
          workspace_id: ctx.workspaceId,
          legal_name: 'Stock Ltd',
          trading_name: 'Stock',
          address_line1: '1 Test Street',
          address_city: 'Testville',
          address_postcode: 'TE1 1ST',
        })
        .execute();
      for (const [key, provider] of [
        ['ebay1', 'ebay'],
        ['ebay2', 'ebay'],
        ['website', 'website'],
        ['amazon', 'amazon'],
      ] as const) {
        accounts[key] = randomUUID();
        await trx
          .insertInto('app.channel_accounts')
          .values({
            id: accounts[key],
            workspace_id: ctx.workspaceId,
            company_id: company,
            provider,
            display_name: key,
          })
          .execute();
      }
    });
    const sku = await catalogue.createSku(
      ctx,
      { sku: code, title: code, shortDescription: code, weightG: 1, vatType: 'standard' },
      null,
      clock,
    );
    const listings = { ebay1: '', ebay2: '', website: '', fba: '' };
    for (const [key, account, provider, fulfilment, ext] of [
      ['ebay1', accounts.ebay1, 'ebay', null, code],
      ['ebay2', accounts.ebay2, 'ebay', null, code],
      ['website', accounts.website, 'website', null, code],
      ['fba', accounts.amazon, 'amazon', 'fba', code],
    ] as const) {
      const { autoMapped } = await catalogue.upsertDiscovered(
        ctx,
        account,
        provider,
        [
          {
            externalSku: ext,
            externalId: `${key}-id`,
            title: null,
            fulfilment,
            inventoryApi: null,
            quantity: null,
          },
        ],
        clock,
      );
      listings[key] = autoMapped[0]?.listingId ?? '';
    }
    if (onHand !== 0) {
      await engine().stockIn(ctx, sku, { quantity: onHand, clientRef: randomUUID(), userId: null });
    }
    return { ctx, company, accounts, sku, listings };
  };

  /** The open (not cancelled) writes, newest first, as listing → quantity. */
  const queued = async (w: World) => {
    const { rows } = await withTenantTransaction(db, w.ctx, (trx) =>
      sql<{ listing_id: string; quantity: string; state: string; id: string }>`
        SELECT lw.listing_id, lw.quantity, o.state, o.id
          FROM app.listing_writes lw
          JOIN app.outbound_writes o ON o.workspace_id = lw.workspace_id AND o.id = lw.outbound_write_id
         WHERE lw.workspace_id = ${w.ctx.workspaceId}::uuid
         ORDER BY split_part(o.idempotency_key, ':', 3)::int DESC, o.created_at DESC`.execute(trx),
    );
    return rows;
  };
  const latest = async (w: World) => {
    const out = new Map<string, number>();
    for (const r of await queued(w)) {
      if (r.state !== 'cancelled' && !out.has(r.listing_id))
        out.set(r.listing_id, Number(r.quantity));
    }
    return out;
  };
  const stock = async (w: World, sku = w.sku) => {
    const detail = await engine().getStock(w.ctx, sku);
    if (detail === undefined) throw new Error('no stock');
    return detail;
  };
  const order = () => randomUUID();
  const pick = (m: Map<string, number>, ids: readonly string[]) => ids.map((id) => m.get(id));
  const sell = (w: World, listing: string, quantity: number, line = order()) =>
    engine().reserve(w.ctx, {
      orderLineId: line,
      listingId: listing,
      quantity,
      companyId: w.company,
    });
  const sendAll = async (w: World) => {
    // The outbound path's own result, for the tests that read last_sent (INV-8).
    for (const r of await queued(w)) {
      if (r.state !== 'pending') continue;
      await withTenantTransaction(db, w.ctx, async (trx) => {
        await sql`UPDATE app.outbound_writes SET state = 'sent', result = '{"accepted":1,"refused":[]}'
                   WHERE workspace_id = ${w.ctx.workspaceId}::uuid AND id = ${r.id}::uuid`.execute(
          trx,
        );
      });
      await engine().recordPushResult(w.ctx, r.id);
    }
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 10 }),
      }),
    });
    owner = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 1 });
    catalogue = new CatalogueRepository(db);
    writes = new OutboundWriteRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await owner.end();
    await cluster.container.stop();
  });

  it('[INV-1] [INV-3] each movement kind moves on hand and reserved once; a repeated event is a no-op', async () => {
    const w = await world(10);
    const e = engine();
    const line = order();
    expect(await sell(w, w.listings.ebay1, 2, line)).toMatchObject({
      applied: true,
      oversold: false,
    });
    expect(await sell(w, w.listings.ebay1, 2, line)).toMatchObject({ applied: false });
    expect(await stock(w)).toMatchObject({ onHand: 10, reserved: 2, available: 8 });
    await e.dispatch(w.ctx, { orderLineId: line, listingId: w.listings.ebay1, quantity: 2 });
    await e.dispatch(w.ctx, { orderLineId: line, listingId: w.listings.ebay1, quantity: 2 });
    expect(await stock(w)).toMatchObject({ onHand: 8, reserved: 0, available: 8 });
    const cancelled = order();
    await sell(w, w.listings.website, 3, cancelled);
    await e.release(w.ctx, { orderLineId: cancelled, listingId: w.listings.website, quantity: 3 });
    await e.release(w.ctx, { orderLineId: cancelled, listingId: w.listings.website, quantity: 3 });
    expect(await stock(w)).toMatchObject({ onHand: 8, reserved: 0 });
    await e.returnToStock(w.ctx, { refundLineId: line, listingId: w.listings.ebay1, quantity: 1 });
    const ref = randomUUID();
    const first = await e.stockIn(w.ctx, w.sku, {
      quantity: 5,
      supplier: 'Alder',
      clientRef: ref,
      userId: null,
    });
    const again = await e.stockIn(w.ctx, w.sku, {
      quantity: 5,
      supplier: 'Alder',
      clientRef: ref,
      userId: null,
    });
    expect(again.id).toBe(first.id);
    await e.adjust(w.ctx, w.sku, {
      delta: -2,
      reason: 'damaged',
      clientRef: randomUUID(),
      userId: null,
    });
    await expect(
      e.adjust(w.ctx, w.sku, { delta: -1, reason: 'other', clientRef: randomUUID(), userId: null }),
    ).rejects.toMatchObject({ code: 'reason_text_required' });
    await e.stockTake(w.ctx, 'take-1', [{ skuId: w.sku, onHand: 20 }], null);
    await e.stockTake(w.ctx, 'take-1', [{ skuId: w.sku, onHand: 20 }], null);
    expect(await stock(w)).toMatchObject({ onHand: 20, reserved: 0, available: 20 });
    const log = await e.listMovements(w.ctx, { skuId: w.sku, offset: 0, limit: 50 }, 100);
    expect(log.items.map((m) => m.kind).sort()).toEqual(
      [
        'adjust',
        'dispatch',
        'release',
        'reserve',
        'reserve',
        'return',
        'stock_in',
        'stock_in',
        'stock_take',
      ].sort(),
    );
    // On hand changes only through movements: the log sums to the number (INV-3, INV-5).
    expect(log.items.reduce((sum, m) => sum + m.onHandChange, 0)).toBe(20);
  });

  it('[INV-5] the change log is append-only and kept 3 years', async () => {
    const w = await world(4);
    await expect(
      withTenantTransaction(db, w.ctx, (trx) =>
        sql`UPDATE app.stock_movements SET note = 'x' WHERE workspace_id = ${w.ctx.workspaceId}::uuid`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'OBS01' });
    await withTenantTransaction(db, w.ctx, (trx) =>
      sql`INSERT INTO app.stock_movements (workspace_id, id, master_sku_id, kind, source_kind, source_id,
            on_hand_change, reserved_change, on_hand_after, reserved_after, created_at)
          VALUES (${w.ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${w.sku}::uuid, 'adjust', 'user',
                  'old-row', 0, 0, 0, 0, now() - interval '3 years 1 day')`.execute(trx),
    );
    expect(await engine().purgeExpired(w.ctx)).toBe(1);
    const left = await engine().listMovements(w.ctx, { skuId: w.sku, offset: 0, limit: 10 }, 100);
    expect(left.total).toBe(1);
  });

  it('[INV-6] 20 parallel orders on the last 5 units: every movement counts, the overflow is flagged Oversold', async () => {
    const w = await world(5);
    notices.length = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => sell(w, w.listings.ebay1, 1)),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(20);
    expect(results.filter((r) => r.oversold)).toHaveLength(15);
    expect(await stock(w)).toMatchObject({
      onHand: 5,
      reserved: 20,
      available: -15,
      oversold: true,
    });
    expect(notices.filter((n) => n.type === 'inventory.oversold')).toHaveLength(15);
    // Every other channel is told 0, never a negative number (the seller counted down itself).
    expect(pick(await latest(w), [w.listings.ebay2, w.listings.website])).toEqual([0, 0]);
  });

  it('[AT-4] [INV-4] one sale queues the lower quantity for every other mapped listing; the seller gets none', async () => {
    const w = await world(10);
    await sendAll(w);
    await sell(w, w.listings.ebay1, 1);
    const after = await queued(w);
    // Everything before the sale was sent: the pending writes are the sale's.
    const fresh = after.filter((r) => r.state === 'pending');
    expect(fresh.map((r) => r.listing_id).sort()).toEqual(
      [w.listings.ebay2, w.listings.website].sort(),
    );
    expect(fresh.every((r) => Number(r.quantity) === 9)).toBe(true);
    // INV-9: the FBA listing is never written; nothing changes, nothing is queued.
    expect(after.some((r) => r.listing_id === w.listings.fba)).toBe(false);
    await engine().stockTake(w.ctx, 'same', [{ skuId: w.sku, onHand: 10 }], null);
    expect((await queued(w)).length).toBe(after.length);
  });

  it('[INV-4] one write per listing: a newer target cancels the write still waiting', async () => {
    const w = await world(10);
    await sell(w, w.listings.ebay1, 1);
    await sell(w, w.listings.ebay1, 1);
    const rows = (await queued(w)).filter((r) => r.listing_id === w.listings.website);
    expect(rows.filter((r) => r.state === 'pending')).toHaveLength(1);
    expect(rows.find((r) => r.state === 'pending')?.quantity).toBe('8');
    expect(rows.filter((r) => r.state === 'cancelled').length).toBeGreaterThanOrEqual(1);
  });

  it('[INV-2] buffers: the account default, a listing override and back', async () => {
    const w = await world(20);
    await engine().setAccountBuffer(w.ctx, w.accounts.ebay2, 5);
    expect((await latest(w)).get(w.listings.ebay2)).toBe(15);
    await engine().setListingBuffer(w.ctx, w.listings.ebay2, 2);
    expect((await latest(w)).get(w.listings.ebay2)).toBe(18);
    await engine().setListingBuffer(w.ctx, w.listings.ebay2, null);
    expect((await latest(w)).get(w.listings.ebay2)).toBe(15);
    const listing = (await stock(w)).listings.find((l) => l.id === w.listings.ebay2);
    expect(listing).toMatchObject({ buffer: 5, bufferOverride: false, target: 15 });
  });

  it('[AT-27] manual allocation end to end: set, sell, cap by stock, back to Auto', async () => {
    const w = await world(186);
    await sendAll(w);
    const A = w.listings.ebay1;
    const B = w.listings.ebay2;
    const C = w.listings.website;
    // 1. Available 186; A = 120 and B = 10, C stays on Auto.
    const saved = await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [
        { listingId: A, mode: 'manual', manualQty: 120 },
        { listingId: B, mode: 'manual', manualQty: 10 },
      ],
      userId: null,
    });
    expect(saved.changes).toHaveLength(2);
    expect(pick(await latest(w), [A, B, C])).toEqual([120, 10, 186]);
    expect((await stock(w)).syncMode).toBe('mixed');
    // 2. Sell 5 on B: B = 5, A = 120, C follows available 181.
    await sell(w, B, 5);
    let view = await stock(w);
    const target = (id: string) => view.listings.find((l) => l.id === id)?.target;
    expect([target(A), target(B), target(C)]).toEqual([120, 5, 181]);
    expect(view.allocation).toEqual({ allocated: 125, available: 181 });
    // 3. Available 50 by adjustment: A is capped to 50 with the badge.
    await engine().adjust(w.ctx, w.sku, {
      delta: -131,
      reason: 'count_correction',
      clientRef: randomUUID(),
      userId: null,
    });
    view = await stock(w);
    expect(view.available).toBe(50);
    expect(view.listings.find((l) => l.id === A)).toMatchObject({
      target: 50,
      cappedByStock: true,
    });
    expect((await latest(w)).get(A)).toBe(50);
    // 4. Back to Auto: every listing gets max(0, available - buffer), one write each, now.
    const pushed = await engine().backToAuto(w.ctx, w.sku, { includeBundles: true, userId: null });
    expect(pushed.pushes.map((p) => p.result)).toEqual(['queued', 'queued', 'queued']);
    expect(pick(await latest(w), [A, B, C])).toEqual([50, 50, 50]);
    expect((await stock(w)).syncMode).toBe('auto');
    const log = await engine().listMovements(
      w.ctx,
      { skuId: w.sku, kind: 'allocation', offset: 0, limit: 10 },
      10,
    );
    expect(log.items.map((m) => m.note).sort()).toEqual([
      'auto',
      'auto',
      'manual 10',
      'manual 120',
    ]);
  });

  it('[AT-27] C7.3 an order arriving while the user edits: the version check refuses the save', async () => {
    const w = await world(30);
    const version = (await stock(w)).version;
    await sell(w, w.listings.website, 1);
    await expect(
      engine().saveAllocation(w.ctx, w.sku, {
        version,
        listings: [{ listingId: w.listings.ebay1, mode: 'manual', manualQty: 5 }],
        userId: null,
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('[AT-27] C7.3 FBA cannot be manual; an unmapped listing gets no writes at all', async () => {
    const w = await world(30);
    await expect(
      engine().saveAllocation(w.ctx, w.sku, {
        version: (await stock(w)).version,
        listings: [{ listingId: w.listings.fba, mode: 'manual', manualQty: 1 }],
        userId: null,
      }),
    ).rejects.toBeInstanceOf(StockRefused);
    await catalogue.unmapListing(w.ctx, w.listings.website, clock);
    await engine().onListingMapped(w.ctx, {
      listingId: w.listings.website,
      masterSkuId: null,
      previousMasterSkuId: w.sku,
    });
    const count = (await queued(w)).filter((r) => r.listing_id === w.listings.website).length;
    await sell(w, w.listings.ebay1, 3);
    expect((await queued(w)).filter((r) => r.listing_id === w.listings.website)).toHaveLength(
      count,
    );
    // A sale on the unmapped listing moves no stock (CAT-6) until it is mapped.
    expect(await sell(w, w.listings.website, 1)).toMatchObject({ applied: false, unmapped: true });
  });

  it('[AT-27] C7.3 a listing remapped to another SKU resets to Auto, with a notice', async () => {
    const w = await world(30);
    await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [{ listingId: w.listings.ebay1, mode: 'manual', manualQty: 4 }],
      userId: null,
    });
    const other = await catalogue.createSku(
      w.ctx,
      {
        sku: 'OTHER-1',
        title: 'Other',
        shortDescription: 'Other',
        weightG: 1,
        vatType: 'standard',
      },
      null,
      clock,
    );
    await engine().stockIn(w.ctx, other, { quantity: 7, clientRef: randomUUID(), userId: null });
    await catalogue.unmapListing(w.ctx, w.listings.ebay1, clock);
    await catalogue.mapListing(w.ctx, w.listings.ebay1, other, 'manual', null, clock);
    notices.length = 0;
    await engine().onListingMapped(w.ctx, {
      listingId: w.listings.ebay1,
      masterSkuId: other,
      previousMasterSkuId: w.sku,
    });
    expect(notices).toContainEqual({
      op: 'raise',
      type: 'inventory.mode_reset',
      id: w.listings.ebay1,
    });
    const moved = (await stock(w, other)).listings.find((l) => l.id === w.listings.ebay1);
    expect(moved).toMatchObject({ mode: 'auto', manual: null, target: 7 });
    expect((await latest(w)).get(w.listings.ebay1)).toBe(7);
  });

  it('[AT-27] C7.3 a bundle listing of a manual component keeps its own mode', async () => {
    const w = await world(30);
    const bundle = await catalogue.createSku(
      w.ctx,
      {
        sku: 'BB-X3',
        title: 'Pack',
        shortDescription: 'Pack',
        weightG: 3,
        bundle: { componentId: w.sku, packSize: 3 },
      },
      null,
      clock,
    );
    const site = await catalogue.upsertDiscovered(
      w.ctx,
      w.accounts.website,
      'website',
      [
        {
          externalSku: 'BB-X3',
          externalId: 'pack',
          title: null,
          fulfilment: null,
          inventoryApi: null,
          quantity: null,
        },
      ],
      clock,
    );
    const packListing = site.autoMapped[0]?.listingId ?? '';
    await engine().onListingMapped(w.ctx, {
      listingId: packListing,
      masterSkuId: bundle,
      previousMasterSkuId: null,
    });
    expect((await latest(w)).get(packListing)).toBe(10);
    await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [{ listingId: w.listings.ebay1, mode: 'manual', manualQty: 6 }],
      userId: null,
    });
    // The pack listing is still on Auto: floor(30 / 3).
    expect((await stock(w, bundle)).listings[0]).toMatchObject({ mode: 'auto', target: 10 });
    // A sale of 2 packs takes 6 units of the component (CAT-3).
    await sell(w, packListing, 2);
    expect(await stock(w)).toMatchObject({ reserved: 6, available: 24 });
    expect((await latest(w)).get(w.listings.ebay1)).toBe(6);
  });

  it('[AT-27] C7.3 stock-in while manual: manual targets rise only to what is left; auto listings get it all', async () => {
    const w = await world(5);
    await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [{ listingId: w.listings.ebay1, mode: 'manual', manualQty: 8 }],
      userId: null,
    });
    expect((await latest(w)).get(w.listings.ebay1)).toBe(5);
    await engine().stockIn(w.ctx, w.sku, { quantity: 100, clientRef: randomUUID(), userId: null });
    const now = await latest(w);
    expect(now.get(w.listings.ebay1)).toBe(8);
    expect(now.get(w.listings.website)).toBe(105);
  });

  it('[AT-27] C7.3 a channel listing that ended loses its manual settings', async () => {
    const w = await world(30);
    await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [{ listingId: w.listings.ebay2, mode: 'manual', manualQty: 3 }],
      userId: null,
    });
    const later = new Date(clock.getTime() + 60_000);
    await catalogue.upsertDiscovered(
      w.ctx,
      w.accounts.ebay2,
      'ebay',
      [
        {
          externalSku: 'SOMETHING-ELSE',
          externalId: 'x',
          title: null,
          fulfilment: null,
          inventoryApi: true,
          quantity: 1,
        },
      ],
      later,
    );
    const ended = await catalogue.endUnseen(w.ctx, w.accounts.ebay2, later, later);
    expect(ended).toContain(w.listings.ebay2);
    await engine().onListingsEnded(w.ctx, ended);
    const { rows } = await withTenantTransaction(db, w.ctx, (trx) =>
      sql<{ stock_mode: string; manual_qty: string | null }>`
        SELECT stock_mode, manual_qty FROM app.listings WHERE id = ${w.listings.ebay2}::uuid`.execute(
        trx,
      ),
    );
    expect(rows[0]).toEqual({ stock_mode: 'auto', manual_qty: null });
  });

  it('[AT-27] C7.3 a buffer change: the manual cap uses the new buffer', async () => {
    const w = await world(20);
    await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [{ listingId: w.listings.ebay1, mode: 'manual', manualQty: 50 }],
      userId: null,
    });
    expect((await latest(w)).get(w.listings.ebay1)).toBe(20);
    await engine().setAccountBuffer(w.ctx, w.accounts.ebay1, 4);
    expect((await latest(w)).get(w.listings.ebay1)).toBe(16);
  });

  it('[AT-27] C7.3 oversold is driven by master available, manual or not; the website follows the same rules', async () => {
    const w = await world(3);
    await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [{ listingId: w.listings.website, mode: 'manual', manualQty: 10 }],
      userId: null,
    });
    expect((await latest(w)).get(w.listings.website)).toBe(3);
    // The website sells 2 (it counts down to 1 itself), then eBay oversells the rest.
    expect((await sell(w, w.listings.website, 2)).oversold).toBe(false);
    const result = await sell(w, w.listings.ebay1, 4);
    expect(result.oversold).toBe(true);
    expect(await stock(w)).toMatchObject({ available: -3, oversold: true });
    // The manual website listing is capped by master available: 0, written once.
    expect((await latest(w)).get(w.listings.website)).toBe(0);
    expect(
      (await stock(w)).listings.find((l) => l.id === w.listings.website)?.manual,
    ).toMatchObject({ qty: 10, sold: 2 });
  });

  it('[AT-27] C7.3 a held account: the write waits as today and the result says held', async () => {
    const w = await world(30);
    await withTenantTransaction(db, w.ctx, (trx) =>
      sql`UPDATE app.channel_accounts SET paused_at = now() WHERE id = ${w.accounts.ebay2}::uuid`.execute(
        trx,
      ),
    );
    const pushed = await engine().backToAuto(w.ctx, w.sku, {
      listingIds: [w.listings.ebay2],
      includeBundles: false,
      userId: null,
    });
    expect(pushed.pushes).toEqual([{ listingId: w.listings.ebay2, result: 'held' }]);
  });

  it('[INV-10] used up: an info notice at 0; a cancellation gives it back, never below 0', async () => {
    const w = await world(50);
    await engine().saveAllocation(w.ctx, w.sku, {
      version: (await stock(w)).version,
      listings: [{ listingId: w.listings.ebay1, mode: 'manual', manualQty: 2 }],
      userId: null,
    });
    notices.length = 0;
    const line = order();
    await sell(w, w.listings.ebay1, 2, line);
    expect(notices).toContainEqual({
      op: 'raise',
      type: 'inventory.allocation_used_up',
      id: w.listings.ebay1,
    });
    // The listing shows 0: its channel counted down itself, so no write is needed (C7.1).
    expect((await stock(w)).listings.find((x) => x.id === w.listings.ebay1)?.target).toBe(0);
    await engine().release(w.ctx, { orderLineId: line, listingId: w.listings.ebay1, quantity: 2 });
    await engine().release(w.ctx, {
      orderLineId: order(),
      listingId: w.listings.ebay1,
      quantity: 9,
    });
    const l = (await stock(w)).listings.find((x) => x.id === w.listings.ebay1);
    expect(l?.manual?.sold).toBe(0);
    expect(l?.target).toBe(2);
  });

  it('[INV-8] a final failure sets Sync failed and the notice; the next success clears both', async () => {
    const w = await world(10);
    const pending = (await queued(w)).find(
      (r) => r.listing_id === w.listings.website && r.state === 'pending',
    );
    await withTenantTransaction(db, w.ctx, (trx) =>
      sql`UPDATE app.outbound_writes SET state = 'failed', last_error_code = 'provider.http_500'
           WHERE id = ${pending?.id ?? ''}::uuid`.execute(trx),
    );
    notices.length = 0;
    await engine().recordPushResult(w.ctx, pending?.id ?? '');
    expect(notices).toEqual([
      { op: 'raise', type: 'inventory.sync_failed', id: w.listings.website },
    ]);
    expect(await stock(w)).toMatchObject({ syncFailed: true });
    expect(
      (await stock(w)).listings.find((l) => l.id === w.listings.website)?.lastPush?.result,
    ).toBe('failed');
    await engine().pushAccounts(w.ctx, [w.accounts.website]);
    await sendAll(w);
    expect(notices).toContainEqual({
      op: 'resolve',
      type: 'inventory.sync_failed',
      id: w.listings.website,
    });
    expect(await stock(w)).toMatchObject({ syncFailed: false });
    expect((await stock(w)).listings.find((l) => l.id === w.listings.website)?.lastSentQty).toBe(
      10,
    );
  });

  it('[INV-7] reconciliation corrects drift, skips a listing with a recent order, and alerts on repeated drift', async () => {
    const w = await world(10);
    await sendAll(w);
    const scan = new Date(clock.getTime() + 3_600_000);
    const seen = async (qty: Record<string, number>, at: Date) => {
      for (const [account, provider, ext] of [
        [w.accounts.ebay1, 'ebay', 'BB-BAM-M100'],
        [w.accounts.ebay2, 'ebay', 'BB-BAM-M100'],
      ] as const) {
        await catalogue.upsertDiscovered(
          w.ctx,
          account,
          provider,
          [
            {
              externalSku: ext,
              externalId: 'x',
              title: null,
              fulfilment: null,
              inventoryApi: true,
              quantity: qty[account] ?? 10,
            },
          ],
          at,
        );
      }
    };
    // ebay1 drifted to 7; ebay2 had an order 5 minutes before the scan.
    await seen({ [w.accounts.ebay1]: 7, [w.accounts.ebay2]: 4 }, scan);
    await withTenantTransaction(db, w.ctx, (trx) =>
      sql`UPDATE app.listings SET last_order_at = ${new Date(scan.getTime() - 5 * 60_000)}
           WHERE id = ${w.listings.ebay2}::uuid`.execute(trx),
    );
    expect(await engine().reconcile(w.ctx, w.accounts.ebay1, scan)).toEqual({
      checked: 1,
      drifted: 1,
    });
    expect(await engine().reconcile(w.ctx, w.accounts.ebay2, scan)).toEqual({
      checked: 0,
      drifted: 0,
    });
    const fresh = (await queued(w)).filter((r) => r.state === 'pending');
    expect(fresh.map((r) => [r.listing_id, r.quantity])).toEqual([[w.listings.ebay1, '10']]);
    await sendAll(w);
    // The next night it drifted again: the alert.
    notices.length = 0;
    const next = new Date(scan.getTime() + 86_400_000);
    await seen({ [w.accounts.ebay1]: 6 }, next);
    await engine().reconcile(w.ctx, w.accounts.ebay1, next);
    expect(notices).toContainEqual({
      op: 'raise',
      type: 'inventory.sync_failed',
      id: w.listings.ebay1,
    });
  });

  it('[INV-5] the change log shows the listings pushed after a movement, by result', async () => {
    const w = await world(10);
    await sell(w, w.listings.ebay1, 1);
    const log = await engine().listMovements(
      w.ctx,
      { skuId: w.sku, kind: 'reserve', offset: 0, limit: 5 },
      5,
    );
    expect(log.items[0]?.pushes).toEqual({ pending: 2, sent: 0, held: 0, failed: 0 });
    expect(log.items[0]?.companyVisible).toBe(true);
    // A user without the order's company sees the movement but not its order (6.1).
    const child: TenantContext = { workspaceId: w.ctx.workspaceId, companyIds: [] };
    const seen = await engine().listMovements(
      child,
      { skuId: w.sku, kind: 'reserve', offset: 0, limit: 5 },
      5,
    );
    expect(seen.items[0]?.companyVisible).toBe(false);
  });

  it('[CAT-6] mapping later back-fills the unmapped orders’ movements once', async () => {
    const w = await world(10, 'BF-1');
    await catalogue.unmapListing(w.ctx, w.listings.website, clock);
    await engine().onListingMapped(w.ctx, {
      listingId: w.listings.website,
      masterSkuId: null,
      previousMasterSkuId: w.sku,
    });
    demand.lines.set(w.listings.website, [
      { orderLineId: randomUUID(), quantity: 2, dispatched: false, companyId: w.company },
      { orderLineId: randomUUID(), quantity: 1, dispatched: true, companyId: w.company },
    ]);
    await catalogue.mapListing(w.ctx, w.listings.website, w.sku, 'manual', null, clock);
    const change = { listingId: w.listings.website, masterSkuId: w.sku, previousMasterSkuId: null };
    await engine().onListingMapped(w.ctx, change);
    await engine().onListingMapped(w.ctx, change);
    expect(await stock(w)).toMatchObject({ onHand: 9, reserved: 2, available: 7 });
    expect((await latest(w)).get(w.listings.website)).toBe(7);
  });

  it('[TEN-6] one workspace’s stock is invisible to another', async () => {
    const a = await world(10, 'ISO-1');
    const b = await world(3, 'ISO-2');
    expect(await engine().getStock(b.ctx, a.sku)).toBeUndefined();
    await expect(
      engine().stockIn(b.ctx, a.sku, { quantity: 1, clientRef: randomUUID(), userId: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      (await engine().listStock(b.ctx, { offset: 0, limit: 10 }, 100)).items.map((r) => r.sku),
    ).toEqual(['ISO-2']);
    clock = NOW;
  });
});
