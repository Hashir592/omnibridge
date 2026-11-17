import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChannelAccountCompanyLocked,
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceLimitReached,
  WorkspaceRepository,
  type MainDbHandle,
  type NewCompany,
} from './index.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_worker', 'ob_platform'] as const;

/** The tables M01 created before the workspace table existed (S4, M01 end). */
const M01_TENANT_TABLES = [
  'app.credentials',
  'app.data_keys',
  'app.files',
  'app.job_leases',
  'app.job_records',
];

const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const company = (name: string, extra: Partial<NewCompany> = {}): NewCompany => ({
  legalName: `${name} Ltd`,
  tradingName: name,
  registeredAddress: address,
  ...extra,
});

describe('tenancy core (TEN-1, TEN-2, TEN-3, TEN-6, TEN-10)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let tenancy: Tenancy;
  let workspaces: WorkspaceRepository;
  let companies: CompanyRepository;
  let accounts: ChannelAccountRepository;
  let users: UserRepository;
  let memberships: MembershipRepository;
  const pools: pg.Pool[] = [];
  const raw = (role: string) => {
    const pool = new pg.Pool({ ...cluster.connection(role), max: 2 });
    pools.push(pool);
    return pool;
  };

  const A = randomUUID();
  const B = randomUUID();
  const ids = { a1: '', a2: '', b1: '', accountA: '', userA1: '', userA2: '', userB: '' };
  const none = (workspaceId: string): TenantContext => ({ workspaceId, companyIds: [] });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(main.db);
    workspaces = new WorkspaceRepository(main.db);
    companies = new CompanyRepository(main.db);
    accounts = new ChannelAccountRepository(main.db);
    users = new UserRepository(main.db);
    memberships = new MembershipRepository(main.db);

    await tenancy.run(none(A), (ctx) => workspaces.create(ctx, { name: 'Workspace A' }));
    await tenancy.run(none(B), (ctx) => workspaces.create(ctx, { name: 'WSB-MARKER workspace' }));
    ids.a1 = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      companies.create(ctx, company('Alpha')),
    );
    ids.a2 = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      companies.create(ctx, company('Bravo')),
    );
    ids.b1 = await tenancy.runWorkspace({ workspaceId: B }, (ctx) =>
      companies.create(ctx, company('WSB-MARKER company')),
    );
    ids.accountA = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      accounts.create(ctx, { companyId: ids.a1, provider: 'amazon', displayName: 'A seller' }),
    );
    await tenancy.runWorkspace({ workspaceId: B }, (ctx) =>
      accounts.create(ctx, { companyId: ids.b1, provider: 'ebay', displayName: 'WSB-MARKER' }),
    );
    for (const [key, ws] of [
      ['userA1', A],
      ['userA2', A],
      ['userB', B],
    ] as const) {
      const id = randomUUID();
      ids[key] = id;
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: id }, async (ctx) => {
        await users.create(ctx, { id, email: `${key.toLowerCase()}@example.test`, name: key });
        await memberships.add(ctx, { userId: id, role: 'admin' });
      });
    }
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await main.destroy();
    await cluster.container.stop();
  });

  it('[TEN-1] rls-coverage: every workspace_id table is forced RLS', async () => {
    const owner = raw('ob_owner');
    // Every table outside the system and queue schemas (pg-boss tables carry no RLS, ADR-009).
    const { rows: tables } = await owner.query<{
      name: string;
      rls: boolean;
      forced: boolean;
      has_workspace: boolean;
      has_company: boolean;
      workspace_policy: boolean;
      company_policy: boolean;
      workspace_fk: boolean;
    }>(`
      SELECT n.nspname || '.' || c.relname AS name,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                       AND a.attname = 'workspace_id' AND NOT a.attisdropped) AS has_workspace,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                       AND a.attname = 'company_id' AND NOT a.attisdropped) AS has_company,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive
                       AND concat(pg_get_expr(p.polqual, p.polrelid),
                                  pg_get_expr(p.polwithcheck, p.polrelid))
                           LIKE '%app.workspace_id%') AS workspace_policy,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive
                       AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_ids%')
               AS company_policy,
             EXISTS (SELECT 1 FROM pg_constraint k
                       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                      WHERE k.conrelid = c.oid AND k.contype = 'f'
                        AND k.confrelid = 'app.workspaces'::regclass
                        AND a.attname = 'workspace_id') AS workspace_fk
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pgboss')
         AND n.nspname NOT LIKE 'pg\\_%'
       ORDER BY 1`);

    const tenant = tables.filter((t) => t.has_workspace);
    expect(tenant.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        ...M01_TENANT_TABLES,
        'app.channel_accounts',
        'app.companies',
        'app.memberships',
      ]),
    );
    for (const t of tenant) {
      expect({
        table: t.name,
        ok: t.rls && t.forced && t.workspace_policy && t.workspace_fk,
      }).toEqual({ table: t.name, ok: true });
    }
    // Every table of the app schema has forced RLS, including those without workspace_id.
    for (const t of tables.filter((x) => x.name.startsWith('app.'))) {
      expect({ table: t.name, rls: t.rls, forced: t.forced }).toEqual({
        table: t.name,
        rls: true,
        forced: true,
      });
    }
    // Company data has a restrictive policy on the explicit company list.
    for (const t of tables.filter((x) => x.has_company || x.name === 'app.companies')) {
      expect({ table: t.name, company_policy: t.company_policy }).toEqual({
        table: t.name,
        company_policy: true,
      });
    }

    // Foreign keys between tenant tables are composite and include workspace_id (invariant 1).
    const { rows: fks } = await owner.query<{ name: string; table: string; ok: boolean }>(`
      SELECT k.conname AS name, k.conrelid::regclass::text AS table,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.conrelid
                       AND a.attnum = ANY (k.conkey) AND a.attname = 'workspace_id') AS ok
        FROM pg_constraint k
       WHERE k.contype = 'f'
         AND k.confrelid <> 'app.workspaces'::regclass
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.conrelid
                       AND a.attname = 'workspace_id')
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.confrelid
                       AND a.attname = 'workspace_id')`);
    expect(fks.length).toBeGreaterThan(0);
    for (const fk of fks) expect(fk).toEqual({ ...fk, ok: true });
  });

  it('[TEN-1] raw SQL as ob_app without SET LOCAL returns zero rows', async () => {
    const app = raw('ob_app');
    const { rows } = await raw('ob_owner').query<{ name: string }>(
      `SELECT 'app.' || c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(10);
    // The seeded tables really hold rows for both workspaces.
    const seen = await tenancy.runWorkspace({ workspaceId: A }, (ctx) => companies.list(ctx));
    expect(seen.length).toBe(2);
    for (const { name } of rows) {
      const { rows: grant } = await app.query<{ readable: boolean }>(
        `SELECT has_table_privilege(current_user, $1, 'SELECT') AS readable`,
        [name],
      );
      if (grant[0]?.readable === true) {
        const res = await app.query<{ n: string }>(`SELECT count(*) AS n FROM ${name}`);
        expect({ table: name, n: res.rows[0]?.n }).toEqual({ table: name, n: '0' });
      } else {
        // The auth tables (migration 0011): no grant at all, reached through definer functions.
        await expect(app.query(`SELECT count(*) FROM ${name}`), name).rejects.toThrow(
          /permission denied/,
        );
      }
    }
    await expect(
      app.query(
        `INSERT INTO app.companies (id, workspace_id, legal_name, trading_name, address_line1,
           address_city, address_postcode) VALUES ($1, $2, 'X', 'X', 'x', 'x', 'X1 1XX')`,
        [randomUUID(), A],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ADR-049, ADR-051
  it('[TEN-1] the tenant policies bind ob_worker too', async () => {
    // ob_worker shares the ob_tenant_rw group with ob_app: the restrictive company policy must
    // still apply to it.
    const client = await raw('ob_worker').connect();
    const count = async (companyIds: string) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT set_config('app.workspace_id', $1, true), set_config('app.company_ids', $2, true)`,
          [A, companyIds],
        );
        const res = await client.query<{ n: string }>('SELECT count(*) AS n FROM app.companies');
        return res.rows[0]?.n;
      } finally {
        await client.query('ROLLBACK');
      }
    };
    try {
      expect(await count('{}')).toBe('0');
      expect(await count(`{${ids.a1}}`)).toBe('1');
      // No SET LOCAL at all: nothing, as for ob_app.
      const none = await client.query<{ n: string }>('SELECT count(*) AS n FROM app.companies');
      expect(none.rows[0]?.n).toBe('0');
    } finally {
      client.release();
    }
  });

  it('[TEN-1] a tenant transaction sees only its own workspace', async () => {
    const inA = await tenancy.runWorkspace({ workspaceId: A }, async (ctx) => ({
      workspace: await workspaces.get(ctx),
      companies: (await companies.list(ctx)).map((c) => c.id).sort(),
      accounts: (await accounts.list(ctx)).map((a) => a.id),
    }));
    expect(inA.workspace?.id).toBe(A);
    expect(inA.companies).toEqual([ids.a1, ids.a2].sort());
    expect(inA.accounts).toEqual([ids.accountA]);
    expect(JSON.stringify(inA)).not.toContain('WSB-MARKER');
  });

  it('[TEN-1] company scope is an explicit list: unset or empty shows no company rows', async () => {
    const app = raw('ob_app');
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [A]);
      const unset = await client.query('SELECT id FROM app.companies');
      expect(unset.rowCount).toBe(0);
      // A stray value that is not a list of ids fails the query; it never widens the scope.
      await client.query(`SELECT set_config('app.company_ids', '*', true)`);
      await expect(client.query('SELECT id FROM app.companies')).rejects.toThrow(/malformed/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const scoped = (companyIds: string[]) =>
      tenancy.run({ workspaceId: A, companyIds }, async (ctx) =>
        (await companies.list(ctx)).map((c) => c.id),
      );
    expect(await scoped([])).toEqual([]);
    expect(await scoped([ids.a2])).toEqual([ids.a2]);
    // Naming another workspace's company in the list still shows nothing of it.
    expect(await scoped([ids.a1, ids.b1])).toEqual([ids.a1]);
    expect(
      await tenancy.run({ workspaceId: A, companyIds: [ids.a2] }, (ctx) => accounts.list(ctx)),
    ).toEqual([]);
  });

  it('[TEN-1] app.workspace_company_ids() returns only the current workspace companies', async () => {
    const app = raw('ob_app');
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      const unset = await client.query<{ ids: string[] }>(
        'SELECT app.workspace_company_ids() AS ids',
      );
      expect(unset.rows[0]?.ids).toEqual([]);
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [A]);
      const inA = await client.query<{ ids: string[] }>(
        'SELECT app.workspace_company_ids() AS ids',
      );
      expect([...(inA.rows[0]?.ids ?? [])].sort()).toEqual([ids.a1, ids.a2].sort());
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const ctx = await tenancy.runWorkspace({ workspaceId: B }, (c) => Promise.resolve(c));
    expect(ctx.companyIds).toEqual([ids.b1]);
  });

  it('[TEN-1] ob_platform reads the workspace id list and nothing else', async () => {
    const platform = raw('ob_platform');
    const { rows } = await platform.query<{ id: string }>('SELECT id FROM app.workspaces');
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([A, B]));
    await expect(platform.query('SELECT name FROM app.workspaces')).rejects.toThrow(
      /permission denied/,
    );
    for (const table of ['app.companies', 'app.users', 'app.data_keys', 'app.credentials']) {
      await expect(platform.query(`SELECT 1 FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
  });

  it('[TEN-1] users are visible only to themselves and to members of the same workspace', async () => {
    const visible = (ctx: TenantContext) =>
      tenancy.run(ctx, async (c) => (await users.list(c)).map((u) => u.id).sort());
    expect(await visible({ workspaceId: A, companyIds: [], userId: ids.userA1 })).toEqual(
      [ids.userA1, ids.userA2].sort(),
    );
    expect(await visible({ workspaceId: B, companyIds: [] })).toEqual([ids.userB]);
    // Signed in as B's user but in A's context: only themselves and A's members.
    expect(await visible({ workspaceId: A, companyIds: [], userId: ids.userB })).toEqual(
      [ids.userA1, ids.userA2, ids.userB].sort(),
    );
    const app = raw('ob_app');
    await expect(
      app.query('UPDATE app.users SET platform_admin = true WHERE id = $1', [ids.userA1]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `INSERT INTO app.users (id, email, name, platform_admin) VALUES ($1, 'x@example.test', 'x', true)`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('[TEN-2] the first company is fulfilment provider and purchasing company; later ones are not by default', async () => {
    const list = await tenancy.runWorkspace({ workspaceId: A }, (ctx) => companies.list(ctx));
    const first = list.find((c) => c.id === ids.a1);
    const second = list.find((c) => c.id === ids.a2);
    expect(first).toMatchObject({ isFulfilmentProvider: true, isPurchasingCompany: true });
    expect(second).toMatchObject({ isFulfilmentProvider: false, isPurchasingCompany: false });
  });

  it('[TEN-2] flags the caller sets are kept, even on the first company', async () => {
    const W = randomUUID();
    await tenancy.run(none(W), (ctx) => workspaces.create(ctx, { name: 'Explicit flags' }));
    await tenancy.runWorkspace({ workspaceId: W }, (ctx) =>
      companies.create(ctx, company('Seller', { isFulfilmentProvider: false })),
    );
    const [first] = await tenancy.runWorkspace({ workspaceId: W }, (ctx) => companies.list(ctx));
    expect(first).toMatchObject({ isFulfilmentProvider: false, isPurchasingCompany: true });
  });

  it('[TEN-1] a tenant context cannot be used after its transaction has ended', async () => {
    const escaped = await tenancy.runWorkspace({ workspaceId: A }, (ctx) => Promise.resolve(ctx));
    await expect(companies.list(escaped)).rejects.toThrow(/already ended/);
    await expect(tenancy.run(escaped, (ctx) => companies.list(ctx))).rejects.toThrow(
      /already ended/,
    );
  });

  it('[TEN-2] a company holds legal and trading name, numbers, address, VAT stagger, flags and badge', async () => {
    const C = randomUUID();
    await tenancy.run(none(C), (ctx) => workspaces.create(ctx, { name: 'Workspace C' }));
    const id = await tenancy.runWorkspace({ workspaceId: C }, (ctx) =>
      companies.create(
        ctx,
        company('Charlie', {
          companyNumber: '01234567',
          vatNumber: 'GB123456789',
          registeredAddress: { ...address, line2: 'Unit 2', country: 'GB' },
          vatPeriod: 'stagger_2',
          badgeColour: '#AA3300',
        }),
      ),
    );
    const [row] = await tenancy.runWorkspace({ workspaceId: C }, (ctx) => companies.list(ctx));
    expect(row).toEqual({
      id,
      legalName: 'Charlie Ltd',
      tradingName: 'Charlie',
      companyNumber: '01234567',
      vatNumber: 'GB123456789',
      registeredAddress: { ...address, line2: 'Unit 2', country: 'GB' },
      vatPeriod: 'stagger_2',
      isFulfilmentProvider: true,
      isPurchasingCompany: true,
      badgeColour: '#AA3300',
    });
  });

  it('[TEN-3] a channel account cannot change company once it has orders; it can be archived', async () => {
    const inA = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
      tenancy.runWorkspace({ workspaceId: A }, fn);
    const id = await inA((ctx) =>
      accounts.create(ctx, { companyId: ids.a1, provider: 'ebay', displayName: 'A ebay' }),
    );
    await inA((ctx) => accounts.moveToCompany(ctx, id, ids.a2)); // no orders yet: allowed
    await inA((ctx) => accounts.markOrdersSeen(ctx, id));
    await expect(inA((ctx) => accounts.moveToCompany(ctx, id, ids.a1))).rejects.toBeInstanceOf(
      ChannelAccountCompanyLocked,
    );
    await inA((ctx) => accounts.archive(ctx, id));
    const row = (await inA((ctx) => accounts.list(ctx))).find((a) => a.id === id);
    expect(row).toMatchObject({ companyId: ids.a2, archived: true, hasOrders: true });
  });

  it('[TEN-6] workspace defaults: Europe/London, GBP, 20% VAT, PII retention 25 days and read-only', async () => {
    const ws = await tenancy.run(none(A), (ctx) => workspaces.get(ctx));
    expect(ws).toMatchObject({
      id: A,
      plan: 'free_internal',
      timezone: 'Europe/London',
      currency: 'GBP',
      defaultVatRateBp: 2000,
      piiRetentionDays: 25,
    });
    const app = raw('ob_app');
    const client = await app.connect();
    try {
      for (const sql of [
        'UPDATE app.workspaces SET pii_retention_days = 30',
        `UPDATE app.workspaces SET currency = 'EUR'`,
        `UPDATE app.workspaces SET plan = 'paid'`,
      ]) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [A]);
        await expect(client.query(sql)).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('[TEN-10] limits enforced only when set', async () => {
    // Workspace A has no limits: any number of accounts and users.
    for (let i = 0; i < 3; i += 1) {
      await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
        accounts.create(ctx, {
          companyId: ids.a1,
          provider: 'website',
          displayName: `A${String(i)}`,
        }),
      );
    }
    const L = randomUUID();
    await tenancy.run(none(L), (ctx) =>
      workspaces.create(ctx, { name: 'Limited', maxChannelAccounts: 2, maxUsers: 1 }),
    );
    const inL = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
      tenancy.runWorkspace({ workspaceId: L }, fn);
    const co = await inL((ctx) => companies.create(ctx, company('Limited Co')));
    const add = () =>
      inL((ctx) => accounts.create(ctx, { companyId: co, provider: 'amazon', displayName: 'x' }));
    const first = await add();
    await add();
    await expect(add()).rejects.toBeInstanceOf(WorkspaceLimitReached);
    // An archived account no longer counts.
    await inL((ctx) => accounts.archive(ctx, first));
    await add();
    await expect(add()).rejects.toThrow(/max_channel_accounts/);

    const member = async () => {
      const id = randomUUID();
      await tenancy.run({ workspaceId: L, companyIds: [], userId: id }, async (ctx) => {
        await users.create(ctx, { id, email: `${id}@example.test`, name: 'Member' });
        await memberships.add(ctx, { userId: id, role: 'member' });
      });
    };
    await member();
    await expect(member()).rejects.toBeInstanceOf(WorkspaceLimitReached);
  });

  it('[TEN-10] two concurrent sends at the limit: exactly one channel account is created', async () => {
    const W = randomUUID();
    await tenancy.run(none(W), (ctx) =>
      workspaces.create(ctx, { name: 'Race', maxChannelAccounts: 1 }),
    );
    const co = await tenancy.runWorkspace({ workspaceId: W }, (ctx) =>
      companies.create(ctx, company('Race Co')),
    );
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        tenancy.runWorkspace({ workspaceId: W }, (ctx) =>
          accounts.create(ctx, { companyId: co, provider: 'ebay', displayName: 'race' }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
