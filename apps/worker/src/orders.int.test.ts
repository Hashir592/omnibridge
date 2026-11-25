import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CatalogueRepository,
  createMainDb,
  createQueues,
  JobRecordRepository,
  migrateMain,
  NotificationRepository,
  OrderIngest,
  OrderReads,
  Tenancy,
  type MainDbHandle,
} from '@omnibridge/db';
import { Notifier } from '@omnibridge/core';
import { createLogger } from '@omnibridge/logger';
import { parseEbayOrders } from '@omnibridge/provider-ebay';
import type { ChannelOrder } from '@omnibridge/provider-kit';
import { parseWebsiteOrders } from '@omnibridge/provider-website';
import { JobQueue, JOBS, type PreparingJob } from '@omnibridge/queue';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  scanTextForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import { createWorkerBoss } from './heartbeat.ts';
import {
  orderIngestPorts,
  orderIngestStream,
  ordersOrphanSweepHandler,
  ordersGroupRecomputeHandler,
  ordersPiiExpiryHandler,
  piiDeleteAfter,
} from './orders.ts';

const DAY = 86_400_000;

/**
 * T-1001 vault-first ingest across the PII boundary (ORD-4, DEL-1, FA-10, AT-9): the stream's
 * prepare step against a real pii-vault, then the sink into a real db-main. Buyer details reach
 * the vault only; db-main, the job tables and the logs hold IDs.
 */
