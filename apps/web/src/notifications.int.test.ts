import { randomUUID } from 'node:crypto';
import { InvalidNotification, Notifier } from '@omnibridge/core';
import {
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  MemberAccessRepository,
  MembershipRepository,
  migrateMain,
  NotificationRepository,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import {
  PII_MARKER,
  platformHeaders,
  scanDatabaseForMarkers,
  sessionHeaders,
  startRoleCluster,
  stubAuth,
  type RoleCluster,
} from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

// T-0501: the notification centre. Modules raise through core's Notifier with their own bound
// context (here the worker's, as a job would); members read through web's routes, each seeing
// only what their role, ticked tabs and permitted companies allow (NTF-2, PERM-3).

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };

interface Item {
  id: string;
  type: string;
  title: string;
  severity: string;
  state: string;
  companyId: string | null;
  record: { kind: string; id: string };
  params: Record<string, unknown>;
}

describe('notification centre [NTF-1][NTF-2][NTF-5]', () => {
  let main: RoleCluster;
  let app: MainDbHandle;
  let worker: MainDbHandle;
  let owner: pg.Pool;
  let appTenancy: Tenancy;
  let workerTenancy: Tenancy;
  let notifier: Notifier;
  let clock = new Date('2026-11-19T09:00:00.000Z');
  const A = randomUUID();
  const B = randomUUID();
  const admin = randomUUID();
  const child = randomUUID();
  const operator = randomUUID();
  const adminB = randomUUID();
  let c1 = '';
  let c2 = '';
  let account1 = '';

  const as = (userId: string, ws = A) =>
    sessionHeaders({ workspaceId: ws, userId, sessionId: `s-${userId.slice(0, 8)}` });
  const server = () =>
    buildWebApp({
      logger,
      version: 'test',
      checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
      tenancy: appTenancy,
      ...stubAuth({ OB_ENV: 'test' }),
      notifications: { notifications: new NotificationRepository(app.db), now: () => clock },
    });
  /** As a job of workspace `ws` would: its own bound context. */
  const inJob = <T>(fn: (ctx: Parameters<Notifier['raise']>[0]) => Promise<T>, ws = A) =>
    workerTenancy.runWorkspace({ workspaceId: ws }, fn);
  const list = async (s: ReturnType<typeof server>, headers: Record<string, string>, q = '') => {
    const res = await s.inject({ method: 'GET', url: `/api/notifications${q}`, headers });
    expect(res.statusCode).toBe(200);
    return res.json<{ items: Item[]; next_cursor: string | null }>();
  };
  const unread = async (s: ReturnType<typeof server>, headers: Record<string, string>) =>
    (await s.inject({ method: 'GET', url: '/api/notifications/unread-count', headers })).json<{
      unread: number;
    }>().unread;
  const rowCount = async (type: string, recordId: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          'SELECT count(*) AS n FROM app.notifications WHERE type = $1 AND record_id = $2',
          [type, recordId],
        )
      ).rows[0]?.n,
    );

  beforeAll(async () => {
    main = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_worker']);
    await migrateMain(main.connection('ob_owner'));
    // The container's superuser: sets the platform flag (console tooling is M05) and counts rows.
    owner = new pg.Pool({ connectionString: main.container.getConnectionUri(), max: 2 });
    app = createMainDb({ ...main.connection('ob_app'), max: 4 });
    worker = createMainDb({ ...main.connection('ob_worker'), max: 4 });
    appTenancy = new Tenancy(app.db);
    workerTenancy = new Tenancy(worker.db);
    notifier = new Notifier({ store: new NotificationRepository(worker.db), now: () => clock });

    for (const [ws, user, role, name] of [
      [A, admin, 'admin', 'Admin A'],
      [A, child, 'member', 'Child A'],
      [A, operator, 'member', 'Operator'],
      [B, adminB, 'admin', 'Admin B'],
    ] as const) {
      await appTenancy.run({ workspaceId: ws, companyIds: [], userId: user }, async (c) => {
        if (user === admin || user === adminB) {
          await new WorkspaceRepository(app.db).create(c, { name: `Workspace ${name}` });
        }
        await new UserRepository(app.db).create(c, {
          id: user,
          email: `${user}@example.test`,
          name,
        });
        await new MembershipRepository(app.db).add(c, { userId: user, role });
      });
    }
    await owner.query('UPDATE app.users SET platform_admin = true WHERE id = $1', [operator]);
    [c1, c2] = await appTenancy.runWorkspace({ workspaceId: A }, async (c) => {
      const companies = new CompanyRepository(app.db);
      return [
        await companies.create(c, {
          legalName: 'One Ltd',
          tradingName: 'One',
          registeredAddress: address,
        }),
        await companies.create(c, {
          legalName: 'Two Ltd',
          tradingName: 'Two',
          registeredAddress: address,
        }),
      ];
    });
    account1 = await appTenancy.runWorkspace({ workspaceId: A }, (c) =>
      new ChannelAccountRepository(app.db).create(c, {
        companyId: c1,
        provider: 'ebay',
        displayName: 'eBay one',
      }),
    );
    // The child has the stock tab and company one ticked, nothing else.
    await appTenancy.runWorkspace({ workspaceId: A, userId: admin }, (c) =>
      new MemberAccessRepository(app.db).set(c, child, {
        role: 'member',
        tabs: ['stock-catalogue'],
        companyIds: [c1],
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await owner.end();
    await app.destroy();
    await worker.destroy();
    await main.container.stop();
  });

  it('[NTF-5] a second raise for the same type and record updates the first: one row, read stays read unless severity rises', async () => {
    const s = server();
    const bill = randomUUID();
    const first = await inJob((c) =>
      notifier.raise(c, {
        type: 'finance.bill_due',
        record: { kind: 'bill', id: bill },
        companyId: c1,
        params: { daysLeft: 3 },
      }),
    );
    expect(first).toMatchObject({ created: true, escalated: false, reopened: false, version: 1 });
    const mine = (await list(s, as(admin))).items.find((n) => n.record.id === bill);
    expect(mine).toMatchObject({
      type: 'finance.bill_due',
      title: 'Unpaid bill due or overdue',
      severity: 'info',
      state: 'unread',
      companyId: c1,
      params: { daysLeft: 3 },
    });
    const read = await s.inject({
      method: 'POST',
      url: `/api/notifications/${first.id}/read`,
      headers: as(admin),
    });
    expect(read.json()).toEqual({ marked: 1 });

    clock = new Date(clock.getTime() + 60_000);
    const again = await inJob((c) =>
      notifier.raise(c, {
        type: 'finance.bill_due',
        record: { kind: 'bill', id: bill },
        companyId: c1,
        params: { daysLeft: 2 },
      }),
    );
    expect(again).toMatchObject({ id: first.id, created: false, escalated: false, version: 1 });
    expect(await rowCount('finance.bill_due', bill)).toBe(1);
    expect((await list(s, as(admin))).items.find((n) => n.id === first.id)).toMatchObject({
      state: 'read',
      params: { daysLeft: 2 },
    });

    // Overdue now: the severity rises, so it is unread again for everyone.
    const overdue = await inJob((c) =>
      notifier.raise(c, {
        type: 'finance.bill_due',
        record: { kind: 'bill', id: bill },
        severity: 'warning',
        companyId: c1,
      }),
    );
    expect(overdue).toMatchObject({ id: first.id, escalated: true, version: 2 });
    expect(await rowCount('finance.bill_due', bill)).toBe(1);
    expect((await list(s, as(admin))).items.find((n) => n.id === first.id)).toMatchObject({
      severity: 'warning',
      state: 'unread',
    });
    await s.close();
  });

  it('[NTF-1] resolve clears a notification when its condition clears; a later raise reopens it unread', async () => {
    const s = server();
    const sku = randomUUID();
    const raised = await inJob((c) =>
      notifier.raise(c, {
        type: 'inventory.oversold',
        record: { kind: 'sku', id: sku },
        companyId: c1,
        channelAccountId: account1,
      }),
    );
    const before = await unread(s, as(admin));
    expect(
      await inJob((c) => notifier.resolve(c, 'inventory.oversold', { kind: 'sku', id: sku })),
    ).toBe(true);
    expect(
      await inJob((c) => notifier.resolve(c, 'inventory.oversold', { kind: 'sku', id: sku })),
    ).toBe(false);
    expect(await unread(s, as(admin))).toBe(before - 1);
    const resolved = await list(s, as(admin), '?state=resolved');
    expect(resolved.items.find((n) => n.id === raised.id)).toMatchObject({ state: 'resolved' });

    const reopened = await inJob((c) =>
      notifier.raise(c, {
        type: 'inventory.oversold',
        record: { kind: 'sku', id: sku },
        companyId: c1,
      }),
    );
    expect(reopened).toMatchObject({ id: raised.id, reopened: true, version: 2 });
    expect((await list(s, as(admin), '?state=unread')).items.map((n) => n.id)).toContain(raised.id);
    await s.close();
  });

  it('[NTF-2][PERM-3] a child sees only notifications of a ticked tab and company, and loses them when a tick is removed', async () => {
    const s = server();
    const raise = (type: string, companyId: string) =>
      inJob((c) =>
        notifier.raise(c, { type, record: { kind: 'sku', id: randomUUID() }, companyId }),
      );
    const seen = await raise('inventory.oversold', c1);
    const otherCompany = await raise('inventory.oversold', c2);
    const otherTab = await raise('finance.recurring_created', c1);
    const adminTab = await inJob((c) =>
      notifier.raise(c, {
        type: 'channel.auth_lost',
        record: { kind: 'channel_account', id: account1 },
        companyId: c1,
        channelAccountId: account1,
      }),
    );

    const childIds = (await list(s, as(child))).items.map((n) => n.id);
    expect(childIds).toContain(seen.id);
    expect(childIds).not.toContain(otherCompany.id);
    expect(childIds).not.toContain(otherTab.id);
    expect(childIds).not.toContain(adminTab.id);
    const adminIds = (await list(s, as(admin))).items.map((n) => n.id);
    expect(adminIds).toEqual(
      expect.arrayContaining([seen.id, otherCompany.id, otherTab.id, adminTab.id]),
    );
    // What a child cannot see, it cannot mark either.
    for (const id of [otherCompany.id, otherTab.id, adminTab.id]) {
      const res = await s.inject({
        method: 'POST',
        url: `/api/notifications/${id}/read`,
        headers: as(child),
      });
      expect(res.statusCode).toBe(404);
    }
    const all = await s.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: as(child),
    });
    expect(all.statusCode).toBe(200);
    expect(await unread(s, as(child))).toBe(0);
    expect((await list(s, as(admin))).items.find((n) => n.id === otherTab.id)?.state).toBe(
      'unread',
    );

    // The stock tab is unticked: the child no longer sees it.
    await appTenancy.runWorkspace({ workspaceId: A, userId: admin }, (c) =>
      new MemberAccessRepository(app.db).set(c, child, {
        role: 'member',
        tabs: ['orders'],
        companyIds: [c1],
      }),
    );
    expect((await list(s, as(child))).items.map((n) => n.id)).not.toContain(seen.id);
    await appTenancy.runWorkspace({ workspaceId: A, userId: admin }, (c) =>
      new MemberAccessRepository(app.db).set(c, child, {
        role: 'member',
        tabs: ['stock-catalogue'],
        companyIds: [c1],
      }),
    );
    await s.close();
  });

  it('[NTF-2][TEN-1] another workspace never sees a notification, nor can mark it', async () => {
    const s = server();
    const inB = await inJob(
      (c) =>
        notifier.raise(c, {
          type: 'reminders.due',
          record: { kind: 'reminder', id: randomUUID() },
        }),
      B,
    );
    expect((await list(s, as(admin))).items.map((n) => n.id)).not.toContain(inB.id);
    const res = await s.inject({
      method: 'POST',
      url: `/api/notifications/${inB.id}/read`,
      headers: as(admin),
    });
    expect(res.statusCode).toBe(404);
    expect((await list(s, as(adminB, B))).items.map((n) => n.id)).toContain(inB.id);
    await s.close();
  });

  it('[NTF-2] platform notices reach platform admins only, in the console, never a workspace bell', async () => {
    const s = server();
    const day = '2026-11-19';
    const notice = await notifier.raisePlatform(null, {
      type: 'ebay.api_usage_high',
      record: { kind: 'day', id: day },
      params: { percent: 82 },
    });
    expect(notice).toMatchObject({ created: true, escalated: false, reopened: false });
    const again = await notifier.raisePlatform(null, {
      type: 'ebay.api_usage_high',
      record: { kind: 'day', id: day },
      params: { percent: 90 },
    });
    expect(again).toMatchObject({ id: notice.id, created: false });

    const console = await s.inject({
      method: 'GET',
      url: '/api/platform/notifications',
      headers: platformHeaders(operator),
    });
    expect(console.statusCode).toBe(200);
    expect(console.json<{ items: Item[] }>().items).toEqual([
      expect.objectContaining({ id: notice.id, state: 'unread', params: { percent: 90 } }),
    ]);
    expect(
      (
        await s.inject({
          method: 'GET',
          url: '/api/platform/notifications/unread-count',
          headers: platformHeaders(operator),
        })
      ).json(),
    ).toEqual({ unread: 1 });
    const marked = await s.inject({
      method: 'POST',
      url: `/api/platform/notifications/${notice.id}/read`,
      headers: platformHeaders(operator),
    });
    expect(marked.json()).toEqual({ marked: 1 });

    // Someone without the platform flag gets nothing, even past the route check.
    const outsider = await s.inject({
      method: 'GET',
      url: '/api/platform/notifications',
      headers: platformHeaders(admin),
    });
    expect(outsider.json<{ items: Item[] }>().items).toEqual([]);
    expect(
      (
        await s.inject({
          method: 'POST',
          url: `/api/platform/notifications/${notice.id}/read`,
          headers: platformHeaders(admin),
        })
      ).statusCode,
    ).toBe(404);
    // A workspace session cannot call the console route, and its bell never holds the notice.
    const tenant = await s.inject({
      method: 'GET',
      url: '/api/platform/notifications',
      headers: as(admin),
    });
    expect(tenant.statusCode).toBeGreaterThanOrEqual(401);
    expect((await list(s, as(admin))).items.map((n) => n.id)).not.toContain(notice.id);

    // The tables are closed to the app roles; the worker can raise but not read.
    const asApp = new pg.Pool({ ...main.connection('ob_app'), max: 1 });
    const asWorker = new pg.Pool({ ...main.connection('ob_worker'), max: 1 });
    try {
      await expect(asApp.query('SELECT * FROM app.platform_notifications')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        asWorker.query('SELECT * FROM app.platform_notice_list($1, NULL, NULL, NULL, NULL, 10)', [
          operator,
        ]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await asApp.end();
      await asWorker.end();
    }
    await s.close();
  });

  it('[NTF-1] unknown types and anything but IDs, counts and flags are refused; no buyer PII reaches db-main', async () => {
    const order = randomUUID();
    await expect(
      inJob((c) =>
        notifier.raise(c, { type: 'orders.mystery', record: { kind: 'order', id: order } }),
      ),
    ).rejects.toBeInstanceOf(InvalidNotification);
    await expect(
      inJob((c) =>
        notifier.raise(c, {
          type: 'orders.atoz_return',
          record: { kind: 'order', id: order },
          params: { buyer: `${PII_MARKER}Buyer Name` },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidNotification);
    await expect(
      inJob((c) =>
        notifier.raise(c, {
          type: 'orders.atoz_return',
          record: { kind: 'order', id: `${PII_MARKER}buyer` },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidNotification);
    // A platform type cannot be raised in a workspace, nor the other way round.
    await expect(
      inJob((c) =>
        notifier.raise(c, {
          type: 'ebay.api_usage_high',
          record: { kind: 'day', id: '2026-11-19' },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidNotification);
    await inJob((c) =>
      notifier.raise(c, {
        type: 'orders.atoz_return',
        record: { kind: 'order', id: order },
        signal: 'estimate',
        companyId: c1,
        params: { orderId: order, daysToRespond: 7 },
      }),
    );
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
  });

  it('[NTF-1] the list pages by cursor, newest change first, and filters by severity', async () => {
    const s = server();
    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + 1_000);
      await inJob((c) =>
        notifier.raise(c, {
          type: 'forecast.low_stock',
          record: { kind: 'sku', id: randomUUID() },
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `?severity=info&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = await list(s, as(admin), q);
      seen.push(...page.items.map((n) => n.id));
      expect(page.items.every((n) => n.severity === 'info')).toBe(true);
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    const bad = await s.inject({
      method: 'GET',
      url: '/api/notifications?cursor=not-a-cursor',
      headers: as(admin),
    });
    expect(bad.statusCode).toBe(400);
    await s.close();
  });
  it('[NTF-4] each user chooses email per type: critical on by default and locked on for admins, others off until turned on', async () => {
    const s = server();
    type Pref = { type: string; email: boolean; locked: boolean; severity: string };
    const prefs = async (headers: Record<string, string>) =>
      (
        await s.inject({ method: 'GET', url: '/api/me/notification-email-preferences', headers })
      ).json<{ items: Pref[] }>().items;
    const put = (headers: Record<string, string>, items: { type: string; email: boolean }[]) =>
      s.inject({
        method: 'PUT',
        url: '/api/me/notification-email-preferences',
        headers,
        payload: { items },
      });

    const adminPrefs = await prefs(as(admin));
    expect(adminPrefs.find((p) => p.type === 'inventory.oversold')).toMatchObject({
      email: true,
      locked: true,
      severity: 'critical',
    });
    expect(adminPrefs.find((p) => p.type === 'finance.bill_due')).toMatchObject({
      email: false,
      locked: false,
    });
    // Platform types are never offered in a workspace.
    expect(adminPrefs.some((p) => p.type === 'ebay.api_usage_high')).toBe(false);
    expect((await put(as(admin), [{ type: 'inventory.oversold', email: false }])).statusCode).toBe(
      400,
    );
    const set = await put(as(admin), [{ type: 'finance.bill_due', email: true }]);
    expect(set.statusCode).toBe(200);
    expect(
      set.json<{ items: Pref[] }>().items.find((p) => p.type === 'finance.bill_due')?.email,
    ).toBe(true);

    // A child sees only the types of their ticked tab, and may switch a critical one off.
    const childPrefs = await prefs(as(child));
    expect([...new Set(childPrefs.map((p) => p.type.split('.')[0]))]).toEqual(
      expect.arrayContaining(['inventory']),
    );
    expect(childPrefs.some((p) => p.type === 'finance.bill_due')).toBe(false);
    expect((await put(as(child), [{ type: 'finance.bill_due', email: true }])).statusCode).toBe(
      400,
    );
    expect((await put(as(child), [{ type: 'inventory.oversold', email: false }])).statusCode).toBe(
      200,
    );
    expect((await prefs(as(child))).find((p) => p.type === 'inventory.oversold')).toMatchObject({
      email: false,
      locked: false,
    });
    // Each user's choices are their own.
    expect((await prefs(as(admin))).find((p) => p.type === 'inventory.oversold')?.email).toBe(true);
    await s.close();
  });
});
