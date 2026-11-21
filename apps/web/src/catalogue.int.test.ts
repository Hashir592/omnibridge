import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  AuditLog,
  CatalogueRepository,
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  migrateMain,
  MembershipRepository,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
  type MappingChange,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { sessionHeaders, startRoleCluster, stubAuth, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const APP = 'https://app.omnibridge.test';
const NOW = new Date('2026-11-21T12:00:00.000Z');

/**
 * The T-0801 routes on real PostgreSQL: SKUs and bundles (CAT-1, CAT-3), VAT rates (CAT-2), COGS
 * with its all-or-nothing CSV import (CAT-4), and listing mapping with its CSV import, export and
 * the CAT-6 mapped event.
 */
describe('catalogue routes (T-0801)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let tenancy: Tenancy;
  const W = { id: randomUUID(), admin: randomUUID(), account: '' };
  const events: MappingChange[] = [];

  const app = () =>
    buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      ...stubAuth(),
      catalogue: {
        catalogue: new CatalogueRepository(db.db),
        audit: new AuditLog(db.db),
        mappingChanged: (_ctx, change) => {
          events.push(change);
          return Promise.resolve();
        },
        now: () => NOW,
      },
    });
  const headers = {
    ...sessionHeaders({ workspaceId: W.id, userId: W.admin, sessionId: `s-${W.admin}` }),
    origin: APP,
  };
  const inW = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: W.id }, fn);

  type Server = ReturnType<typeof app>;
  const call = async (
    server: Server,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) => {
    const res = await server.inject({
      method,
      url: `/api${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: res.statusCode, body: res.json<Record<string, unknown>>(), text: res.body };
  };
  /** A bundle's body: no VAT type, it follows its component (CAT-3). */
  const bundleBody = (code: string, componentId: string, packSize: number) => ({
    sku: code,
    title: `Bundle ${code}`,
    short_description: 'Bamboo pack',
    weight_g: 600,
    bundle: { component_id: componentId, pack_size: packSize },
  });
  const sku = (code: string, extra: object = {}) => ({
    sku: code,
    title: `Product ${code}`,
    short_description: 'Bamboo item',
    weight_g: 200,
    vat_type: 'standard',
    ...extra,
  });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    db = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    await tenancy.run({ workspaceId: W.id, companyIds: [], userId: W.admin }, async (ctx) => {
      await new WorkspaceRepository(db.db).create(ctx, { name: 'Catalogue test' });
      await new UserRepository(db.db).create(ctx, {
        id: W.admin,
        email: `${W.admin}@example.test`,
        name: 'Admin',
      });
      await new MembershipRepository(db.db).add(ctx, { userId: W.admin, role: 'admin' });
    });
    const company = await inW((c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'Cat Ltd',
        tradingName: 'Cat',
        registeredAddress: address,
      }),
    );
    W.account = await inW((c) =>
      new ChannelAccountRepository(db.db).create(c, {
        companyId: company,
        provider: 'ebay',
        displayName: 'eBay main',
      }),
    );
  });

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  it('[CAT-1] [CAT-3] [AT-5] creates SKUs and one-component bundles; refuses a taken code and a bundle of a bundle', async () => {
    const server = app();
    const plain = await call(
      server,
      'POST',
      '/catalogue/skus',
      sku('API-1', { cogs_pence: 250, cogs_effective_from: '2026-01-01', manufacturer: 'Alder' }),
    );
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({
      sku: 'API-1',
      vat_type: 'standard',
      cogs_pence: 250,
      vat_history: [{ vat_type: 'standard' }],
      cogs_history: [{ cogs_pence: 250, effective_from: '2026-01-01' }],
    });
    const id = String(plain.body.id);
    expect((await call(server, 'POST', '/catalogue/skus', sku('API-1'))).status).toBe(409);

    const bundle = await call(server, 'POST', '/catalogue/skus', bundleBody('API-1-X3', id, 3));
    expect(bundle.status).toBe(201);
    expect(bundle.body).toMatchObject({
      vat_type: 'standard',
      cogs_pence: 750,
      bundle: { component_id: id, component_sku: 'API-1', pack_size: 3 },
    });
    const nested = await call(
      server,
      'POST',
      '/catalogue/skus',
      bundleBody('API-1-X9', String(bundle.body.id), 3),
    );
    expect(nested.status).toBe(409);
    // A bundle's VAT type is its component's and cannot be changed (CAT-3).
    const vat = await call(server, 'PATCH', `/catalogue/skus/${String(bundle.body.id)}`, {
      vat: { vat_type: 'zero', effective_from: '2026-12-01' },
    });
    expect(vat.status).toBe(409);
    const makers = await call(server, 'GET', '/catalogue/manufacturers');
    expect(makers.body).toEqual({ items: ['Alder'] });
    await server.close();
  });

  it('[CAT-2] VAT rates: a new rate from a date; zero-rated and No VAT are always 0%', async () => {
    const server = app();
    expect(
      (
        await call(server, 'POST', '/catalogue/vat-rates', {
          vat_type: 'zero',
          rate_bp: 2000,
          effective_from: '2027-01-01',
        })
      ).status,
    ).toBe(409);
    const added = await call(server, 'POST', '/catalogue/vat-rates', {
      vat_type: 'reduced',
      rate_bp: 600,
      effective_from: '2027-01-01',
    });
    expect(added.status).toBe(201);
    const rates = await call(server, 'GET', '/catalogue/vat-rates');
    expect(rates.body.items).toContainEqual({
      vat_type: 'reduced',
      rate_bp: 600,
      effective_from: '2027-01-01',
    });
    await server.close();
  });

  it('[CAT-4] the COGS CSV import is all or nothing, and a dry run writes nothing', async () => {
    const server = app();
    const created = await call(server, 'POST', '/catalogue/skus', sku('CSV-1'));
    const id = String(created.body.id);
    const good = 'SKU,cogs,effective_from\r\nCSV-1,"1,234.50",01/02/2026\r\nCSV-1,7,2026-03-01\r\n';
    const dry = await call(server, 'POST', '/catalogue/cogs/import', { csv: good, dry_run: true });
    expect(dry.body).toEqual({ rows: 2, valid: 2, applied: false, errors: [] });
    expect((await call(server, 'GET', `/catalogue/skus/${id}/cogs`)).body).toEqual({ items: [] });

    const bad = `${good}NOPE-9,1.00,2026-01-01\nCSV-1,1.234,31/02/2026\n`;
    const refused = await call(server, 'POST', '/catalogue/cogs/import', {
      csv: bad,
      dry_run: false,
    });
    expect(refused.body).toEqual({
      rows: 4,
      valid: 2,
      applied: false,
      errors: [
        { line: 4, code: 'sku_unknown', column: 'sku' },
        { line: 5, code: 'cogs_invalid', column: 'cogs' },
        { line: 5, code: 'date_invalid', column: 'effective_from' },
      ],
    });
    expect((await call(server, 'GET', `/catalogue/skus/${id}/cogs`)).body).toEqual({ items: [] });

    const applied = await call(server, 'POST', '/catalogue/cogs/import', {
      csv: good,
      dry_run: false,
    });
    expect(applied.body).toMatchObject({ applied: true, valid: 2 });
    const history = await call(server, 'GET', `/catalogue/skus/${id}/cogs`);
    expect(history.body.items).toEqual([
      expect.objectContaining({ cogs_pence: 700, effective_from: '2026-03-01' }),
      expect.objectContaining({ cogs_pence: 123450, effective_from: '2026-02-01' }),
    ]);
    const missing = await call(server, 'POST', '/catalogue/cogs/import', {
      csv: 'sku,cogs\nCSV-1,1\n',
      dry_run: true,
    });
    expect(missing.body.errors).toEqual([
      { line: 1, code: 'column_missing', column: 'effective_from' },
    ]);
    await server.close();
  });

  it('[CAT-5] [CAT-6] map, refuse a second SKU, remap by CSV, export; each change raises the mapped event', async () => {
    const server = app();
    const one = String((await call(server, 'POST', '/catalogue/skus', sku('MAP-1'))).body.id);
    const other = String((await call(server, 'POST', '/catalogue/skus', sku('MAP-2'))).body.id);
    await inW((ctx) =>
      new CatalogueRepository(db.db).upsertDiscovered(
        ctx,
        W.account,
        'ebay',
        [
          {
            externalSku: 'EXT-1',
            externalId: '111',
            title: '=cmd|calc',
            fulfilment: null,
            inventoryApi: true,
            quantity: 2,
          },
        ],
        NOW,
      ),
    );
    const queue = await call(server, 'GET', '/catalogue/listings?mapped=false');
    const listing = (queue.body.items as { id: string; external_sku: string }[]).find(
      (l) => l.external_sku === 'EXT-1',
    );
    const listingId = listing?.id ?? '';
    events.length = 0;

    const mapped = await call(server, 'PUT', `/catalogue/listings/${listingId}/mapping`, {
      master_sku_id: one,
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body.master_sku).toEqual({ id: one, sku: 'MAP-1' });
    const twice = await call(server, 'PUT', `/catalogue/listings/${listingId}/mapping`, {
      master_sku_id: other,
    });
    expect(twice.status).toBe(409);
    expect(events).toEqual([{ listingId, masterSkuId: one, previousMasterSkuId: null }]);

    const remap = await call(server, 'POST', '/catalogue/mappings/import', {
      csv: `listing_id,sku\n${listingId},MAP-2\n`,
      dry_run: false,
    });
    expect(remap.body).toMatchObject({ applied: true, errors: [] });
    expect(events[1]).toEqual({ listingId, masterSkuId: other, previousMasterSkuId: one });

    const exported = await server.inject({
      method: 'GET',
      url: '/api/catalogue/mappings/export',
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    // The title cannot run as a formula in a spreadsheet.
    expect(exported.body).toContain(`${listingId},eBay main,ebay,EXT-1,111,'=cmd|calc,MAP-2`);

    const unmapped = await call(server, 'DELETE', `/catalogue/listings/${listingId}/mapping`);
    expect(unmapped.body.master_sku).toBeNull();
    expect(events[2]).toEqual({ listingId, masterSkuId: null, previousMasterSkuId: other });
    await server.close();
  });
});
