import { randomUUID } from 'node:crypto';
import { Notifier, type TenantContext } from '@omnibridge/core';
import {
  AuditLog,
  CatalogueRepository,
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  migrateMain,
  MembershipRepository,
  NotificationRepository,
  OutboundWriteRepository,
  StockEngine,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { sessionHeaders, startRoleCluster, stubAuth, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const APP = 'https://app.omnibridge.test';

/**
 * The T-0901 routes on real PostgreSQL: stock and movements by hand (INV-3), the change log and
 * its export (INV-5), buffers (INV-2) and the version-checked allocation save (INV-10, C7.2).
 */
describe('stock routes (T-0901)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let tenancy: Tenancy;
  const W = { id: randomUUID(), admin: randomUUID(), account: '', sku: '', listing: '' };
  const headers = {
    ...sessionHeaders({ workspaceId: W.id, userId: W.admin, sessionId: `s-${W.admin}` }),
    origin: APP,
  };
  const inW = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: W.id }, fn);
  const engine = () =>
    new StockEngine(db.db, {
      pushes: {
        enqueue: (ctx, input) => new OutboundWriteRepository(db.db).insert(ctx, input, new Date()),
      },
      notifier: new Notifier({ store: new NotificationRepository(db.db) }),
    });
  const app = () =>
    buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      ...stubAuth(),
      stock: {
        engine: engine(),
        catalogue: new CatalogueRepository(db.db),
        audit: new AuditLog(db.db),
      },
    });
  const call = async (
    server: ReturnType<typeof app>,
    method: 'GET' | 'POST' | 'PUT',
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

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    db = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    await tenancy.run({ workspaceId: W.id, companyIds: [], userId: W.admin }, async (ctx) => {
      await new WorkspaceRepository(db.db).create(ctx, { name: 'Stock routes' });
      await new UserRepository(db.db).create(ctx, {
        id: W.admin,
        email: `${W.admin}@example.test`,
        name: 'Admin',
      });
      await new MembershipRepository(db.db).add(ctx, { userId: W.admin, role: 'admin' });
    });
    const company = await inW((c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'Routes Ltd',
        tradingName: 'Routes',
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
    const catalogue = new CatalogueRepository(db.db);
    W.sku = await inW((c) =>
      catalogue.createSku(
        c,
        { sku: 'RT-1', title: 'Route', shortDescription: 'Route', weightG: 1, vatType: 'standard' },
        null,
        new Date(),
      ),
    );
    const found = await inW((c) =>
      catalogue.upsertDiscovered(
        c,
        W.account,
        'ebay',
        [
          {
            externalSku: 'RT-1',
            externalId: 'rt',
            title: null,
            fulfilment: null,
            inventoryApi: true,
            quantity: 0,
          },
        ],
        new Date(),
      ),
    );
    W.listing = found.autoMapped[0]?.listingId ?? '';
  });

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  it('[INV-3] stock-in and adjustment by hand: a resend returns the same movement; other needs text', async () => {
    const server = app();
    const ref = randomUUID();
    const first = await call(server, 'POST', `/stock/${W.sku}/stock-in`, {
      quantity: 12,
      supplier: 'Alder',
      client_ref: ref,
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      kind: 'stock_in',
      on_hand_change: 12,
      on_hand_after: 12,
      // INV-5: the change log names who moved it.
      source: { type: 'user', user_id: W.admin, name: 'Admin' },
    });
    const again = await call(server, 'POST', `/stock/${W.sku}/stock-in`, {
      quantity: 12,
      supplier: 'Alder',
      client_ref: ref,
    });
    expect(again.body.id).toBe(first.body.id);
    const noText = await call(server, 'POST', `/stock/${W.sku}/adjustments`, {
      delta: -1,
      reason: 'other',
      client_ref: randomUUID(),
    });
    expect(noText.status).toBe(409);
    const adjusted = await call(server, 'POST', `/stock/${W.sku}/adjustments`, {
      delta: -2,
      reason: 'damaged',
      client_ref: randomUUID(),
    });
    expect(adjusted.body).toMatchObject({ kind: 'adjust', reason: 'damaged', on_hand_after: 10 });
    const detail = await call(server, 'GET', `/stock/${W.sku}`);
    expect(detail.body).toMatchObject({ on_hand: 10, reserved: 0, available: 10 });
    await server.close();
  });

  it('[INV-10] a stale allocation save answers 409 version_conflict; a fresh one saves and pushes', async () => {
    const server = app();
    const before = await call(server, 'GET', `/stock/${W.sku}`);
    const version = Number(before.body.version);
    await call(server, 'POST', `/stock/${W.sku}/stock-in`, {
      quantity: 1,
      client_ref: randomUUID(),
    });
    const stale = await call(server, 'PUT', `/stock/${W.sku}/allocation`, {
      version,
      listings: [{ listing_id: W.listing, mode: 'manual', manual_qty: 4 }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    const fresh = await call(server, 'GET', `/stock/${W.sku}`);
    const saved = await call(server, 'PUT', `/stock/${W.sku}/allocation`, {
      version: Number(fresh.body.version),
      listings: [{ listing_id: W.listing, mode: 'manual', manual_qty: 4 }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.pushes).toEqual([{ listing_id: W.listing, result: 'queued' }]);
    const back = await call(server, 'POST', `/stock/${W.sku}/allocation/auto`, {});
    expect((back.body.stock as { sync_mode: string }).sync_mode).toBe('auto');
    await server.close();
  });

  it('[INV-2] [INV-5] buffers, the stock-take import and the change log export', async () => {
    const server = app();
    const buffer = await call(server, 'PUT', `/stock/buffers/${W.account}`, { buffer: 3 });
    expect(buffer.body).toMatchObject({ channel_account_id: W.account, buffer: 3 });
    const take = await call(server, 'POST', '/stock/stock-take/import', {
      csv: 'sku,on_hand\nRT-1,40\nNOPE,1\n',
      dry_run: false,
    });
    expect(take.body).toMatchObject({ applied: false, errors: [{ line: 3, code: 'sku_unknown' }] });
    const ok = await call(server, 'POST', '/stock/stock-take/import', {
      csv: 'sku,on_hand\nRT-1,40\n',
      dry_run: false,
    });
    expect(ok.body).toMatchObject({ applied: true, valid: 1 });
    const detail = await call(server, 'GET', `/stock/${W.sku}`);
    const listing = (detail.body.listings as { target: number; buffer: number }[])[0];
    expect(detail.body.on_hand).toBe(40);
    expect(listing).toMatchObject({ buffer: 3, target: 37, channel_account_name: 'eBay main' });
    const log = await call(server, 'GET', `/stock/movements?sku_id=${W.sku}&kind=stock_take`);
    expect(log.body.items).toHaveLength(1);
    const csv = await server.inject({
      method: 'GET',
      url: `/api/stock/movements/export?sku_id=${W.sku}`,
      headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\r\n')[0]).toContain('at_utc,at_london,sku,kind');
    expect(csv.body).toContain(',RT-1,stock_take,');
    // INV-5: a hand movement's source is the person's name.
    expect(csv.body).toMatch(/,RT-1,stock_take,.*,Admin,/);
    await server.close();
  });
});
