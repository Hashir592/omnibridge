import { randomUUID } from 'node:crypto';
import { contractRoutes } from '@omnibridge/contract';
import type { TenantContext } from '@omnibridge/core';
import {
  AuditLog,
  createMainDb,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { sessionHeaders, startRoleCluster, stubAuth, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';
import { UTF8_BOM } from './audit-csv.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };

interface Page {
  items: { id: string; action: string; user_id: string | null; after: Record<string, unknown> }[];
  next_cursor: string | null;
}

describe('audit log routes (AUD-1, AUD-4)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let tenancy: Tenancy;
  let audit: AuditLog;
  const A = randomUUID();
  const B = randomUUID();
  const admin = randomUUID();
  const child = randomUUID();
  const outsider = randomUUID();
  const ctx = (userId?: string): TenantContext => ({
    workspaceId: A,
    companyIds: [],
    ...(userId === undefined ? {} : { userId }),
  });
  const headers = (workspaceId: string, userId: string) =>
    sessionHeaders({ workspaceId, userId, sessionId: `s-${userId.slice(0, 8)}` });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(main.db);
    audit = new AuditLog(main.db);
    const workspaces = new WorkspaceRepository(main.db);
    const users = new UserRepository(main.db);
    const memberships = new MembershipRepository(main.db);
    for (const [ws, user, role] of [
      [A, admin, 'admin'],
      [A, child, 'member'],
      [B, outsider, 'admin'],
    ] as const) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: user }, async (c) => {
        if ((await workspaces.get(c)) === undefined) {
          await workspaces.create(c, { name: `Workspace ${ws.slice(0, 4)}` });
        }
        await users.create(c, { id: user, email: `${user}@example.test`, name: `User ${role}` });
        await memberships.add(c, { userId: user, role });
      });
    }
  });

  afterAll(async () => {
    await main.destroy();
    await cluster.container.stop();
  });

  const app = (auditExportLimits?: { rows: number; bytes: number }) =>
    buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      audit,
      ...(auditExportLimits === undefined ? {} : { auditExportLimits }),
      ...stubAuth(),
    });

  const exportEvents = async () =>
    (await audit.list(ctx(admin), { action: 'audit_log.exported' }, { limit: 200 })).items;

  it('[AUD-4] child user gets 403 on audit routes', async () => {
    const server = app();
    const before = (await exportEvents()).length;
    for (const url of ['/api/audit-events', '/api/audit-events/export']) {
      // A member of the workspace who is not an admin, and a user of another workspace.
      const asChild = await server.inject({ method: 'GET', url, headers: headers(A, child) });
      expect({ url, status: asChild.statusCode }).toEqual({ url, status: 403 });
      const asOutsider = await server.inject({
        method: 'GET',
        url,
        headers: headers(A, outsider),
      });
      // Not a member of A at all: refused before any role check (USR-8).
      expect({ url, status: asOutsider.statusCode }).toEqual({ url, status: 401 });
      expect(asChild.body).not.toContain('audit_log');
    }
    // A refused export leaves no trace of an export.
    expect(await exportEvents()).toHaveLength(before);
    await server.close();
  });

  it('[AUD-4] admins list events with filters, newest first, page by page', async () => {
    const entityId = randomUUID();
    for (const user of [admin, child, child]) {
      await audit.record(ctx(user), {
        action: 'catalogue.changed',
        actor: { kind: 'user', userId: user },
        entityId,
        before: { status: 'draft' },
        after: { status: 'live' },
      });
    }
    const server = app();
    const get = (query: string) =>
      server.inject({
        method: 'GET',
        url: `/api/audit-events?${query}`,
        headers: headers(A, admin),
      });

    const byUser = await get(`entity_id=${entityId}&user_id=${child}`);
    expect(byUser.statusCode).toBe(200);
    expect(byUser.json<Page>().items.map((e) => e.user_id)).toEqual([child, child]);

    const first = (await get(`entity_id=${entityId}&limit=2`)).json<Page>();
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = (
      await get(`entity_id=${entityId}&limit=2&cursor=${first.next_cursor ?? ''}`)
    ).json<Page>();
    expect(second.items.map((e) => e.user_id)).toEqual([admin]);
    expect(second.next_cursor).toBeNull();

    const none = await get(
      `entity_id=${entityId}&from=${new Date(Date.now() + 60_000).toISOString()}`,
    );
    expect(none.json<Page>().items).toEqual([]);
    expect((await get('action=not.an_action')).statusCode).toBe(400);
    // A page larger than the list cap is refused, never silently cut (CAP-7).
    const tooMany = await get('limit=201');
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toMatchObject({ code: 'validation_failed' });
    expect((await get('cursor=bm9wZQ')).statusCode).toBe(400);
    await server.close();
  });

  it('[AUD-2][AUD-4] export is itself audited', async () => {
    const entityId = randomUUID();
    await audit.record(ctx(admin), {
      action: 'vat_quarter.unlocked',
      actor: { kind: 'user', userId: admin },
      entityId,
      after: { period: '2026-Q1' },
      reason: '=1+1 late fee',
    });
    const server = app();
    const res = await server.inject({
      method: 'GET',
      url: `/api/audit-events/export?entity_id=${entityId}`,
      headers: headers(A, admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const lines = res.body.split('\r\n');
    expect(lines[0]?.startsWith(`${UTF8_BOM}occurred_at_utc,`)).toBe(true);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"vat_quarter.unlocked"');
    // A formula in a typed reason never runs in a spreadsheet.
    expect(lines[1]).toContain(`"'=1+1 late fee"`);

    const exported = (await exportEvents()).find((e) => e.after?.entity_id === entityId);
    expect(exported).toMatchObject({
      actorKind: 'user',
      userId: admin,
      entityType: 'audit_log',
      after: { entity_id: entityId, row_count: 1 },
      ip: '127.0.0.1',
    });
    await server.close();
  });

  it('[AUD-4] an export larger than the cap is a 400 validation_failed, and not audited', async () => {
    const entityId = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await audit.record(ctx(admin), {
        action: 'export.created',
        actor: { kind: 'user', userId: admin },
        entityId,
        after: { kind: 'orders', row_count: i },
      });
    }
    const before = (await exportEvents()).length;
    const server = app({ rows: 2, bytes: 1_000_000 });
    const res = await server.inject({
      method: 'GET',
      url: `/api/audit-events/export?entity_id=${entityId}`,
      headers: headers(A, admin),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ location: 'query', path: 'from' }],
    });
    await server.close();
    // The bytes cap bounds memory whatever the row count.
    const small = app({ rows: 1_000, bytes: 400 });
    const big = await small.inject({
      method: 'GET',
      url: `/api/audit-events/export?entity_id=${entityId}`,
      headers: headers(A, admin),
    });
    expect(big.statusCode).toBe(400);
    expect(big.json()).toMatchObject({ code: 'validation_failed' });
    expect(await exportEvents()).toHaveLength(before);
    await small.close();
  });

  it('[AUD-4] no route can edit or delete the audit log', () => {
    const auditRoutes = contractRoutes.filter((r) => r.path.startsWith('/audit-events'));
    expect(auditRoutes.length).toBeGreaterThan(0);
    for (const route of auditRoutes) {
      expect(route).toMatchObject({ method: 'GET', adminOnly: true, tab: 'audit-log' });
    }
  });
});
