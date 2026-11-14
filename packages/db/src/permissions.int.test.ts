import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NotAMember, type TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthStore } from './auth.ts';
import { LastAdmin } from './errors.ts';
import { migrateMain } from './migrate.ts';
import {
  ACCESS_REVIEW_INTERVAL_MS,
  AccessReviewRepository,
  InviteRepository,
  MemberAccessRepository,
} from './permissions.ts';
import { createMainDb, type MainDbHandle } from './pool.ts';
import { CompanyRepository } from './companies.ts';
import { WorkspaceRepository } from './workspaces.ts';
import { Tenancy } from './tenant.ts';
import { MembershipRepository, UserRepository } from './users.ts';

const HOUR = 60 * 60_000;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

describe('roles, ticks and invites (T-0204)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let tenancy: Tenancy;
  let store: AuthStore;
  const ws = randomUUID();
  const admin = randomUUID();
  const companies: string[] = [];
  const t0 = new Date('2026-11-16T09:00:00.000Z');
  const ctx = (userId = admin): TenantContext => ({ workspaceId: ws, companyIds: [], userId });

  /** An invite with a token the test holds, as the worker would mail it. */
  async function invite(input: {
    email: string;
    role: 'admin' | 'member';
    tabs?: string[];
    companyIds?: string[];
  }) {
    const token = randomBytes(32);
    await tenancy.runWorkspace({ workspaceId: ws, userId: admin }, async (c) => {
      const repo = new InviteRepository(main.db);
      const created = await repo.create(c, { tabs: [], companyIds: [], ...input }, t0);
      await repo.setToken(c, created.id, sha256(token));
    });
    return sha256(token);
  }

  const scopeOf = (userId: string) =>
    tenancy.runMember({ workspaceId: ws, userId }, (c, access) =>
      Promise.resolve({ access, companyIds: c.companyIds }),
    );

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(main.db);
    store = new AuthStore(main.db);
    await tenancy.run(ctx(), async (c) => {
      await new WorkspaceRepository(main.db).create(c, { name: 'Permissions test' });
      await new UserRepository(main.db).create(c, {
        id: admin,
        email: `${admin.slice(0, 8)}@example.test`,
        name: 'Ada Admin',
      });
      await new MembershipRepository(main.db).add(c, { userId: admin, role: 'admin' });
    });
    for (const name of ['One', 'Two', 'Three']) {
      const id = await tenancy.runWorkspace({ workspaceId: ws }, (c) =>
        new CompanyRepository(main.db).create(c, {
          legalName: `${name} Ltd`,
          tradingName: name,
          registeredAddress: { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' },
        }),
      );
      companies.push(id);
    }
  });

  afterAll(async () => {
    await main.destroy();
    await cluster.container.stop();
  });

  it('[PERM-6] new child has no tabs and no companies', async () => {
    const token = await invite({ email: 'new.child@example.test', role: 'member' });
    const accepted = await store.acceptInvite(token, randomUUID(), 'Nia Child', t0);
    expect(accepted?.created).toBe(true);
    const { access, companyIds } = await scopeOf(accepted?.userId ?? '');
    expect(access).toEqual({ role: 'member', tabs: [] });
    expect(companyIds).toEqual([]);
  });

  it('[PERM-3][TEN-5] a child sees only the ticked companies; an admin sees them all', async () => {
    const token = await invite({
      email: 'ticked@example.test',
      role: 'member',
      tabs: ['orders'],
      companyIds: [companies[0] ?? ''],
    });
    const accepted = await store.acceptInvite(token, randomUUID(), 'Tia Ticked', t0);
    const child = accepted?.userId ?? '';
    expect(await scopeOf(child)).toEqual({
      access: { role: 'member', tabs: ['orders'] },
      companyIds: [companies[0]],
    });
    // RLS follows the scope: the child's company list holds one company.
    const seen = await tenancy.runMember({ workspaceId: ws, userId: child }, (c) =>
      new CompanyRepository(main.db).list(c),
    );
    expect(seen.map((c) => c.id)).toEqual([companies[0]]);
    expect((await scopeOf(admin)).companyIds).toHaveLength(3);
    expect((await scopeOf(admin)).access).toEqual({ role: 'admin', tabs: 'all' });
  });

  it('[PERM-2][USR-8] changed ticks apply to the next transaction, and a removed member is not one', async () => {
    const token = await invite({ email: 'changes@example.test', role: 'member', tabs: ['orders'] });
    const user = (await store.acceptInvite(token, randomUUID(), 'Cai Change', t0))?.userId ?? '';
    const access = new MemberAccessRepository(main.db);
    await tenancy.runMember({ workspaceId: ws, userId: admin }, (c) =>
      access.set(c, user, { role: 'member', tabs: ['shipping', 'notes'], companyIds: companies }),
    );
    expect((await scopeOf(user)).access.tabs).toEqual(['notes', 'shipping']);
    expect(
      await tenancy.runMember({ workspaceId: ws, userId: admin }, (c) => access.remove(c, user)),
    ).toBe(true);
    await expect(scopeOf(user)).rejects.toBeInstanceOf(NotAMember);
  });

  it('[PERM-7] last admin cannot be removed or demoted', async () => {
    const access = new MemberAccessRepository(main.db);
    const asAdmin = <T>(fn: (c: TenantContext) => Promise<T>) =>
      tenancy.runMember({ workspaceId: ws, userId: admin }, (c) => fn(c));
    await expect(asAdmin((c) => access.remove(c, admin))).rejects.toBeInstanceOf(LastAdmin);
    await expect(
      asAdmin((c) => access.set(c, admin, { role: 'member', tabs: [], companyIds: [] })),
    ).rejects.toBeInstanceOf(LastAdmin);
    // With a second admin, the first may step down.
    const token = await invite({ email: 'second.admin@example.test', role: 'admin' });
    const second = (await store.acceptInvite(token, randomUUID(), 'Sol Second', t0))?.userId ?? '';
    expect(
      await asAdmin((c) => access.set(c, second, { role: 'admin', tabs: [], companyIds: [] })),
    ).toBe(true);
    await expect(
      tenancy.runMember({ workspaceId: ws, userId: second }, (c) =>
        access.set(c, second, { role: 'member', tabs: [], companyIds: [] }),
      ),
    ).resolves.toBe(true);
  });

  it('[TEN-7] invite expires after 72 hours', async () => {
    const token = await invite({ email: 'late@example.test', role: 'member' });
    expect(await store.findInvite(token, new Date(t0.getTime() + 71 * HOUR))).toMatchObject({
      email: 'late@example.test',
      workspaceName: 'Permissions test',
      userExists: false,
    });
    const late = new Date(t0.getTime() + 72 * HOUR);
    expect(await store.findInvite(token, late)).toBeUndefined();
    expect(await store.acceptInvite(token, randomUUID(), 'Lou Late', late)).toBeUndefined();
  });

  it('[USR-1] an invite works once, and a revoked one not at all', async () => {
    const once = await invite({ email: 'once@example.test', role: 'member' });
    expect(await store.acceptInvite(once, randomUUID(), 'Oz Once', t0)).toBeDefined();
    expect(await store.acceptInvite(once, randomUUID(), 'Oz Once', t0)).toBeUndefined();

    const token = randomBytes(32);
    const revoked = await tenancy.runWorkspace({ workspaceId: ws, userId: admin }, async (c) => {
      const repo = new InviteRepository(main.db);
      const created = await repo.create(
        c,
        { email: 'revoked@example.test', role: 'member', tabs: [], companyIds: [] },
        t0,
      );
      await repo.setToken(c, created.id, sha256(token));
      return repo.revoke(c, created.id, t0);
    });
    expect(revoked).toBe(true);
    expect(await store.findInvite(sha256(token), t0)).toBeUndefined();
  });

  it('[USR-9] an access review falls due every 90 days and is completed once', async () => {
    const reviews = new AccessReviewRepository(main.db);
    const asAdmin = <T>(fn: (c: TenantContext) => Promise<T>) =>
      tenancy.runWorkspace({ workspaceId: ws, userId: admin }, (c) => fn(c));
    const first = await asAdmin((c) => reviews.ensureDue(c, t0));
    expect(first).toBeDefined();
    expect(
      await asAdmin((c) => reviews.ensureDue(c, new Date(t0.getTime() + 89 * 24 * HOUR))),
    ).toBe(undefined);
    expect(
      await asAdmin((c) =>
        reviews.ensureDue(c, new Date(t0.getTime() + ACCESS_REVIEW_INTERVAL_MS)),
      ),
    ).toBeDefined();
    expect(await asAdmin((c) => reviews.complete(c, first?.id ?? '', admin, t0))).toBe(true);
    expect(await asAdmin((c) => reviews.complete(c, first?.id ?? '', admin, t0))).toBe(false);
  });
});
