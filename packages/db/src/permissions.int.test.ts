import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { NotAMember, type TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
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
import { JobRecordRepository } from './job-records.ts';
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
    const accepted = await store.acceptInvite(token, randomUUID(), 'Nia Child', t0, true);
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
    const accepted = await store.acceptInvite(token, randomUUID(), 'Tia Ticked', t0, true);
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
    const user =
      (await store.acceptInvite(token, randomUUID(), 'Cai Change', t0, true))?.userId ?? '';
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
    const second =
      (await store.acceptInvite(token, randomUUID(), 'Sol Second', t0, true))?.userId ?? '';
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
    expect(await store.acceptInvite(token, randomUUID(), 'Lou Late', late, true)).toBeUndefined();
  });

  it('[USR-1] with no password checked, an invite never joins an email that already has a sign-in', async () => {
    // The admin's own email: an account exists, so only the password-confirmed path may join it.
    const other = randomUUID();
    await tenancy.run({ workspaceId: ws, companyIds: [], userId: other }, (c) =>
      new UserRepository(main.db).create(c, {
        id: other,
        email: 'already@example.test',
        name: 'Al Ready',
      }),
    );
    const token = await invite({ email: 'already@example.test', role: 'member' });
    expect(await store.acceptInvite(token, randomUUID(), 'Intruder', t0, true)).toBeUndefined();
    // Confirmed with their password (newOnly false), the same person joins.
    expect(await store.acceptInvite(token, randomUUID(), 'Al Ready', t0, false)).toMatchObject({
      userId: other,
      created: false,
    });
  });

  it('[USR-1] an invite works once, and a revoked one not at all', async () => {
    const once = await invite({ email: 'once@example.test', role: 'member' });
    expect(await store.acceptInvite(once, randomUUID(), 'Oz Once', t0, true)).toBeDefined();
    expect(await store.acceptInvite(once, randomUUID(), 'Oz Once', t0, true)).toBeUndefined();

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

  /** Runs `fn` as raw ob_app in one rolled-back transaction, in `userId`'s request context. */
  async function asRawRequest<T>(
    userId: string,
    companyIds: string[],
    fn: (c: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const pool = new pg.Pool({ ...cluster.connection('ob_app'), max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.company_ids', $3, true)`,
        [ws, userId, `{${companyIds.join(',')}}`],
      );
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await pool.end();
    }
  }

  it('[PERM-3][PERM-5] a child cannot make itself admin, tick itself a tab or invite, even by raw SQL', async () => {
    // F-M02e-01: the database refuses what only app code refused before.
    const token = await invite({ email: 'raw.child@example.test', role: 'member' });
    const child =
      (await store.acceptInvite(token, randomUUID(), 'Rae Raw', t0, true))?.userId ?? '';
    const rlsError = /row-level security/;
    await asRawRequest(child, [], async (c) => {
      const promoted = await c.query(
        `UPDATE app.memberships SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`,
        [ws, child],
      );
      expect(promoted.rowCount).toBe(0);
    });
    await expect(
      asRawRequest(child, [], (c) =>
        c.query(
          `INSERT INTO app.membership_tabs (workspace_id, user_id, tab) VALUES ($1, $2, 'finance')`,
          [ws, child],
        ),
      ),
    ).rejects.toThrow(rlsError);
    await expect(
      asRawRequest(child, [companies[0] ?? ''], (c) =>
        c.query(
          `INSERT INTO app.membership_companies (workspace_id, user_id, company_id) VALUES ($1, $2, $3)`,
          [ws, child, companies[0]],
        ),
      ),
    ).rejects.toThrow(rlsError);
    await expect(
      asRawRequest(child, [], (c) =>
        c.query(
          `INSERT INTO app.invites (workspace_id, id, email, role, tabs, company_ids, invited_by, created_at, expires_at)
           VALUES ($1, $2, 'evil@example.test', 'admin', '{}', '{}', $3, now(), now() + interval '1 hour')`,
          [ws, randomUUID(), child],
        ),
      ),
    ).rejects.toThrow(rlsError);
    await asRawRequest(child, [], async (c) => {
      const removed = await c.query(
        `DELETE FROM app.memberships WHERE workspace_id = $1 AND user_id = $2`,
        [ws, admin],
      );
      expect(removed.rowCount).toBe(0);
    });
    // The same raw write as an admin goes through (then rolls back).
    await asRawRequest(admin, [], async (c) => {
      const res = await c.query(
        `INSERT INTO app.membership_tabs (workspace_id, user_id, tab) VALUES ($1, $2, 'finance')`,
        [ws, child],
      );
      expect(res.rowCount).toBe(1);
    });
    expect((await scopeOf(child)).access).toEqual({ role: 'member', tabs: [] });
  });

  it('[PERM-3] a job tied to a company is shown only with that company in scope', async () => {
    // F-M02e-03: GET /jobs/:id is tab none, so the row itself carries the company scope.
    const token = await invite({
      email: 'jobs.child@example.test',
      role: 'member',
      companyIds: [companies[1] ?? ''],
    });
    const child =
      (await store.acceptInvite(token, randomUUID(), 'Jo Jobs', t0, true))?.userId ?? '';
    const jobs = new JobRecordRepository(main.db);
    const id = randomUUID();
    await tenancy.runMember({ workspaceId: ws, userId: admin }, (c) =>
      jobs.createAndEnqueue(
        c,
        { id, type: 'test.company_job', idempotencyKey: id, companyId: companies[0] ?? '' },
        () => Promise.resolve(),
      ),
    );
    const asChild = await tenancy.runMember({ workspaceId: ws, userId: child }, (c) =>
      jobs.get(c, id),
    );
    expect(asChild).toBeUndefined();
    const asAdmin = await tenancy.runMember({ workspaceId: ws, userId: admin }, (c) =>
      jobs.get(c, id),
    );
    expect(asAdmin?.id).toBe(id);
  });

  it('[USR-1][USR-3] a new person joins and gets a password in one call, or neither happens', async () => {
    // F-M02e-04: a failing password write leaves the invite unused.
    const token = await invite({ email: 'atomic@example.test', role: 'member' });
    await expect(
      store.acceptInviteNewUser(token, randomUUID(), 'Ati Atomic', t0, 'not-argon2'),
    ).rejects.toThrow();
    expect(await store.findInvite(token, t0)).toMatchObject({ email: 'atomic@example.test' });
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$atomic';
    const joined = await store.acceptInviteNewUser(token, randomUUID(), 'Ati Atomic', t0, hash);
    expect(joined).toBeDefined();
    expect((await store.loginLookup('atomic@example.test'))?.passwordHash).toBe(hash);
    expect(
      await store.acceptInviteNewUser(token, randomUUID(), 'Ati Atomic', t0, hash),
    ).toBeUndefined();
  });
});