describe('order ingest across the PII boundary (T-1001)', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let piiRoot: pg.Pool;
  let vault: TestVault;
  let worker: VaultClient;
  let deletion: VaultClient;
  let web: VaultClient;
  let tenancy: Tenancy;
  let ingest: OrderIngest;
  let notifier: Notifier;
  const sent: { type: string; key: string; payload: unknown }[] = [];
  const logs: string[] = [];
  const logger = createLogger({
    service: 'test',
    version: '0',
    destination: { write: (line: string) => (logs.push(line), true) },
  });
  const ws = randomUUID();
  const company = randomUUID();
  const account = randomUUID();

  const channelOrder = (over: Partial<ChannelOrder> = {}): ChannelOrder => ({
    externalId: `EB-${randomUUID().slice(0, 8)}`,
    updatedAt: new Date(),
    status: 'NOT_STARTED/PAID',
    state: 'awaiting_dispatch',
    placedAt: new Date(Date.now() - 60_000),
    paidAt: new Date(Date.now() - 60_000),
    shipBy: null,
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    discountPence: 0,
    shippingPence: 300,
    shipToCountry: 'GB',
    fba: false,
    totalPence: null,
    lines: [{ lineId: 'L1', sku: 'MOCK-SKU-1', quantity: 1, title: 'Mock', linePricePence: 1200 }],
    refunds: [],
    buyer: {
      name: `${PII_MARKER}Ada Buyer`,
      address_line1: `${PII_MARKER}1 Marker Lane`,
      city: 'Testville',
      postcode: 'TE1 1ST',
      country: 'GB',
      email: `${PII_MARKER}ada@example.test`,
      channel_username: `${PII_MARKER}ada-${randomUUID().slice(0, 8)}`,
    },
    ...over,
  });
  const job = { workspaceId: ws, channelAccountId: account };
  const stream = () => orderIngestStream({ tenancy, ingest, vault: worker, logger });
  /** One poll: vault first with no transaction open, then the sink in one transaction. */
  const poll = async (items: ChannelOrder[]) => {
    const s = stream();
    const ready = (await s.prepare?.(job, items)) ?? items;
    await tenancy.runWorkspace({ workspaceId: ws }, (c) => s.sink(c, account, ready));
    return ready;
  };
  const vaultRows = async (subject: string) =>
    (
      await piiRoot.query<{ pii_ref: string; delete_after: Date }>(
        'SELECT pii_ref, delete_after FROM vault.records WHERE workspace_id = $1 AND subject_id = $2',
        [ws, subject],
      )
    ).rows;
  const orderRow = async (externalId: string) =>
    (
      await root.query<{ id: string; pii_ref: string | null; pii_deleted_at: Date | null }>(
        'SELECT id, pii_ref, pii_deleted_at FROM app.orders WHERE external_order_id = $1',
        [externalId],
      )
    ).rows[0];
  const preparing = <T>(type: string, payload: T): PreparingJob<T> => ({
    jobId: randomUUID(),
    envelope: { workspace_id: ws, idempotency_key: randomUUID(), attempt: 1, type, payload },
    payload,
    attempt: 1,
    progress: () => Promise.resolve(),
  });

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_worker']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    await createQueues(main.connection('ob_owner'), JOBS);
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
      journalDir: mkdtempSync(join(tmpdir(), 'ob-journal-')),
    });
    worker = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.worker });
    deletion = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.deletion });
    web = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.web });
    db = createMainDb({ ...main.connection('ob_app'), max: 4 });
    root = new pg.Pool({ connectionString: main.container.getConnectionUri(), max: 2 });
    piiRoot = new pg.Pool({ connectionString: pii.container.getConnectionUri(), max: 2 });
    tenancy = new Tenancy(db.db);
    notifier = new Notifier({ store: new NotificationRepository(db.db) });
    // The cluster superuser seeds the tenant rows (it is not subject to row-level security).
    await root.query(`INSERT INTO app.workspaces (id, name) VALUES ($1, 'Orders')`, [ws]);
    await root.query(
      `INSERT INTO app.companies (id, workspace_id, legal_name, trading_name, address_line1,
                                  address_city, address_postcode)
       VALUES ($1, $2, 'Orders Ltd', 'Orders', '1 Test Street', 'Testville', 'TE1 1ST')`,
      [company, ws],
    );
    await root.query(
      `INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
       VALUES ($1, $2, $3, 'ebay', 'eBay')`,
      [account, ws, company],
    );
    ingest = new OrderIngest(db.db, {
      catalogue: new CatalogueRepository(db.db),
      ports: orderIngestPorts(
        {
          send: (def, input) => {
            sent.push({ type: def.type, key: input.idempotencyKey, payload: input.payload });
            return Promise.resolve({ id: randomUUID(), created: true });
          },
        },
        { notifier, logger },
      ),
    });
  }, 300_000);

  afterAll(async () => {
    await vault.close();
    await db.destroy();
    await root.end();
    await piiRoot.end();
    await Promise.all([main.container.stop(), pii.container.stop()]);
  }, 120_000);

  it('[ORD-4][AT-9] vault first: one buyer record per order, db-main keeps the ref only', async () => {
    const o = channelOrder();
    const ready = await poll([o]);
    expect(ready[0]?.buyer).toBeNull();
    expect(ready[0]?.pii).toMatchObject({ kind: 'stored' });
    // A replayed page and a retried job add no second buyer record (ADR-079 3).
    await poll([o]);
    await poll([{ ...o, updatedAt: new Date() }]);
    const records = await vaultRows(`${account}:${o.externalId}`);
    expect(records).toHaveLength(1);
    const row = await orderRow(o.externalId);
    expect(row?.pii_ref).toBe(records[0]?.pii_ref);
    // Not yet dispatched: the 90-day backstop from placement (PRD 7.3).
    expect(records[0]?.delete_after.getTime()).toBe(o.placedAt.getTime() + 90 * DAY);
    const masked = await web.mask(ws, [row?.pii_ref ?? '']);
    expect(masked.records[0]?.fields.name).toBe('P. B***');
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
  });

  it('[ORD-4] a pending order first seen without an address gets its buyer record once the channel sends one', async () => {
    const o = channelOrder({ state: 'pending_payment', paidAt: null, buyer: null });
    await poll([o]);
    expect(await orderRow(o.externalId)).toMatchObject({ pii_ref: null });
    await poll([
      { ...channelOrder(), externalId: o.externalId, updatedAt: new Date(Date.now() + 1000) },
    ]);
    const [record] = await vaultRows(`${account}:${o.externalId}`);
    expect(record).toBeDefined();
    expect((await orderRow(o.externalId))?.pii_ref).toBe(record?.pii_ref);
  });

  /** A website order as its API sends it, with markers on every buyer field. */
  const websiteOrders = (...over: Record<string, unknown>[]) =>
    parseWebsiteOrders({
      orders: over.map((o) => ({
        id: `WEB-${randomUUID().slice(0, 8)}`,
        created_at: new Date(Date.now() - 2 * DAY).toISOString(),
        updated_at: new Date(Date.now() - DAY).toISOString(),
        paid_at: new Date(Date.now() - 2 * DAY).toISOString(),
        status: 'processing',
        currency: 'GBP',
        shipping_total: '3.00',
        customer: { id: `${PII_MARKER}cust`, email: `${PII_MARKER}web@example.test` },
        shipping_address: {
          name: `${PII_MARKER}Web Buyer`,
          line1: `${PII_MARKER}2 Road`,
          city: 'Testville',
          postcode: 'TE2 2ND',
          country: 'GB',
          instructions: `${PII_MARKER}leave by the gate`,
        },
        // Fields no parser asked for: they must go nowhere.
        billing_address: { line1: `${PII_MARKER}billing` },
        notes: `${PII_MARKER}notes`,
        lines: [{ id: 'L1', sku: 'MOCK-SKU-1', quantity: 1, total: '12.00' }],
        ...o,
      })),
      next_cursor: null,
    });
  /** An eBay order as getOrders sends it, with markers on every buyer field. */
  const ebayOrders = (...over: Record<string, unknown>[]) => {
    const gbp = (value: string) => ({ value, currency: 'GBP' });
    return parseEbayOrders({
      offset: 0,
      limit: 50,
      orders: over.map((o) => ({
        orderId: `EBP-${randomUUID().slice(0, 8)}`,
        creationDate: new Date(Date.now() - 2 * DAY).toISOString(),
        lastModifiedDate: new Date(Date.now() - DAY).toISOString(),
        orderFulfillmentStatus: 'NOT_STARTED',
        orderPaymentStatus: 'PAID',
        buyer: {
          username: `${PII_MARKER}user-${randomUUID().slice(0, 8)}`,
          taxAddress: { postalCode: `${PII_MARKER}tax` },
        },
        buyerCheckoutNotes: `${PII_MARKER}checkout note`,
        pricingSummary: { deliveryCost: gbp('3.00'), total: gbp('15.00') },
        lineItems: [{ lineItemId: 'L1', sku: 'S-1', quantity: 1, lineItemCost: gbp('12.00') }],
        ...o,
      })),
    });
  };
  const shipTo = (address: Record<string, unknown> | undefined) => ({
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shipTo: { fullName: `${PII_MARKER}Eve Bay`, contactAddress: address },
        },
      },
    ],
  });
  const fullAddress = {
    addressLine1: `${PII_MARKER}3 Auction Way`,
    city: 'Testville',
    postalCode: 'TE3 3RD',
    countryCode: 'GB',
  };
  const fieldsOf = async (subject: string) =>
    (
      await piiRoot.query<{ field: string }>(
        `SELECT f.field FROM vault.record_fields f
           JOIN vault.records r ON r.workspace_id = f.workspace_id AND r.pii_ref = f.pii_ref
          WHERE r.workspace_id = $1 AND r.subject_id = $2 ORDER BY f.field`,
        [ws, subject],
      )
    ).rows.map((r) => r.field);

  it('[DEL-1][AT-8] a website order first seen shipped with no ship date counts from its placement', async () => {
    const updated = new Date(Date.now() - 5 * DAY);
    const created = new Date(Date.now() - 10 * DAY);
    const [recent, old] = websiteOrders(
      {
        status: 'shipped',
        created_at: created.toISOString(),
        updated_at: updated.toISOString(),
      },
      {
        status: 'completed',
        created_at: new Date(Date.now() - 40 * DAY).toISOString(),
        updated_at: new Date(Date.now() - 38 * DAY).toISOString(),
      },
    );
    if (recent === undefined || old === undefined) throw new Error('no orders');
    await poll([recent, old]);
    const [record] = await vaultRows(`${account}:${recent.externalId}`);
    expect(record?.delete_after.getTime()).toBe(created.getTime() + 25 * DAY);
    // Past its window already: stored with no record at all (FA-16).
    expect(await vaultRows(`${account}:${old.externalId}`)).toEqual([]);
    expect(await orderRow(old.externalId)).toMatchObject({ pii_ref: null });
  });

  it('[DEL-1][AT-8] a later update of an order past its window never stores its buyer again', async () => {
    const created = new Date(Date.now() - 40 * DAY).toISOString();
    const seen = new Date(Date.now() - 38 * DAY).toISOString();
    const [web] = websiteOrders({ status: 'completed', created_at: created, updated_at: seen });
    const fulfilled = { orderFulfillmentStatus: 'FULFILLED', ...shipTo(fullAddress) };
    const [ebay] = ebayOrders({ creationDate: created, lastModifiedDate: seen, ...fulfilled });
    if (web === undefined || ebay === undefined) throw new Error('no orders');
    await poll([web, ebay]);
    // A late refund or feedback: the channel sends the order again with today's update time.
    const now = new Date();
    await poll([
      { ...web, updatedAt: now },
      { ...ebay, updatedAt: now, dispatchedAt: now },
    ]);
    for (const o of [web, ebay]) {
      expect(await vaultRows(`${account}:${o.externalId}`)).toEqual([]);
      expect(await orderRow(o.externalId)).toMatchObject({ pii_ref: null });
    }
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
  const expiryJob = async (externalId: string) => {
    const id = (await orderRow(externalId))?.id ?? '';
    await ordersPiiExpiryHandler({ tenancy, ingest, vault: worker }).prepare(
      preparing('orders.pii_expiry', { order_id: id, reason: 'dispatch' as const }),
    );
    return (await vaultRows(`${account}:${externalId}`))[0]?.delete_after;
  };

  it('[DEL-1][AT-8] an order first seen shipped and edited late never keeps its buyer past placement + 90 days', async () => {
    const edited = daysAgo(1).toISOString();
    const [ebay] = ebayOrders({
      creationDate: daysAgo(89).toISOString(),
      lastModifiedDate: edited,
      orderFulfillmentStatus: 'FULFILLED',
      ...shipTo(fullAddress),
    });
    const [web] = websiteOrders({
      status: 'shipped',
      created_at: daysAgo(89).toISOString(),
      updated_at: edited,
    });
    if (ebay === undefined || web === undefined) throw new Error('no orders');
    await poll([ebay, web]);
    // No real dispatch time and no ship-by: placement + 25 days, long past. Nothing is stored.
    for (const o of [ebay, web]) {
      expect(await vaultRows(`${account}:${o.externalId}`)).toEqual([]);
      expect(await orderRow(o.externalId)).toMatchObject({ pii_ref: null });
    }
  });

  it('[DEL-1][AT-8] an order first seen shipped counts from its ship-by date when that is earlier than the edit', async () => {
    const by = daysAgo(15);
    const [o] = ebayOrders({
      creationDate: daysAgo(20).toISOString(),
      lastModifiedDate: daysAgo(1).toISOString(),
      orderFulfillmentStatus: 'FULFILLED',
      lineItems: [
        {
          lineItemId: 'L1',
          sku: 'S-1',
          quantity: 1,
          lineItemCost: { value: '12.00', currency: 'GBP' },
          lineItemFulfillmentInstructions: { shipByDate: by.toISOString() },
        },
      ],
      ...shipTo(fullAddress),
    });
    if (o === undefined) throw new Error('no order');
    await poll([o]);
    const [record] = await vaultRows(`${account}:${o.externalId}`);
    expect(record?.delete_after.getTime()).toBe(by.getTime() + 25 * DAY);
    expect((await expiryJob(o.externalId))?.getTime()).toBe(by.getTime() + 25 * DAY);
  });

  it('[DEL-1][AT-8] a stored order first shown shipped late is never kept past placement + 90 days', async () => {
    const placed = daysAgo(80);
    const base = { creationDate: placed.toISOString(), ...shipTo(fullAddress) };
    const [waiting] = ebayOrders({ ...base, lastModifiedDate: daysAgo(79).toISOString() });
    if (waiting === undefined) throw new Error('no order');
    await poll([waiting]);
    const cap = placed.getTime() + 90 * DAY;
    const [before] = await vaultRows(`${account}:${waiting.externalId}`);
    expect(before?.delete_after.getTime()).toBe(cap);
    const [shipped] = ebayOrders({
      ...base,
      orderId: waiting.externalId,
      orderFulfillmentStatus: 'FULFILLED',
      lastModifiedDate: daysAgo(0).toISOString(),
    });
    if (shipped === undefined) throw new Error('no order');
    await poll([shipped]);
    expect((await expiryJob(waiting.externalId))?.getTime()).toBe(cap);
    // Shipped early, the same update is its dispatch: 25 days from it.
    const shown = daysAgo(3);
    const [early] = ebayOrders({ ...shipTo(fullAddress), creationDate: daysAgo(9).toISOString() });
    if (early === undefined) throw new Error('no order');
    await poll([early]);
    const [gone] = ebayOrders({
      ...shipTo(fullAddress),
      orderId: early.externalId,
      creationDate: daysAgo(9).toISOString(),
      orderFulfillmentStatus: 'FULFILLED',
      lastModifiedDate: shown.toISOString(),
    });
    if (gone === undefined) throw new Error('no order');
    await poll([{ ...gone, updatedAt: shown }]);
    expect((await expiryJob(early.externalId))?.getTime()).toBe(shown.getTime() + 25 * DAY);
  });

  it('[DEL-1][ORD-4] an order seen unpaid first, then shipped, counts from the update that shows it shipped', async () => {
    const base = { creationDate: daysAgo(40).toISOString() };
    const [unpaid] = ebayOrders({ ...base, orderPaymentStatus: 'PENDING', ...shipTo(fullAddress) });
    if (unpaid === undefined) throw new Error('no order');
    await poll([unpaid]);
    const shown = daysAgo(1);
    const [shipped] = ebayOrders({
      ...base,
      orderId: unpaid.externalId,
      orderFulfillmentStatus: 'FULFILLED',
      lastModifiedDate: shown.toISOString(),
      ...shipTo(fullAddress),
    });
    if (shipped === undefined) throw new Error('no order');
    await poll([shipped]);
    const [record] = await vaultRows(`${account}:${unpaid.externalId}`);
    expect(record?.delete_after.getTime()).toBe(shown.getTime() + 25 * DAY);
  });

  it('[ORD-4] an address with no country counts as a UK one: without a postcode it is not whole', async () => {
    const [o] = ebayOrders({
      ...shipTo({ addressLine1: `${PII_MARKER}1 Nowhere`, city: 'Testville' }),
    });
    if (o === undefined) throw new Error('no order');
    await poll([o]);
    expect(await vaultRows(`${account}:${o.externalId}`)).toEqual([]);
  });

  it('[DEL-1][AT-8] a real but late dispatch or delivery is still capped at placement + 90 days', async () => {
    const placed = daysAgo(80);
    const [o] = websiteOrders({
      status: 'shipped',
      created_at: placed.toISOString(),
      shipped_at: daysAgo(1).toISOString(),
    });
    if (o === undefined) throw new Error('no order');
    await poll([o]);
    const cap = placed.getTime() + 90 * DAY;
    const [record] = await vaultRows(`${account}:${o.externalId}`);
    expect(record?.delete_after.getTime()).toBe(cap);
    await poll([{ ...o, state: 'delivered', deliveredAt: new Date(), updatedAt: new Date() }]);
    expect((await expiryJob(o.externalId))?.getTime()).toBe(cap);
  });

  /** A website order first stored waiting, then shown shipped with no ship date. */
  const shownShipped = async (placed: Date, shown: Date) => {
    const base = { created_at: placed.toISOString(), paid_at: placed.toISOString() };
    const [waiting] = websiteOrders({ ...base, updated_at: placed.toISOString() });
    if (waiting === undefined) throw new Error('no order');
    await poll([waiting]);
    const update = async (over: Record<string, unknown>) => {
      const [next] = websiteOrders({ ...base, id: waiting.externalId, status: 'shipped', ...over });
      if (next === undefined) throw new Error('no order');
      sent.length = 0;
      await poll([next]);
      const id = (await orderRow(waiting.externalId))?.id;
      return sent
        .filter((s) => s.type === 'orders.pii_expiry')
        .filter((s) => (s.payload as { order_id: string }).order_id === id)
        .map((s) => s.key);
    };
    const keys = await update({ updated_at: shown.toISOString() });
    return { id: waiting.externalId, update, keys };
  };

  it('[DEL-1][AT-8] a real dispatch date after a stand-in works the deletion date out again', async () => {
    const placed = daysAgo(20);
    const { id, update, keys } = await shownShipped(placed, daysAgo(1));
    expect((await expiryJob(id))?.getTime()).toBeGreaterThan(Date.now() + 23 * DAY);
    const shipped = daysAgo(18);
    const again = await update({
      updated_at: daysAgo(0).toISOString(),
      shipped_at: shipped.toISOString(),
    });
    // Its own job: the first one's key is taken.
    expect(again).toHaveLength(1);
    expect(keys).toHaveLength(1);
    expect(again).not.toEqual(keys);
    expect((await expiryJob(id))?.getTime()).toBe(shipped.getTime() + 25 * DAY);
    // A second real date queues nothing and changes nothing.
    const second = await update({
      updated_at: new Date(Date.now() + 1000).toISOString(),
      shipped_at: daysAgo(2).toISOString(),
    });
    expect(second).toEqual([]);
    expect((await expiryJob(id))?.getTime()).toBe(shipped.getTime() + 25 * DAY);
  });

  it('[DEL-1][AT-8] a later real dispatch date follows the window, never past placement + 90 days', async () => {
    const placed = daysAgo(80);
    const near = await shownShipped(daysAgo(30), daysAgo(20));
    expect((await expiryJob(near.id))?.getTime()).toBeLessThan(Date.now() + 6 * DAY);
    const late = daysAgo(10);
    await near.update({ updated_at: daysAgo(0).toISOString(), shipped_at: late.toISOString() });
    expect((await expiryJob(near.id))?.getTime()).toBe(late.getTime() + 25 * DAY);
    const far = await shownShipped(placed, daysAgo(60));
    await far.update({
      updated_at: daysAgo(0).toISOString(),
      shipped_at: daysAgo(1).toISOString(),
    });
    expect((await expiryJob(far.id))?.getTime()).toBe(placed.getTime() + 90 * DAY);
  });

  it('[DEL-1] a real dispatch date never brings back a deleted record, or one never kept', async () => {
    const { id, update } = await shownShipped(daysAgo(20), daysAgo(1));
    const ref = (await orderRow(id))?.pii_ref ?? '';
    await deletion.delete({
      workspace_id: ws,
      run_id: randomUUID(),
      trigger: 'erasure',
      scope: { type: 'refs', pii_refs: [ref] },
    });
    await root.query('UPDATE app.orders SET pii_deleted_at = now() WHERE pii_ref = $1', [ref]);
    await update({ updated_at: daysAgo(0).toISOString(), shipped_at: daysAgo(3).toISOString() });
    expect(await vaultRows(`${account}:${id}`)).toEqual([]);
    expect(await expiryJob(id)).toBeUndefined();
    // First seen shipped, past its window by the stand-in: a later real date does not restart it.
    const created = daysAgo(60).toISOString();
    const [old] = websiteOrders({
      status: 'shipped',
      created_at: created,
      updated_at: daysAgo(50).toISOString(),
    });
    if (old === undefined) throw new Error('no order');
    await poll([old]);
    const [real] = websiteOrders({
      id: old.externalId,
      status: 'shipped',
      created_at: created,
      updated_at: daysAgo(0).toISOString(),
      shipped_at: daysAgo(2).toISOString(),
    });
    if (real === undefined) throw new Error('no order');
    await poll([real]);
    expect(await vaultRows(`${account}:${old.externalId}`)).toEqual([]);
  });

  const fullRead = async (externalId: string) =>
    (
      await web.readFull({
        workspaceId: ws,
        piiRef: (await orderRow(externalId))?.pii_ref ?? '',
        purpose: 'order_detail',
        actorUserId: randomUUID(),
      })
    ).fields;

  it('[ORD-4] an address the channel corrects before dispatch reaches the one record, and groups are worked out again', async () => {
    const username = `${PII_MARKER}fix-${randomUUID().slice(0, 8)}`;
    const [first] = ebayOrders({ ...shipTo(fullAddress), buyer: { username } });
    const [site] = websiteOrders({});
    if (first === undefined || site === undefined) throw new Error('no orders');
    await poll([first, site]);
    const before = {
      ebay: (await vaultRows(`${account}:${first.externalId}`))[0],
      site: (await vaultRows(`${account}:${site.externalId}`))[0],
    };
    sent.length = 0;
    const [fixed] = ebayOrders({
      orderId: first.externalId,
      lastModifiedDate: new Date().toISOString(),
      buyer: { username },
      ...shipTo({ ...fullAddress, addressLine1: `${PII_MARKER}4 Corrected Way` }),
    });
    const [fixedSite] = websiteOrders({
      id: site.externalId,
      updated_at: new Date().toISOString(),
      shipping_address: {
        name: `${PII_MARKER}Web Buyer`,
        line1: `${PII_MARKER}8 Moved Road`,
        city: 'Testville',
        postcode: 'TE8 8TH',
        country: 'GB',
      },
    });
    if (fixed === undefined || fixedSite === undefined) throw new Error('no orders');
    const ready = await poll([fixed, fixedSite]);
    expect(ready.map((o) => [o.buyer, o.pii?.kind])).toEqual([
      [null, 'replaced'],
      [null, 'replaced'],
    ]);
    expect(await fullRead(first.externalId)).toMatchObject({
      address_line1: `${PII_MARKER}4 Corrected Way`,
      postcode: 'TE3 3RD',
      channel_username: username,
    });
    const siteFields = await fullRead(site.externalId);
    expect(siteFields).toMatchObject({
      address_line1: `${PII_MARKER}8 Moved Road`,
      email: `${PII_MARKER}web@example.test`,
    });
    expect(siteFields.delivery_instructions).toBeUndefined();
    // One record each, the same ref and the same date.
    expect(await vaultRows(`${account}:${first.externalId}`)).toEqual([before.ebay]);
    expect(await vaultRows(`${account}:${site.externalId}`)).toEqual([before.site]);
    expect(sent.some((s) => s.type === 'orders.group_recompute')).toBe(true);
    // The same page again asks for nothing new.
    expect((await poll([fixed])).map((o) => o.pii?.kind)).toEqual(['unchanged']);
    expect(JSON.stringify(sent)).not.toContain(PII_MARKER);
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
  });

  it('[ORD-4][DEL-1] a later address changes nothing once the order has shipped or is cancelled, or when it is no whole address', async () => {
    const moved = { ...fullAddress, addressLine1: `${PII_MARKER}66 Too Late` };
    const make = async () => {
      const [o] = ebayOrders({ ...shipTo(fullAddress) });
      if (o === undefined) throw new Error('no order');
      await poll([o]);
      return o;
    };
    const again = async (id: string, over: Record<string, unknown>) => {
      const [o] = ebayOrders({
        orderId: id,
        lastModifiedDate: new Date().toISOString(),
        ...shipTo(moved),
        ...over,
      });
      if (o === undefined) throw new Error('no order');
      const [ready] = await poll([o]);
      return ready?.pii?.kind;
    };
    const kept = `${PII_MARKER}3 Auction Way`;
    const shipped = await make();
    expect(await again(shipped.externalId, { orderFulfillmentStatus: 'FULFILLED' })).toBe(
      'unchanged',
    );
    // Shown unshipped again by a late page: db-main knows it shipped.
    expect(await again(shipped.externalId, {})).toBe('unchanged');
    expect((await fullRead(shipped.externalId)).address_line1).toBe(kept);
    const cancelled = await make();
    expect(await again(cancelled.externalId, { cancelStatus: { cancelState: 'CANCELED' } })).toBe(
      'unchanged',
    );
    expect(await again(cancelled.externalId, {})).toBe('unchanged');
    expect((await fullRead(cancelled.externalId)).address_line1).toBe(kept);
    const unpaid = await make();
    expect(await again(unpaid.externalId, { orderPaymentStatus: 'PENDING' })).toBe('unchanged');
    const partial = await make();
    expect(
      await again(partial.externalId, shipTo({ countryCode: 'GB', postalCode: 'TE9 9TH' })),
    ).toBe('unchanged');
    const masked = await make();
    expect(
      await again(masked.externalId, shipTo({ ...fullAddress, addressLine1: '6* ******' })),
    ).toBe('unchanged');
    for (const o of [unpaid, partial, masked]) {
      expect((await fullRead(o.externalId)).address_line1).toBe(kept);
    }
    // An older copy of the order arriving late.
    const stale = await make();
    expect(await again(stale.externalId, { lastModifiedDate: daysAgo(1.5).toISOString() })).toBe(
      'unchanged',
    );
    expect((await fullRead(stale.externalId)).address_line1).toBe(kept);
  });

  it('[ORD-4] a correction that comes after a failed first store is not lost', async () => {
    const username = () => `${PII_MARKER}lost-${randomUUID().slice(0, 8)}`;
    for (const swept of [false, true]) {
      const buyer = { username: username() };
      const [first] = ebayOrders({ ...shipTo(fullAddress), buyer });
      if (first === undefined) throw new Error('no order');
      // The vault write happened, the db-main write did not.
      const [ready] = (await stream().prepare?.(job, [first])) ?? [];
      const piiRef = ready?.pii?.kind === 'stored' ? ready.pii.piiRef : '';
      if (swept) {
        await worker.setExpiry({
          workspace_id: ws,
          pii_refs: [piiRef],
          delete_after: new Date(Date.now() - 1000).toISOString(),
          reason: 'orphan',
        });
      }
      const [fixed] = ebayOrders({
        orderId: first.externalId,
        creationDate: first.placedAt.toISOString(),
        lastModifiedDate: new Date().toISOString(),
        buyer,
        ...shipTo({ ...fullAddress, addressLine1: `${PII_MARKER}4 Corrected Way` }),
      });
      if (fixed === undefined) throw new Error('no order');
      await poll([fixed]);
      expect((await orderRow(first.externalId))?.pii_ref).toBe(piiRef);
      expect((await fullRead(first.externalId)).address_line1).toBe(`${PII_MARKER}4 Corrected Way`);
      const [record] = await vaultRows(`${account}:${first.externalId}`);
      expect(record?.delete_after.getTime()).toBe(first.placedAt.getTime() + 90 * DAY);
    }
  });

  it('[ORD-4] a masked email, phone or second address line never overwrites the real one', async () => {
    const real = {
      email: `${PII_MARKER}eve@example.test`,
      primaryPhone: { phoneNumber: '+447700900321' },
    };
    const to = (contactAddress: Record<string, unknown>, rest: Record<string, unknown>) => ({
      fulfillmentStartInstructions: [
        {
          shippingStep: { shipTo: { fullName: `${PII_MARKER}Eve Bay`, contactAddress, ...rest } },
        },
      ],
    });
    const [first] = ebayOrders({ ...to({ ...fullAddress, addressLine2: 'Flat 9' }, real) });
    if (first === undefined) throw new Error('no order');
    await poll([first]);
    const again = async (o: Record<string, unknown>, at: number) => {
      const [next] = ebayOrders({
        orderId: first.externalId,
        lastModifiedDate: new Date(Date.now() - at).toISOString(),
        ...o,
      });
      if (next === undefined) throw new Error('no order');
      return (await poll([next]))[0]?.pii?.kind;
    };
    const masked = { email: 'j***@e***', primaryPhone: { phoneNumber: '*****123' } };
    expect(await again(to({ ...fullAddress, addressLine2: 'F***' }, real), 3000)).toBe('unchanged');
    expect((await fullRead(first.externalId)).address_line2).toBe('Flat 9');
    const moved = { ...fullAddress, addressLine1: `${PII_MARKER}5 Next Way` };
    expect(await again(to(moved, masked), 1000)).toBe('replaced');
    expect(await fullRead(first.externalId)).toMatchObject({
      address_line1: `${PII_MARKER}5 Next Way`,
      email: real.email,
      phone: real.primaryPhone.phoneNumber,
    });
  });

  it('[AT-10][ORD-4] an eBay deletion never refuses a website buyer with the same ID', async () => {
    const customer = `${PII_MARKER}shared-${randomUUID().slice(0, 8)}`;
    await web.ebayUserMatch({ user_id: customer });
    const site = randomUUID();
    await root.query(
      `INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
       VALUES ($1, $2, $3, 'website', 'Site')`,
      [site, ws, company],
    );
    const [o] = websiteOrders({ customer: { id: customer } });
    if (o === undefined) throw new Error('no order');
    const ready = await stream().prepare?.({ workspaceId: ws, channelAccountId: site }, [o]);
    expect(ready?.[0]?.pii).toMatchObject({ kind: 'stored' });
    await tenancy.runWorkspace({ workspaceId: ws }, (c) => stream().sink(c, site, ready ?? []));
    const same = await stream().prepare?.(job, [{ ...o, externalId: `${o.externalId}-e` }]);
    expect(same?.[0]?.pii).toEqual({ kind: 'refused' });
  });

  it('[AT-10][ORD-4] a correction refused for a deleted buyer leaves the order as it is, and the poll goes on', async () => {
    const username = `${PII_MARKER}refused-${randomUUID().slice(0, 8)}`;
    const [first, other] = ebayOrders(
      { ...shipTo(fullAddress), buyer: { username } },
      { ...shipTo(fullAddress) },
    );
    if (first === undefined || other === undefined) throw new Error('no orders');
    await poll([first]);
    await web.ebayUserMatch({ user_id: username });
    const [fixed] = ebayOrders({
      orderId: first.externalId,
      lastModifiedDate: new Date().toISOString(),
      buyer: { username },
      ...shipTo({ ...fullAddress, addressLine1: `${PII_MARKER}9 Not Kept` }),
    });
    if (fixed === undefined) throw new Error('no order');
    const ready = await poll([fixed, other]);
    expect(ready.map((o) => o.pii?.kind)).toEqual(['unchanged', 'stored']);
    expect((await fullRead(first.externalId)).address_line1).toBe(`${PII_MARKER}3 Auction Way`);
  });

  it('[AT-10][ORD-4] a website buyer with a deleted eBay ID has a corrected address applied', async () => {
    const customer = `${PII_MARKER}site-${randomUUID().slice(0, 8)}`;
    await web.ebayUserMatch({ user_id: customer });
    const site = randomUUID();
    await root.query(
      `INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
       VALUES ($1, $2, $3, 'website', 'Site 2')`,
      [site, ws, company],
    );
    const siteJob = { workspaceId: ws, channelAccountId: site };
    const [first] = websiteOrders({ customer: { id: customer } });
    if (first === undefined) throw new Error('no order');
    const ready = (await stream().prepare?.(siteJob, [first])) ?? [];
    await tenancy.runWorkspace({ workspaceId: ws }, (c) => stream().sink(c, site, ready));
    const [fixed] = websiteOrders({
      id: first.externalId,
      updated_at: new Date().toISOString(),
      customer: { id: customer },
      shipping_address: {
        name: `${PII_MARKER}Web Buyer`,
        line1: `${PII_MARKER}10 Moved Road`,
        city: 'Testville',
        postcode: 'TE2 2ND',
        country: 'GB',
      },
    });
    if (fixed === undefined) throw new Error('no order');
    expect((await stream().prepare?.(siteJob, [fixed]))?.[0]?.pii).toEqual({ kind: 'replaced' });
    expect((await fullRead(first.externalId)).address_line1).toBe(`${PII_MARKER}10 Moved Road`);
  });

  it('[DEL-1] a record written before the order shipped is corrected when the order is first stored shipped', async () => {
    const [waiting] = websiteOrders({});
    if (waiting === undefined) throw new Error('no order');
    // The vault write happened, the db-main write did not; the next poll finds the order shipped.
    await stream().prepare?.(job, [waiting]);
    await poll([{ ...waiting, state: 'dispatched', updatedAt: new Date(Date.now() - DAY) }]);
    const id = (await orderRow(waiting.externalId))?.id;
    expect(sent.filter((s) => s.type === 'orders.pii_expiry').map((s) => s.payload)).toContainEqual(
      { order_id: id, reason: 'dispatch' },
    );
  });

  it('[DEL-1] a dispatch or delivery date in the future never keeps a record longer than one of today', async () => {
    const future = new Date(Date.now() + 50 * DAY);
    const o = channelOrder({ state: 'delivered', dispatchedAt: future, deliveredAt: future });
    await poll([o]);
    const limit = Date.now() + 25 * DAY;
    const [stored] = await vaultRows(`${account}:${o.externalId}`);
    expect(stored?.delete_after.getTime()).toBeLessThanOrEqual(limit);
    const id = (await orderRow(o.externalId))?.id ?? '';
    await ordersPiiExpiryHandler({ tenancy, ingest, vault: worker }).prepare(
      preparing('orders.pii_expiry', { order_id: id, reason: 'delivery' as const }),
    );
    const [moved] = await vaultRows(`${account}:${o.externalId}`);
    expect(moved?.delete_after.getTime()).toBeLessThanOrEqual(Date.now() + 25 * DAY);
  });

  it('[ORD-4][DP-5] an unpaid order sends nothing to the vault; once paid, the whole address is stored', async () => {
    const [pending] = ebayOrders({ orderPaymentStatus: 'PENDING', ...shipTo(undefined) });
    const [pendingWeb] = websiteOrders({ status: 'pending', paid_at: null });
    if (pending === undefined || pendingWeb === undefined) throw new Error('no orders');
    await poll([pending, pendingWeb]);
    const subject = `${account}:${pending.externalId}`;
    expect(await vaultRows(subject)).toEqual([]);
    expect(await vaultRows(`${account}:${pendingWeb.externalId}`)).toEqual([]);
    const [paid] = ebayOrders({
      orderId: pending.externalId,
      lastModifiedDate: new Date().toISOString(),
      ...shipTo(fullAddress),
    });
    if (paid === undefined) throw new Error('no order');
    await poll([paid]);
    expect(await fieldsOf(subject)).toEqual(
      expect.arrayContaining(['address_line1', 'channel_username', 'name', 'postcode']),
    );
    expect((await orderRow(pending.externalId))?.pii_ref).toBe(
      (await vaultRows(subject))[0]?.pii_ref,
    );
  });

  it('[ORD-4] a paid order with no delivery address yet is not settled: it is stored once the address comes', async () => {
    const [bare] = ebayOrders({ ...shipTo({ countryCode: 'GB', postalCode: 'TE3 3RD' }) });
    if (bare === undefined) throw new Error('no order');
    await poll([bare]);
    const subject = `${account}:${bare.externalId}`;
    expect(await vaultRows(subject)).toEqual([]);
    const [whole] = ebayOrders({
      orderId: bare.externalId,
      lastModifiedDate: new Date().toISOString(),
      ...shipTo(fullAddress),
    });
    if (whole === undefined) throw new Error('no order');
    await poll([whole]);
    expect(await fieldsOf(subject)).toContain('address_line1');
  });

  it('[ORD-4] a delivery address abroad with no postcode is still an address', async () => {
    const [abroad] = ebayOrders({
      ...shipTo({ addressLine1: `${PII_MARKER}9 Harbour`, city: 'Hong Kong', countryCode: 'HK' }),
    });
    if (abroad === undefined) throw new Error('no order');
    await poll([abroad]);
    expect(await fieldsOf(`${account}:${abroad.externalId}`)).toContain('address_line1');
  });

  it('[ORD-4][AT-9] whole channel payloads through a real queue leave no buyer value outside the vault', async () => {
    const boss = createWorkerBoss(main.connection('ob_worker'), { monitorIntervalSeconds: 1 });
    boss.on('error', () => undefined);
    await boss.start();
    const records = new JobRecordRepository(db.db);
    const queue = new JobQueue({ boss, records, tenancy, logger });
    const real = new OrderIngest(db.db, {
      catalogue: new CatalogueRepository(db.db),
      ports: orderIngestPorts(queue, { notifier, logger }),
    });
    const s = orderIngestStream({ tenancy, ingest: real, vault: worker, logger });
    const pollReal = async (items: ChannelOrder[]) => {
      const ready = (await s.prepare?.(job, items)) ?? items;
      await tenancy.runWorkspace({ workspaceId: ws }, (c) => s.sink(c, account, ready));
    };
    try {
      const [web] = websiteOrders({});
      const [ebay] = ebayOrders({ ...shipTo(fullAddress) });
      if (web === undefined || ebay === undefined) throw new Error('no orders');
      await pollReal([web, ebay]);
      const later = new Date();
      await pollReal([
        { ...web, state: 'dispatched', dispatchedAt: later, updatedAt: later },
        { ...ebay, state: 'cancelled', cancelledAt: later, updatedAt: later },
      ]);
      // The scan below is worth something only if the jobs really are in the queue's tables.
      const jobs = await root.query<{ name: string; n: string }>(
        `SELECT name, count(*) AS n FROM pgboss.job GROUP BY name`,
      );
      expect(jobs.rows.map((r) => r.name)).toEqual(
        expect.arrayContaining(['orders.group_recompute', 'orders.pii_expiry', 'pii.delete']),
      );
      expect(await scanDatabaseForMarkers(main)).toEqual([]);
      expect(await scanDatabaseForMarkers(pii, ['vault'])).toEqual([]);
      expect(scanTextForMarkers(logs)).toEqual([]);
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  });

  it('[CAT-6] a line that missed its mapping event has it sent again, IDs only, with one key per set of lines', async () => {
    const code = `LATE-${randomUUID().slice(0, 8)}`;
    const catalogue = new CatalogueRepository(db.db);
    const line = { lineId: 'L1', sku: code, quantity: 1, title: null, linePricePence: 1200 };
    await poll([channelOrder({ lines: [line] })]);
    const sku = await tenancy.runWorkspace({ workspaceId: ws }, (c) =>
      catalogue.createSku(
        c,
        { sku: code, title: 'Late', shortDescription: 'l', weightG: 1, vatType: 'zero' },
        null,
        new Date(),
      ),
    );
    const { autoMapped } = await tenancy.runWorkspace({ workspaceId: ws }, (c) =>
      catalogue.upsertDiscovered(
        c,
        account,
        'ebay',
        [
          {
            externalSku: code,
            externalId: code,
            title: null,
            fulfilment: null,
            inventoryApi: null,
            quantity: null,
          },
        ],
        new Date(),
      ),
    );
    const listing = autoMapped[0]?.listingId ?? '';
    sent.length = 0;
    await poll([channelOrder()]);
    await poll([channelOrder()]);
    const events = sent.filter((s) => s.type === 'catalogue.listing_mapped');
    expect(events.map((e) => e.payload)).toEqual([
      { listing_id: listing, master_sku_id: sku, previous_master_sku_id: null },
      { listing_id: listing, master_sku_id: sku, previous_master_sku_id: null },
    ]);
    expect(new Set(events.map((e) => e.key)).size).toBe(1);
    expect(events[0]?.key.length).toBeLessThanOrEqual(200);
  });

  it('[FIN-1][INT-5] an order whose pence do not add up to eBay total raises one platform notice', async () => {
    const gbp = (value: string) => ({ value, currency: 'GBP' });
    const wrong = { pricingSummary: { deliveryCost: gbp('3.00'), total: gbp('12.00') } };
    await poll(
      ebayOrders({ ...shipTo(fullAddress), ...wrong }, { ...shipTo(fullAddress), ...wrong }),
    );
    await poll(ebayOrders({ ...shipTo(fullAddress) }));
    const notices = await root.query<{ record_id: string }>(
      `SELECT record_id FROM app.platform_notifications WHERE record_kind = 'order_total'`,
    );
    expect(notices.rows).toEqual([{ record_id: account }]);
    expect(logs.filter((l) => l.includes('orders.total_mismatch'))).toHaveLength(2);
  });

  it('[ORD-4] an order older than the PII window, or cancelled, is stored with no vault record (FA-16)', async () => {
    const old = channelOrder({
      placedAt: new Date(Date.now() - 100 * DAY),
      dispatchedAt: new Date(Date.now() - 95 * DAY),
      state: 'dispatched',
    });
    const cancelled = channelOrder({ state: 'cancelled', cancelledAt: new Date() });
    await poll([old, cancelled]);
    for (const o of [old, cancelled]) {
      expect(await vaultRows(`${account}:${o.externalId}`)).toEqual([]);
      expect(await orderRow(o.externalId)).toMatchObject({ pii_ref: null, pii_deleted_at: null });
    }
    expect(
      piiDeleteAfter(
        channelOrder({ state: 'dispatched', dispatchedAt: new Date(0), deliveredAt: null }),
        25,
        new Date(),
      ).getTime(),
    ).toBe(25 * DAY);
  });

  it('[DEL-1][AT-10] a buyer deleted by an eBay notice is refused; the order is kept without them (ADR-068)', async () => {
    const o = channelOrder({ placedAt: new Date(Date.now() - 2 * DAY) });
    const username = o.buyer?.channel_username ?? '';
    await web.ebayUserMatch({ user_id: `${PII_MARKER}uid-${randomUUID()}`, username });
    await poll([o]);
    expect(await vaultRows(`${account}:${o.externalId}`)).toEqual([]);
    const row = await orderRow(o.externalId);
    expect(row?.pii_ref).toBeNull();
    expect(row?.pii_deleted_at).toBeInstanceOf(Date);
  });

  it('[DEL-1] cancellation queues the deletion and dispatch moves the expiry, journalled, IDs only', async () => {
    sent.length = 0;
    const o = channelOrder();
    await poll([o]);
    const row = await orderRow(o.externalId);
    const dispatchedAt = new Date();
    await poll([
      { ...o, state: 'dispatched', dispatchedAt, updatedAt: new Date(Date.now() + 1000) },
    ]);
    const expiry = sent.find((s) => s.type === 'orders.pii_expiry');
    expect(expiry?.payload).toEqual({ order_id: row?.id, reason: 'dispatch' });
    const handler = ordersPiiExpiryHandler({ tenancy, ingest, vault: worker });
    expect(
      await handler.prepare(
        preparing('orders.pii_expiry', { order_id: row?.id ?? '', reason: 'dispatch' as const }),
      ),
    ).toEqual({ updated: 1 });
    const [record] = await vaultRows(`${account}:${o.externalId}`);
    expect(record?.delete_after.getTime()).toBe(dispatchedAt.getTime() + 25 * DAY);

    const c = channelOrder();
    await poll([c]);
    await poll([
      { ...c, state: 'cancelled', cancelledAt: new Date(), updatedAt: new Date(Date.now() + 1000) },
    ]);
    const cancel = sent.find((s) => s.type === 'pii.delete');
    expect(cancel?.payload).toEqual({
      trigger: 'cancellation',
      scope: {
        type: 'subjects',
        subject_type: 'order',
        subject_ids: [`${account}:${c.externalId}`],
      },
    });
    expect(JSON.stringify(sent)).not.toContain(PII_MARKER);
  });

  it('[ORD-4][DEL-1] a db-main failure after the vault write leaves an orphan the nightly sweep deletes (FA-10)', async () => {
    const o = channelOrder();
    // The vault write happens; the sink's transaction never commits.
    const s = stream();
    await s.prepare?.(job, [o]);
    await expect(
      tenancy.runWorkspace({ workspaceId: ws }, () =>
        Promise.reject(new Error('db-main write failed')),
      ),
    ).rejects.toThrow('db-main write failed');
    const subject = `${account}:${o.externalId}`;
    const [orphan] = await vaultRows(subject);
    expect(orphan).toBeDefined();
    const sweep = ordersOrphanSweepHandler({ tenancy, ingest, vault: worker, logger, graceMs: 0 });
    const result = await sweep.prepare(preparing('orders.orphan_sweep', {}));
    expect(result.orphans).toBe(1);
    // The hourly expiry run deletes it through the one deletion service, with a tombstone.
    await deletion.delete({
      workspace_id: ws,
      run_id: randomUUID(),
      trigger: 'expiry',
      scope: { type: 'expiry' },
    });
    expect(await vaultRows(subject)).toEqual([]);
    const tomb = await piiRoot.query(
      'SELECT 1 FROM vault.tombstones WHERE workspace_id = $1 AND pii_ref = $2',
      [ws, orphan?.pii_ref],
    );
    expect(tomb.rowCount).toBe(1);
    // Orders that db-main does hold are never touched.
    const kept = (
      await root.query<{ n: string }>(
        'SELECT count(*) AS n FROM app.orders WHERE pii_ref IS NOT NULL',
      )
    ).rows[0]?.n;
    expect(Number(kept)).toBeGreaterThan(0);
    expect((await sweep.prepare(preparing('orders.orphan_sweep', {}))).orphans).toBe(0);
  });

  it('[ORD-9][AT-26] the regroup job asks the vault which orders share a buyer and links them (C3.2)', async () => {
    const same = {
      name: `${PII_MARKER}Gus Group`,
      address_line1: `${PII_MARKER}9 Group Road`,
      city: 'Testville',
      postcode: 'GR1 1UP',
      country: 'GB',
      channel_username: `${PII_MARKER}gus`,
    };
    const a = channelOrder({ buyer: same, placedAt: new Date('2026-11-20T23:59:00Z') });
    const b = channelOrder({ buyer: same, placedAt: new Date('2026-11-21T00:01:00Z') });
    const other = channelOrder({ placedAt: new Date('2026-11-21T00:02:00Z') });
    await poll([a, b, other]);
    expect(sent.some((s) => s.type === 'orders.group_recompute')).toBe(true);
    const reads = new OrderReads(db.db);
    const handler = ordersGroupRecomputeHandler({ tenancy, reads, vault: worker });
    const recompute = {
      ...preparing('orders.group_recompute', {}),
      envelope: {
        workspace_id: ws,
        channel_account_id: account,
        idempotency_key: randomUUID(),
        attempt: 1,
        type: 'orders.group_recompute',
        payload: {},
      },
    };
    const classes = await handler.prepare(recompute);
    // Order subjects only: the vault never hands back a key or a value.
    expect(JSON.stringify(classes)).not.toContain(PII_MARKER);
    await tenancy.runWorkspace({ workspaceId: ws }, (ctx) =>
      handler.commit({ ...recompute, ctx }, classes),
    );
    const groups = await root.query<{ external_order_id: string; order_group_id: string | null }>(
      `SELECT external_order_id, order_group_id FROM app.orders
        WHERE external_order_id = ANY ($1::text[]) ORDER BY placed_at`,
      [[a.externalId, b.externalId, other.externalId]],
    );
    const [ga, gb, go] = groups.rows;
    expect(ga?.order_group_id).not.toBeNull();
    expect(gb?.order_group_id).toBe(ga?.order_group_id);
    expect(go?.order_group_id).toBeNull();
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
  });
});
