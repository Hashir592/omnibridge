import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pence, type TenantContext } from '@omnibridge/core';
import {
  AuditLog,
  CatalogueRepository,
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  ErasureRequestRepository,
  MemberAccessRepository,
  MembershipRepository,
  migrateMain,
  OrderIngest,
  OrderReads,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type IncomingOrder,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  scanTextForMarkers,
  sessionHeaders,
  startRoleCluster,
  stubAuth,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import { buildWebApp } from './app.ts';

/**
 * T-1002 order routes against a real db-main and a real pii-vault (ORD-1, ORD-2, ORD-5 to ORD-9,
 * AT-26, DEL-5). Orders are stored the way the worker stores them: vault first, then OrderIngest.
 */
describe('orders: list, detail, export, returns and same-buyer groups (T-1002)', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let tenancy: Tenancy;
  let vault: TestVault;
  let vaultRoot: pg.Pool;
  let mainRoot: pg.Pool;
  let reads: OrderReads;
  let ingest: OrderIngest;
  const clients = {} as Record<'web' | 'worker' | 'deletion', VaultClient>;
  const logs: string[] = [];
  const logger = createLogger({
    service: 'web',
    version: 'test',
    destination: { write: (line: string) => (logs.push(line), true) },
  });
  const A = randomUUID();
  const admin = randomUUID();
  const child = randomUUID();
  let companyX = '';
  let companyY = '';
  let accX = '';
  let accX2 = '';
  let accY = '';
  const headers = (userId: string) =>
    sessionHeaders({ workspaceId: A, userId, sessionId: `s-${userId.slice(0, 8)}` });
  const all = (): TenantContext => ({ workspaceId: A, companyIds: [companyX, companyY] });

  const buyer = (name: string, extra: Record<string, string> = {}) => ({
    name: `${PII_MARKER}${name}`,
    address_line1: `${PII_MARKER}1 Marker Lane`,
    city: 'Testville',
    postcode: 'TE1 1ST',
    country: 'GB',
    email: `${PII_MARKER}${name.toLowerCase().replace(/\W/g, '')}@example.test`,
    ...extra,
  });

  /** Vault first, then db-main, as the worker's order stream does. */
  const place = async (
    account: string,
    ref: string,
    placedAt: string,
    fields: Record<string, string> | null,
    over: Partial<IncomingOrder> = {},
  ) => {
    let pii: IncomingOrder['pii'] = { kind: 'none' };
    if (fields !== null) {
      const { pii_ref } = await clients.worker.ingest({
        workspace_id: A,
        kind: 'buyer_contact',
        channel_account_id: account,
        subject_type: 'order',
        subject_id: `${account}:${ref}`,
        fields,
      });
      pii = { kind: 'stored', piiRef: pii_ref };
    }
    await ingest.apply(all(), account, [
      {
        externalId: ref,
        rawStatus: 'NOT_STARTED/PAID',
        state: 'awaiting_dispatch',
        updatedAt: new Date(placedAt),
        placedAt: new Date(placedAt),
        paidAt: new Date(placedAt),
        shipBy: null,
        dispatchedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        discount: pence(0n),
        shipping: pence(300n),
        channelTotal: null,
        shipToCountry: 'GB',
        fba: false,
        cancelRequested: false,
        lines: [
          { lineId: 'L1', sku: `SKU-${ref}`, quantity: 1, title: 'Item', linePrice: pence(1200n) },
        ],
        refunds: [],
        pii,
        ...over,
      },
    ]);
    const { items } = await reads.list(all(), { q: ref }, { offset: 0, limit: 5 }, 10);
    return items.find((r) => r.orderRef === ref)?.id ?? '';
  };

  /** What the worker's orders.group_recompute job does: vault match, then db-main links. */
  const regroup = async (account: string) => {
    const candidates = await reads.groupCandidates(all(), account);
    const { groups } = await clients.worker.match({
      workspace_id: A,
      channel_account_id: account,
      pii_refs: candidates.map((c) => c.piiRef),
    });
    const classes = new Map(groups.flatMap((g) => g.map((s) => [s, g[0] ?? s] as const)));
    await reads.applyGroups(all(), account, classes);
  };

  const app = () =>
    buildWebApp({
      logger,
      version: 'test',
      checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
      tenancy,
      audit: new AuditLog(db.db),
      ...stubAuth({ OB_ENV: 'test' }),
      orders: { reads, vault: clients.web, audit: new AuditLog(db.db) },
      privacy: {
        vault: clients.web,
        erasures: new ErasureRequestRepository(db.db),
        queue: { send: () => Promise.resolve({ id: randomUUID(), created: true }) },
        audit: new AuditLog(db.db),
        orders: reads,
      },
    });
  const get = async (userId: string, url: string) => {
    const res = await app().inject({ method: 'GET', url, headers: headers(userId) });
    return {
      status: res.statusCode,
      body: res.body,
      json: () => res.json<Record<string, unknown>>(),
    };
  };
  const rows = async (userId: string, url = '/api/orders?limit=100') =>
    (await get(userId, url)).json().items as {
      id: string;
      order_ref: string;
      buyer: { name: string | null; postcode: string | null } | null;
      customer_state: string;
      group: { id: string; size: number; position: number; hidden: number } | null;
    }[];
  const auditRows = async (action: string, entityId: string) =>
    (
      await mainRoot.query<{ actor_user_id: string; reason: string | null }>(
        'SELECT user_id AS actor_user_id, reason FROM app.audit_events WHERE action = $1 AND entity_id = $2',
        [action, entityId],
      )
    ).rows;

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    db = createMainDb({ ...main.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
      journalDir: mkdtempSync(join(tmpdir(), 'ob-journal-')),
    });
    vaultRoot = new pg.Pool({ connectionString: pii.container.getConnectionUri(), max: 2 });
    mainRoot = new pg.Pool({ connectionString: main.container.getConnectionUri(), max: 2 });
    for (const caller of ['web', 'worker', 'deletion'] as const) {
      clients[caller] = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens[caller] });
    }
    reads = new OrderReads(db.db);
    ingest = new OrderIngest(db.db, {
      catalogue: new CatalogueRepository(db.db),
      ports: {
        cancelPii: () => Promise.resolve(),
        shortenPii: () => Promise.resolve(),
        totalMismatch: () => Promise.resolve(),
        lateMapped: () => Promise.resolve(),
        regroup: () => Promise.resolve(),
      },
    });
    await tenancy.run({ workspaceId: A, companyIds: [] }, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Orders test' }),
    );
    for (const [id, role] of [
      [admin, 'admin'],
      [child, 'member'],
    ] as const) {
      await tenancy.run({ workspaceId: A, companyIds: [], userId: id }, async (c) => {
        await new UserRepository(db.db).create(c, { id, email: `${id}@example.test`, name: 'U' });
        await new MembershipRepository(db.db).add(c, { userId: id, role });
      });
    }
    [companyX, companyY] = await tenancy.runWorkspace({ workspaceId: A }, async (c) => {
      const companies = new CompanyRepository(db.db);
      const address = { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' };
      return [
        await companies.create(c, {
          legalName: 'X Ltd',
          tradingName: 'X',
          registeredAddress: address,
        }),
        await companies.create(c, {
          legalName: 'Y Ltd',
          tradingName: 'Y',
          registeredAddress: address,
        }),
      ];
    });
    [accX, accX2, accY] = await tenancy.runWorkspace({ workspaceId: A }, async (c) => {
      const accounts = new ChannelAccountRepository(db.db);
      return [
        await accounts.create(c, { companyId: companyX, provider: 'ebay', displayName: 'eBay X' }),
        await accounts.create(c, { companyId: companyX, provider: 'ebay', displayName: 'eBay X2' }),
        await accounts.create(c, {
          companyId: companyY,
          provider: 'website',
          displayName: 'Web Y',
        }),
      ];
    });
    // The child sees company X only, with the Orders tab.
    await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new MemberAccessRepository(db.db).set(c, child, {
        role: 'member',
        tabs: ['orders'],
        companyIds: [companyX],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await vault.close();
    await vaultRoot.end();
    await mainRoot.end();
    await db.destroy();
    await Promise.all([main.container.stop(), pii.container.stop()]);
  });

  it('[AT-26][ORD-9] 23:59 and 00:01 London on one account form one group; two accounts or another name do not', async () => {
    const ada = buyer('Ada Group');
    const first = await place(accX, 'G-2359', '2026-11-20T23:59:00Z', ada);
    const second = await place(accX, 'G-0001', '2026-11-21T00:01:00Z', ada);
    // The same buyer on another eBay account, and another name at the same address.
    const otherAccount = await place(accX2, 'G-OTHER', '2026-11-21T00:02:00Z', ada);
    const otherName = await place(accX, 'G-NAME', '2026-11-21T00:03:00Z', buyer('Bob Group'));
    await regroup(accX);
    await regroup(accX2);
    const list = await rows(admin);
    const grouped = list.filter((r) => r.group !== null);
    expect(grouped.map((r) => r.id)).toEqual([first, second]);
    expect(grouped.map((r) => [r.group?.size, r.group?.position])).toEqual([
      [2, 1],
      [2, 2],
    ]);
    // Group members are adjacent rows.
    const at = list.findIndex((r) => r.id === first);
    expect(list[at + 1]?.id).toBe(second);
    for (const id of [otherAccount, otherName]) {
      expect(list.find((r) => r.id === id)?.group).toBeNull();
    }
    // A filter that hides one member says so ("+1 related order not shown").
    const filtered = await rows(admin, '/api/orders?q=G-2359');
    expect(filtered[0]?.group).toMatchObject({ size: 2, hidden: 1 });
    // The detail page's "Same buyer" panel.
    const detail = (await get(admin, `/api/orders/${first}`)).json();
    expect((detail.same_buyer as { members: { id: string }[] }).members.map((m) => m.id)).toEqual([
      first,
      second,
    ]);
  });

  it('[ORD-9] "Not the same buyer" dismisses for good; removing a member keeps the rest grouped', async () => {
    const cy = buyer('Cy Dismiss');
    const a = await place(accX, 'D-1', '2026-11-22T10:00:00Z', cy);
    const b = await place(accX, 'D-2', '2026-11-22T11:00:00Z', cy);
    await regroup(accX);
    const groupId = (await rows(admin)).find((r) => r.id === a)?.group?.id ?? '';
    const server = app();
    const dismissed = await server.inject({
      method: 'POST',
      url: `/api/order-groups/${groupId}/dismiss`,
      headers: headers(child),
      payload: { reason: 'Two people in one house' },
    });
    expect(dismissed.statusCode).toBe(204);
    await regroup(accX);
    expect((await rows(admin)).filter((r) => [a, b].includes(r.id)).map((r) => r.group)).toEqual([
      null,
      null,
    ]);
    expect(await auditRows('order_group.dismissed', groupId)).toEqual([
      { actor_user_id: child, reason: 'Two people in one house' },
    ]);
    // Three members; one is removed and never regrouped; the other two stay.
    const di = buyer('Di Remove');
    const [r1, r2, r3] = [
      await place(accX, 'R-1', '2026-11-23T09:00:00Z', di),
      await place(accX, 'R-2', '2026-11-23T10:00:00Z', di),
      await place(accX, 'R-3', '2026-11-23T11:00:00Z', di),
    ];
    await regroup(accX);
    const g2 = (await rows(admin)).find((r) => r.id === r1)?.group?.id ?? '';
    const removed = await server.inject({
      method: 'POST',
      url: `/api/order-groups/${g2}/members/${r3}/remove`,
      headers: headers(admin),
      payload: { reason: 'Must go by DPD' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ members: { id: string }[] }>().members.map((m) => m.id)).toEqual([
      r1,
      r2,
    ]);
    await regroup(accX);
    const after = await rows(admin);
    expect(after.find((r) => r.id === r3)?.group).toBeNull();
    expect(after.find((r) => r.id === r1)?.group?.id).toBe(g2);
  });

  it('[ORD-9] when a group splits, each part is its own group (never one id for two groups)', async () => {
    const ivy = buyer('Ivy Split');
    const ids = [
      await place(accX, 'S-1', '2026-11-24T09:00:00Z', ivy),
      await place(accX, 'S-2', '2026-11-24T09:10:00Z', ivy),
      await place(accX, 'S-3', '2026-11-24T09:20:00Z', ivy),
      await place(accX, 'S-4', '2026-11-24T09:30:00Z', ivy),
    ];
    await regroup(accX);
    const before = (await rows(admin)).filter((r) => ids.includes(r.id));
    expect(new Set(before.map((r) => r.group?.id)).size).toBe(1);
    // The vault now says S-1/S-2 and S-3/S-4 are two buyers (two match classes).
    const subject = (ref: string) => `${accX}:${ref}`;
    await reads.applyGroups(
      all(),
      accX,
      new Map([
        [subject('S-1'), 'one'],
        [subject('S-2'), 'one'],
        [subject('S-3'), 'two'],
        [subject('S-4'), 'two'],
      ]),
    );
    const after = (await rows(admin)).filter((r) => ids.includes(r.id));
    const [g1, g2, g3, g4] = ids.map((id) => after.find((r) => r.id === id)?.group?.id);
    expect(g1).toBe(g2);
    expect(g3).toBe(g4);
    expect(g1).not.toBe(g3);
    expect(g1).toBe(before[0]?.group?.id);
  });

  it('[ORD-5][DP-7] lists show masked values; every full view is logged in the vault and the audit log', async () => {
    const id = await place(accX, 'P-1', '2026-11-19T09:00:00Z', buyer('Pat Viewer'));
    const row = (await rows(child)).find((r) => r.id === id);
    expect(row?.buyer).toEqual({ name: 'P. V***', postcode: 'TE1' });
    expect(JSON.stringify(await rows(child))).not.toContain(PII_MARKER);
    const res = await app().inject({
      method: 'POST',
      url: `/api/orders/${id}/customer`,
      headers: headers(child),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string; town: string }>()).toMatchObject({
      name: `${PII_MARKER}Pat Viewer`,
      town: 'Testville',
    });
    expect(await auditRows('order.customer_viewed', id)).toEqual([
      { actor_user_id: child, reason: null },
    ]);
    const logged = await vaultRoot.query(
      `SELECT actor_user_id FROM vault.access_log
        WHERE workspace_id = $1 AND capability = 'read_full' AND purpose = 'order_detail'`,
      [A],
    );
    expect(logged.rows.map((r: { actor_user_id: string }) => r.actor_user_id)).toContain(child);
    // An order with no buyer details answers 404 and says so in its state.
    const none = await place(accX, 'P-NONE', '2026-11-19T09:30:00Z', null);
    expect(
      (
        await app().inject({
          method: 'POST',
          url: `/api/orders/${none}/customer`,
          headers: headers(admin),
        })
      ).statusCode,
    ).toBe(404);
    expect((await rows(admin)).find((r) => r.id === none)?.customer_state).toBe('none');
  });

  it('[ORD-6] a customer whose record has just gone is not found, and no view is recorded', async () => {
    const id = await place(accX, 'GONE-1', '2026-11-19T09:00:00Z', buyer('Gil Gone'));
    const [row] = (
      await mainRoot.query<{ pii_ref: string }>('SELECT pii_ref FROM app.orders WHERE id = $1', [
        id,
      ])
    ).rows;
    // The vault has deleted it; db-main has no tombstone yet.
    await clients.deletion.delete({
      workspace_id: A,
      run_id: randomUUID(),
      trigger: 'erasure',
      scope: { type: 'refs', pii_refs: [row?.pii_ref ?? ''] },
    });
    const res = await app().inject({
      method: 'POST',
      url: `/api/orders/${id}/customer`,
      headers: headers(admin),
    });
    expect(res.statusCode).toBe(404);
    expect(await auditRows('order.customer_viewed', id)).toEqual([]);
  });

  it('[ORD-8][AT-9] the CSV export holds no PII, not even masked values', async () => {
    await place(accX, 'E-1', '2026-11-18T09:00:00Z', buyer('Eve Export'));
    const res = await get(admin, '/api/orders/export');
    expect(res.status).toBe(200);
    expect(res.body).toContain('E-1');
    expect(scanTextForMarkers([res.body])).toEqual([]);
    expect(res.body).not.toContain('E. E***');
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
  });

  it('[ORD-2][ORD-1] filters, SKU search and buyer postcode search (in the body) find the orders', async () => {
    const id = await place(
      accY,
      'F-WEB-1',
      '2026-11-17T09:00:00Z',
      buyer('Fay Filter', { postcode: 'FL7 7TR' }),
    );
    const byStatus = await rows(
      admin,
      `/api/orders?status=awaiting_dispatch&channel_account_id=${accY}`,
    );
    expect(byStatus.map((r) => r.id)).toContain(id);
    expect((await rows(admin, '/api/orders?q=sku-f-web')).map((r) => r.id)).toEqual([id]);
    const res = await app().inject({
      method: 'POST',
      url: '/api/orders/search',
      headers: headers(admin),
      payload: { buyer_postcode: 'fl7 7tr' },
    });
    expect(res.json<{ items: { id: string }[] }>().items.map((r) => r.id)).toEqual([id]);
    expect((await rows(admin, '/api/orders?status=cancelled')).map((r) => r.id)).not.toContain(id);
  });

  it("[TEN-5][PERM-3] a child user sees only orders of their companies; another company's are 404", async () => {
    const yOrder = await place(accY, 'Y-ONLY', '2026-11-16T09:00:00Z', buyer('Yan Hidden'));
    expect((await rows(child)).map((r) => r.id)).not.toContain(yOrder);
    expect((await get(child, `/api/orders/${yOrder}`)).status).toBe(404);
    expect((await get(child, `/api/orders?channel_account_id=${accY}`)).status).toBe(404);
    expect(
      (
        await app().inject({
          method: 'POST',
          url: `/api/orders/${yOrder}/customer`,
          headers: headers(child),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('[ORD-6][ORD-7] the detail shows lines, VAT groups, history, refunds and notes; returns list refunds', async () => {
    const id = await place(accX, 'RF-1', '2026-11-15T09:00:00Z', buyer('Rae Refund'));
    await ingest.apply(all(), accX, [
      {
        externalId: 'RF-1',
        rawStatus: 'FULFILLED/PARTIALLY_REFUNDED',
        state: 'dispatched',
        updatedAt: new Date('2026-11-16T09:00:00Z'),
        placedAt: new Date('2026-11-15T09:00:00Z'),
        paidAt: new Date('2026-11-15T09:00:00Z'),
        shipBy: null,
        dispatchedAt: new Date('2026-11-16T09:00:00Z'),
        deliveredAt: null,
        cancelledAt: null,
        discount: pence(0n),
        shipping: pence(300n),
        channelTotal: null,
        shipToCountry: 'GB',
        fba: false,
        cancelRequested: false,
        lines: [
          { lineId: 'L1', sku: 'SKU-RF-1', quantity: 1, title: 'Item', linePrice: pence(1200n) },
        ],
        refunds: [
          {
            refundId: 'R1',
            refundedAt: new Date('2026-11-16T10:00:00Z'),
            amount: pence(600n),
            lines: null,
          },
        ],
        pii: { kind: 'unchanged' },
      },
    ]);
    const d = (await get(admin, `/api/orders/${id}`)).json() as {
      status: string;
      lines: { provisional: boolean; vat_rate_bp: number }[];
      money: {
        gross_pence: number;
        vat_pence: number;
        refunded_pence: number;
        refunded_vat_pence: number;
      };
      history: { status: string | null }[];
      refunds: { amount_pence: number }[];
    };
    expect(d.status).toBe('partly_refunded');
    expect(d.lines).toEqual([expect.objectContaining({ provisional: true, vat_rate_bp: 2000 })]);
    expect(d.money).toMatchObject({
      gross_pence: 1500,
      vat_pence: 250,
      refunded_pence: 600,
      refunded_vat_pence: 100,
    });
    expect(d.history.map((h) => h.status)).toEqual(['awaiting_dispatch', 'partly_refunded']);
    const notes = await app().inject({
      method: 'PUT',
      url: `/api/orders/${id}/notes`,
      headers: headers(admin),
      payload: { notes: 'Packed twice' },
    });
    expect(notes.json<{ notes: string }>().notes).toBe('Packed twice');
    expect(await auditRows('order.notes_changed', id)).toHaveLength(1);
    const returns = (await get(admin, '/api/returns')).json().items as {
      order_ref: string;
      amount_pence: number;
      kind: string;
    }[];
    expect(returns).toContainEqual(
      expect.objectContaining({ order_ref: 'RF-1', amount_pence: 600, kind: 'refund' }),
    );
  });

  it("[DEL-5] the access export lists the buyer's orders by vault subject (linkedOrders)", async () => {
    await place(
      accX,
      'L-1',
      '2026-11-14T09:00:00Z',
      buyer('Lou Linked', { email: `${PII_MARKER}lou@example.test` }),
    );
    const res = await app().inject({
      method: 'POST',
      url: '/api/access-requests/export',
      headers: headers(admin),
      payload: { identifiers: { email: `${PII_MARKER}lou@example.test` } },
    });
    expect(res.statusCode).toBe(200);
    const file = JSON.parse(res.body) as {
      linkedOrders: { orderRef: string; channelAccountId: string }[];
    };
    expect(file.linkedOrders).toEqual([
      expect.objectContaining({ orderRef: 'L-1', channelAccountId: accX }),
    ]);
  });
});
