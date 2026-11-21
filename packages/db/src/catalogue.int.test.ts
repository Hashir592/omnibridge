import { randomUUID } from 'node:crypto';
import { bundleAvailable, pence, type TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogueRefused, CatalogueRepository, type NewSku } from './catalogue.ts';
import { migrateMain } from './migrate.ts';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;
const NOW = new Date('2026-11-21T10:00:00Z');

const plain = (sku: string, extra: Partial<NewSku> = {}): NewSku => ({
  sku,
  title: `Product ${sku}`,
  shortDescription: 'Bamboo item',
  weightG: 250,
  vatType: 'standard',
  ...extra,
});

const bundleOf = (sku: string, componentId: string, packSize: number): NewSku => ({
  sku,
  title: `Bundle ${sku}`,
  shortDescription: 'Bamboo pack',
  weightG: 750,
  bundle: { componentId, packSize },
});

/**
 * T-0801 storage on real PostgreSQL: Master SKUs and bundles (CAT-1, CAT-3), the VAT-type and
 * COGS histories with the lookups M10's write-once snapshots use (CAT-2, CAT-4, ADR-078 4), and
 * listings with exact-code matching and one SKU per listing (CAT-5, CAT-6).
 */
describe('catalogue (T-0801)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let repo: CatalogueRepository;

  const workspace = async (): Promise<TenantContext> => {
    const ctx: TenantContext = { workspaceId: randomUUID(), companyIds: [randomUUID()] };
    await withTenantTransaction(db, ctx, async (trx) => {
      await trx
        .insertInto('app.workspaces')
        .values({ id: ctx.workspaceId, name: 'Catalogue test' })
        .execute();
      await trx
        .insertInto('app.companies')
        .values({
          id: ctx.companyIds[0] ?? '',
          workspace_id: ctx.workspaceId,
          legal_name: 'Catalogue Ltd',
          trading_name: 'Catalogue',
          address_line1: '1 Test Street',
          address_city: 'Testville',
          address_postcode: 'TE1 1ST',
        })
        .execute();
    });
    return ctx;
  };

  const account = (ctx: TenantContext, provider: 'ebay' | 'amazon' | 'website' = 'ebay') =>
    withTenantTransaction(db, ctx, async (trx) => {
      const id = randomUUID();
      await trx
        .insertInto('app.channel_accounts')
        .values({
          id,
          workspace_id: ctx.workspaceId,
          company_id: ctx.companyIds[0] ?? '',
          provider,
          display_name: `Account ${provider}`,
        })
        .execute();
      return id;
    });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({ pool: new pg.Pool(cluster.connection('ob_app')) }),
    });
    repo = new CatalogueRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  it('[CAT-1] a SKU code is unique per workspace, and the same code is free in another', async () => {
    const a = await workspace();
    const b = await workspace();
    await repo.createSku(a, plain('BB-1', { manufacturer: 'Kestrel' }), null, NOW);
    await expect(repo.createSku(a, plain('BB-1'), null, NOW)).rejects.toThrow(CatalogueRefused);
    await expect(repo.createSku(b, plain('BB-1'), null, NOW)).resolves.toBeTypeOf('string');
    await repo.createSku(a, plain('BB-2', { manufacturer: 'Kestrel' }), null, NOW);
    await repo.createSku(a, plain('BB-3', { manufacturer: 'Alder' }), null, NOW);
    expect(await repo.manufacturers(a)).toEqual(['Alder', 'Kestrel']);
  });

  it('[CAT-2] every workspace starts with the four UK rates; zero-rated and No VAT stay apart', async () => {
    const ctx = await workspace();
    const rates = await repo.vatRates(ctx);
    expect(rates.map((r) => [r.vatType, r.rateBp])).toEqual([
      ['no_vat', 0],
      ['reduced', 500],
      ['standard', 2000],
      ['zero', 0],
    ]);
    expect(await repo.vatRateOn(ctx, 'standard', '2026-11-21')).toBe(2000);
    // A future rate change is a row, not code; a rate for a past day is unchanged by it.
    expect(
      await repo.addVatRate(
        ctx,
        { vatType: 'standard', rateBp: 2200, effectiveFrom: '2027-04-01' },
        NOW,
      ),
    ).toBe(true);
    expect(await repo.vatRateOn(ctx, 'standard', '2027-03-31')).toBe(2000);
    expect(await repo.vatRateOn(ctx, 'standard', '2027-04-01')).toBe(2200);
  });

  it('[CAT-2] vatTypeOn follows the SKU history; a bundle follows its component', async () => {
    const ctx = await workspace();
    const id = await repo.createSku(ctx, plain('VT-1', { vatType: 'zero' }), null, NOW);
    const bundle = await repo.createSku(ctx, bundleOf('VT-1-X3', id, 3), null, NOW);
    await repo.updateSku(
      ctx,
      id,
      { vat: { vatType: 'no_vat', effectiveFrom: '2026-12-01' } },
      null,
      NOW,
    );
    expect(await repo.vatTypeOn(ctx, id, '2026-11-30')).toBe('zero');
    expect(await repo.vatTypeOn(ctx, id, '2026-12-01')).toBe('no_vat');
    expect(await repo.vatTypeOn(ctx, bundle, '2026-11-30')).toBe('zero');
    expect(await repo.vatTypeOn(ctx, bundle, '2026-12-01')).toBe('no_vat');
    // CAT-3: the bundle's VAT type is locked to its component.
    await expect(
      repo.updateSku(
        ctx,
        bundle,
        { vat: { vatType: 'standard', effectiveFrom: '2026-12-02' } },
        null,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'bundle_locked' });
  });

  it('[CAT-4] cogsOn returns the value in effect on the date; a later change leaves an earlier lookup alone', async () => {
    const ctx = await workspace();
    const id = await repo.createSku(
      ctx,
      plain('CG-1', { firstCogs: { cogsPence: pence(450n), effectiveFrom: '2026-01-01' } }),
      null,
      NOW,
    );
    expect(await repo.cogsOn(ctx, id, '2025-12-31')).toBeUndefined();
    expect(await repo.cogsOn(ctx, id, '2026-06-30')).toBe(450n);
    await repo.setCogs(ctx, id, pence(520n), '2026-07-01', null, NOW);
    expect(await repo.cogsOn(ctx, id, '2026-06-30')).toBe(450n);
    expect(await repo.cogsOn(ctx, id, '2026-07-01')).toBe(520n);
    // The same date again replaces the value (one value per SKU per date).
    await repo.setCogs(ctx, id, pence(530n), '2026-07-01', null, NOW);
    expect(await repo.cogsOn(ctx, id, '2026-07-01')).toBe(530n);
    expect((await repo.cogsHistory(ctx, id))?.map((c) => [c.effectiveFrom, c.cogsPence])).toEqual([
      ['2026-07-01', 530n],
      ['2026-01-01', 450n],
    ]);
  });

  it('[CAT-3] [AT-5] a bundle is one component times a pack: COGS times pack, available floored', async () => {
    const ctx = await workspace();
    const id = await repo.createSku(
      ctx,
      plain('BN-1', { firstCogs: { cogsPence: pence(333n), effectiveFrom: '2026-01-01' } }),
      null,
      NOW,
    );
    const bundle = await repo.createSku(ctx, bundleOf('BN-1-X3', id, 3), null, NOW);
    expect(await repo.cogsOn(ctx, bundle, '2026-11-21')).toBe(999n);
    const detail = await repo.getSku(ctx, bundle, '2026-11-21');
    expect(detail).toMatchObject({
      vatType: 'standard',
      cogsPence: 999n,
      bundle: { componentId: id, componentSku: 'BN-1', packSize: 3 },
      cogsHistory: [],
    });
    // AT-5: a bundle of 3 shows floor(available / 3); M09 feeds it the real number.
    expect(bundleAvailable(10, 3)).toBe(3);
    expect(bundleAvailable(2, 3)).toBe(0);
    // A bundle's COGS is derived, never set.
    await expect(
      repo.setCogs(ctx, bundle, pence(1n), '2026-11-21', null, NOW),
    ).rejects.toMatchObject({ code: 'bundle_locked' });
  });

  it('[CAT-3] [AT-5] refuses a bundle of a bundle, a VAT type on a bundle, and any make-up change', async () => {
    const ctx = await workspace();
    const id = await repo.createSku(ctx, plain('MX-1'), null, NOW);
    const bundle = await repo.createSku(ctx, bundleOf('MX-1-X2', id, 2), null, NOW);
    await expect(
      repo.createSku(ctx, bundleOf('MX-1-X4', bundle, 2), null, NOW),
    ).rejects.toMatchObject({ code: 'component_is_bundle' });
    await expect(
      repo.createSku(
        ctx,
        { ...plain('MX-1-X3'), bundle: { componentId: id, packSize: 3 } },
        null,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'bundle_locked' });
    // A bundle names one component only; the table has no column for a second, and the trigger
    // refuses changing the one it has (a different pack is a new SKU).
    const other = await repo.createSku(ctx, plain('MX-2'), null, NOW);
    await expect(
      withTenantTransaction(db, ctx, (trx) =>
        trx
          .updateTable('app.master_skus')
          .set({ bundle_component_id: other })
          .where('id', '=', bundle)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'OBK01' });
    await expect(
      withTenantTransaction(db, ctx, (trx) =>
        trx.updateTable('app.master_skus').set({ pack_size: 5 }).where('id', '=', bundle).execute(),
      ),
    ).rejects.toMatchObject({ code: 'OBK01' });
  });

  it('[CAT-5] discovery maps an exact code, queues the rest, and keeps a person’s unmap', async () => {
    const ctx = await workspace();
    const ebay = await account(ctx);
    const sku = await repo.createSku(ctx, plain('MOCK-SKU-1'), null, NOW);
    const first = await repo.upsertDiscovered(
      ctx,
      ebay,
      'ebay',
      [
        {
          externalSku: 'MOCK-SKU-1',
          externalId: '1001',
          title: 'A',
          fulfilment: null,
          inventoryApi: true,
          quantity: 4,
        },
        {
          externalSku: 'mock-sku-1',
          externalId: '1002',
          title: 'B',
          fulfilment: null,
          inventoryApi: true,
          quantity: 1,
        },
        {
          externalSku: 'OTHER-9',
          externalId: '1003',
          title: 'C',
          fulfilment: null,
          inventoryApi: true,
          quantity: 0,
        },
      ],
      NOW,
    );
    expect(first.created).toBe(3);
    expect(first.autoMapped).toHaveLength(1);
    expect(first.autoMapped[0]).toMatchObject({ masterSkuId: sku, previousMasterSkuId: null });
    const queue = await repo.listListings(ctx, { mapped: false, offset: 0, limit: 50 }, 1000);
    // Exact only: a different case is not a match.
    expect(queue.items.map((l) => l.externalSku).sort()).toEqual(['OTHER-9', 'mock-sku-1']);

    const mapped = first.autoMapped[0]?.listingId ?? '';
    await repo.unmapListing(ctx, mapped, NOW);
    const again = await repo.upsertDiscovered(
      ctx,
      ebay,
      'ebay',
      [
        {
          externalSku: 'MOCK-SKU-1',
          externalId: '1001',
          title: 'A',
          fulfilment: null,
          inventoryApi: true,
          quantity: 4,
        },
      ],
      new Date(NOW.getTime() + 60_000),
    );
    expect(again).toEqual({ created: 0, skipped: 0, autoMapped: [] });
    expect((await repo.getListing(ctx, mapped))?.masterSku).toBeNull();
  });

  it('[CAT-5] one listing maps to one SKU; a SKU has many listings', async () => {
    const ctx = await workspace();
    const ebay = await account(ctx);
    const site = await account(ctx, 'website');
    const one = await repo.createSku(ctx, plain('ONE-1'), null, NOW);
    const two = await repo.createSku(ctx, plain('TWO-2'), null, NOW);
    await repo.upsertDiscovered(
      ctx,
      ebay,
      'ebay',
      [
        {
          externalSku: 'X-1',
          externalId: 'e1',
          title: null,
          fulfilment: null,
          inventoryApi: true,
          quantity: null,
        },
      ],
      NOW,
    );
    await repo.upsertDiscovered(
      ctx,
      site,
      'website',
      [
        {
          externalSku: 'X-1',
          externalId: 'w1',
          title: null,
          fulfilment: null,
          inventoryApi: null,
          quantity: null,
        },
      ],
      NOW,
    );
    const listings = (await repo.listListings(ctx, { offset: 0, limit: 10 }, 100)).items;
    const [l1, l2] = listings.map((l) => l.id);
    expect(await repo.mapListing(ctx, l1 ?? '', one, 'manual', null, NOW)).toMatchObject({
      masterSkuId: one,
    });
    // Mapping it again to the same SKU is a no-op; to another one is refused.
    expect(await repo.mapListing(ctx, l1 ?? '', one, 'manual', null, NOW)).toBeNull();
    await expect(repo.mapListing(ctx, l1 ?? '', two, 'manual', null, NOW)).rejects.toMatchObject({
      code: 'already_mapped',
    });
    await repo.mapListing(ctx, l2 ?? '', one, 'manual', null, NOW);
    expect((await repo.getSku(ctx, one, '2026-11-21'))?.listings).toHaveLength(2);
    const unmap = await repo.unmapListing(ctx, l1 ?? '', NOW);
    expect(unmap).toEqual({ listingId: l1, masterSkuId: null, previousMasterSkuId: one });
  });

  it('[CAT-5] a listing a complete scan did not see has ended and leaves the queue', async () => {
    const ctx = await workspace();
    const ebay = await account(ctx);
    await repo.upsertDiscovered(
      ctx,
      ebay,
      'ebay',
      [
        {
          externalSku: 'GONE-1',
          externalId: 'g1',
          title: null,
          fulfilment: null,
          inventoryApi: true,
          quantity: 1,
        },
        {
          externalSku: 'KEPT-1',
          externalId: 'k1',
          title: null,
          fulfilment: null,
          inventoryApi: true,
          quantity: 1,
        },
      ],
      NOW,
    );
    const scan = new Date(NOW.getTime() + 3_600_000);
    await repo.upsertDiscovered(
      ctx,
      ebay,
      'ebay',
      [
        {
          externalSku: 'KEPT-1',
          externalId: 'k1',
          title: null,
          fulfilment: null,
          inventoryApi: true,
          quantity: 1,
        },
      ],
      scan,
    );
    const ended = await repo.endUnseen(ctx, ebay, scan, scan);
    expect(ended).toHaveLength(1);
    const queue = await repo.listListings(ctx, { mapped: false, offset: 0, limit: 10 }, 100);
    expect(queue.items.map((l) => l.externalSku)).toEqual(['KEPT-1']);
  });

  it('[CAT-5] an ended listing leaves the SKU detail and its listing count', async () => {
    const ctx = await workspace();
    const ebay = await account(ctx);
    const sku = await repo.createSku(ctx, plain('END-1'), null, NOW);
    await repo.upsertDiscovered(
      ctx,
      ebay,
      'ebay',
      [
        {
          externalSku: 'END-1',
          externalId: 'e1',
          title: null,
          fulfilment: null,
          inventoryApi: true,
          quantity: 1,
        },
      ],
      NOW,
    );
    expect((await repo.getSku(ctx, sku, '2026-11-21'))?.listingCount).toBe(1);
    const later = new Date(NOW.getTime() + 60_000);
    await repo.endUnseen(ctx, ebay, later, later);
    const detail = await repo.getSku(ctx, sku, '2026-11-21');
    expect(detail?.listingCount).toBe(0);
    expect(detail?.listings).toEqual([]);
    const mapped = await repo.listListings(ctx, { mapped: true, offset: 0, limit: 10 }, 100);
    expect(mapped.total).toBe(0);
  });

  it('[CAT-5] a long title is cut to fit and an over-long code is skipped, so one row never fails a page', async () => {
    const ctx = await workspace();
    const site = await account(ctx, 'website');
    const result = await repo.upsertDiscovered(
      ctx,
      site,
      'website',
      [
        {
          externalSku: 'LONG-1',
          externalId: 'w1',
          title: 'T'.repeat(900),
          fulfilment: null,
          inventoryApi: null,
          quantity: 1,
        },
        {
          externalSku: 'S'.repeat(201),
          externalId: 'w2',
          title: null,
          fulfilment: null,
          inventoryApi: null,
          quantity: 1,
        },
      ],
      NOW,
    );
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    const stored = await repo.listListings(ctx, { offset: 0, limit: 10 }, 100);
    expect(stored.items[0]?.title).toHaveLength(500);
  });

  it('[TEN-6] the catalogue of one workspace is invisible to another', async () => {
    const a = await workspace();
    const b = await workspace();
    const id = await repo.createSku(a, plain('PRIVATE-1'), null, NOW);
    expect(await repo.getSku(b, id, '2026-11-21')).toBeUndefined();
    expect(await repo.cogsOn(b, id, '2026-11-21')).toBeUndefined();
    expect((await repo.listSkus(b, { offset: 0, limit: 10 }, '2026-11-21', 100)).total).toBe(0);
  });
});
