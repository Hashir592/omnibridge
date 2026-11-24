import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CatalogueRepository,
  createMainDb,
  createQueues,
  migrateMain,
  OrderIngest,
  OrderReads,
  Tenancy,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import type { ChannelOrder } from '@omnibridge/provider-kit';
import { JOBS, type PreparingJob } from '@omnibridge/queue';
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
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']),
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
      ports: orderIngestPorts({
        send: (def, input) => {
          sent.push({ type: def.type, key: input.idempotencyKey, payload: input.payload });
          return Promise.resolve({ id: randomUUID(), created: true });
        },
      }),
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
        { placedAt: new Date(0), dispatchedAt: new Date(0), deliveredAt: null },
        25,
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
