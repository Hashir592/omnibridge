import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  AccessReviewRepository,
  AuditLog,
  AuthStore,
  CompanyRepository,
  createMainDb,
  InviteRepository,
  MemberAccessRepository,
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

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };

describe('users, ticks and invites over HTTP (T-0204)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let tenancy: Tenancy;
  const A = randomUUID();
  const admin = randomUUID();
  const child = randomUUID();
  const companies: string[] = [];
  const invited: { workspaceId: string; inviteId: string }[] = [];
  const headers = (userId: string) =>
    sessionHeaders({ workspaceId: A, userId, sessionId: `s-${userId.slice(0, 8)}` });
  const asAdmin = <T>(fn: (c: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: A, userId: admin }, fn);

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(main.db);
    for (const [user, role] of [
      [admin, 'admin'],
      [child, 'member'],
    ] as const) {
      await tenancy.run({ workspaceId: A, companyIds: [], userId: user }, async (c) => {
        if ((await new WorkspaceRepository(main.db).get(c)) === undefined) {
          await new WorkspaceRepository(main.db).create(c, { name: 'People test' });
        }
        await new UserRepository(main.db).create(c, {
          id: user,
          email: `${user.slice(0, 8)}@example.test`,
          name: role === 'admin' ? 'Ada Admin' : 'Cy Child',
        });
        await new MembershipRepository(main.db).add(c, { userId: user, role });
      });
    }
    for (const name of ['North', 'South']) {
      companies.push(
        await tenancy.runWorkspace({ workspaceId: A }, (c) =>
          new CompanyRepository(main.db).create(c, {
            legalName: `${name} Ltd`,
            tradingName: name,
            registeredAddress: { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' },
          }),
        ),
      );
    }
    // The child: Orders and the first company only.
    await asAdmin((c) =>
      new MemberAccessRepository(main.db).set(c, child, {
        role: 'member',
        tabs: ['orders'],
        companyIds: [companies[0] ?? ''],
      }),
    );
  });

  afterAll(async () => {
    await main.destroy();
    await cluster.container.stop();
  });

  const app = () =>
    buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      audit: new AuditLog(main.db),
      directory: {
        workspaces: new WorkspaceRepository(main.db),
        companies: new CompanyRepository(main.db),
      },
      ...stubAuth({ OB_ENV: 'test' }),
      people: {
        members: new MemberAccessRepository(main.db),
        invites: new InviteRepository(main.db),
        reviews: new AccessReviewRepository(main.db),
        workspaces: new WorkspaceRepository(main.db),
        store: new AuthStore(main.db),
        notifier: {
          invite: (input) => {
            invited.push(input);
            return Promise.resolve();
          },
        },
        audit: new AuditLog(main.db),
        tenancy,
      },
    });

  it('[PERM-3][TEN-5][AT-2] a child with Orders and one company sees only that company; admin tabs answer 403', async () => {
    const server = app();
    const asChild = await server.inject({
      method: 'GET',
      url: '/companies',
      headers: headers(child),
    });
    expect(asChild.statusCode).toBe(200);
    const seen = asChild.json<{ items: { id: string }[] }>().items.map((c) => c.id);
    expect(seen).toEqual([companies[0]]);
    const asAdminRes = await server.inject({
      method: 'GET',
      url: '/companies',
      headers: headers(admin),
    });
    expect(asAdminRes.json<{ items: unknown[] }>().items).toHaveLength(2);
    for (const url of ['/users', '/access-reviews', '/audit-events']) {
      const res = await server.inject({ method: 'GET', url, headers: headers(child) });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
    await server.close();
  });

  it('[USR-1][PERM-6] an admin invites a named child with nothing ticked; it is audited and mailed', async () => {
    const server = app();
    const res = await server.inject({
      method: 'POST',
      url: '/users/invites',
      headers: headers(admin),
      payload: { email: 'Newcomer@Example.test', role: 'child', tabs: [], companyIds: [] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; email: string; state: string; tabs: string[] }>();
    expect(body).toMatchObject({ email: 'newcomer@example.test', state: 'invited', tabs: [] });
    expect(invited).toContainEqual({ workspaceId: A, inviteId: body.id });
    const list = await server.inject({ method: 'GET', url: '/users', headers: headers(admin) });
    expect(list.json<{ email: string; state: string }[]>()).toContainEqual(
      expect.objectContaining({ email: 'newcomer@example.test', state: 'invited' }),
    );
    const events = await asAdmin((c) => new AuditLog(main.db).list(c, {}, { limit: 50 }));
    expect(events.items.map((e) => e.action)).toContain('user.invited');
    // A company of another workspace cannot be ticked.
    const bad = await server.inject({
      method: 'POST',
      url: '/users/invites',
      headers: headers(admin),
      payload: { email: 'x@example.test', role: 'child', tabs: [], companyIds: [randomUUID()] },
    });
    expect(bad.statusCode).toBe(404);
    await server.close();
  });

  it('[PERM-2] new ticks apply to the very next request', async () => {
    const server = app();
    const put = await server.inject({
      method: 'PUT',
      url: `/users/${child}/access`,
      headers: headers(admin),
      payload: { role: 'child', tabs: ['orders', 'shipping'], companyIds: companies },
    });
    expect(put.statusCode).toBe(204);
    const res = await server.inject({ method: 'GET', url: '/companies', headers: headers(child) });
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(2);
    const users = await server.inject({ method: 'GET', url: '/users', headers: headers(admin) });
    expect(users.json<{ id: string; tabs: string[] }[]>()).toContainEqual(
      expect.objectContaining({ id: child, tabs: ['orders', 'shipping'] }),
    );
    await server.close();
  });

  it('[PERM-7] last admin cannot be removed or demoted', async () => {
    const server = app();
    const remove = await server.inject({
      method: 'DELETE',
      url: `/users/${admin}`,
      headers: headers(admin),
    });
    expect(remove.statusCode).toBe(409);
    const demote = await server.inject({
      method: 'PUT',
      url: `/users/${admin}/access`,
      headers: headers(admin),
      payload: { role: 'child', tabs: [], companyIds: [] },
    });
    expect(demote.statusCode).toBe(409);
    await server.close();
  });

  it('[USR-9] the admin completes the quarterly access review, once, audited', async () => {
    const review = await asAdmin((c) =>
      new AccessReviewRepository(main.db).ensureDue(c, new Date('2026-11-16T09:00:00Z')),
    );
    const server = app();
    const list = await server.inject({
      method: 'GET',
      url: '/access-reviews',
      headers: headers(admin),
    });
    expect(list.json<{ id: string }[]>().map((r) => r.id)).toContain(review?.id);
    const done = await server.inject({
      method: 'POST',
      url: `/access-reviews/${review?.id ?? ''}/complete`,
      headers: headers(admin),
    });
    expect(done.statusCode).toBe(204);
    const again = await server.inject({
      method: 'POST',
      url: `/access-reviews/${review?.id ?? ''}/complete`,
      headers: headers(admin),
    });
    expect(again.statusCode).toBe(404);
    const events = await asAdmin((c) => new AuditLog(main.db).list(c, {}, { limit: 50 }));
    expect(events.items.map((e) => e.action)).toContain('user.access_review_completed');
    await server.close();
  });

  it('[USR-8] removing a user ends their session on the next request', async () => {
    const server = app();
    expect(
      (await server.inject({ method: 'GET', url: '/companies', headers: headers(child) }))
        .statusCode,
    ).toBe(200);
    const removed = await server.inject({
      method: 'DELETE',
      url: `/users/${child}`,
      headers: headers(admin),
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await server.inject({ method: 'GET', url: '/companies', headers: headers(child) }))
        .statusCode,
    ).toBe(401);
    await server.close();
  });
});
