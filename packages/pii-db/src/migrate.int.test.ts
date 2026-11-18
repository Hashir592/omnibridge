import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePii } from './migrate.ts';
import { runSqlMigrations } from './sql-migrations.ts';

const OWNER = 'vault_owner';
const ROLES = ['vault_owner', 'vault_app'] as const;

describe('db-pii roles and migrations', () => {
  let cluster: RoleCluster;
  // One pool per role: the roles script caps each role's connections (T-0207).
  const pools = new Map<string, pg.Pool>();
  const pool = (role: string) => {
    const open = pools.get(role);
    if (open !== undefined) return open;
    const p = new pg.Pool({ ...cluster.connection(role), max: 2 });
    pools.set(role, p);
    return p;
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-pii', 'omnibridge_pii', ROLES);
  });

  afterAll(async () => {
    await Promise.all([...pools.values()].map((p) => p.end()));
    await cluster.container.stop();
  });

  it('[NFR-2] vault_app has no BYPASSRLS, superuser or DDL rights', async () => {
    const { rows } = await pool('vault_owner').query<{
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
    }>(`SELECT rolbypassrls, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = 'vault_app'`);
    expect(rows).toEqual([{ rolbypassrls: false, rolsuper: false, rolcreatedb: false }]);
  });

  it('[NFR-2] forward-only migrations apply once as vault_owner', async () => {
    const owner = cluster.connection('vault_owner');
    expect((await migratePii(owner)).applied).toEqual([
      '0001_baseline',
      '0002_vault_core',
      '0003_deletion',
      '0004_closed_workspaces',
    ]);
    expect((await migratePii(owner)).applied).toEqual([]);
  });

  it('[NFR-2] vault_app uses vault tables but cannot create its own', async () => {
    await pool('vault_owner').query('CREATE TABLE vault.skeleton_probe (id int PRIMARY KEY)');
    const app = pool('vault_app');
    await app.query('INSERT INTO vault.skeleton_probe (id) VALUES (1)');
    await expect(app.query('CREATE TABLE vault.not_allowed (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  // ADR-047
  it('[NFR-2] a no-transaction migration runs CONCURRENTLY index statements, a repeat is a no-op, and a failed build is repaired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ob-migrations-'));
    const write = (name: string, text: string) => writeFile(join(dir, name), text);
    await write(
      '0001_table.sql',
      `CREATE TABLE public.nt_probe (id int PRIMARY KEY, v int);
INSERT INTO public.nt_probe VALUES (1, 1), (2, 1);
`,
    );
    await write(
      '0002_index.sql',
      `-- migrate: no-transaction
SET lock_timeout = '1s';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS nt_probe_v ON public.nt_probe (v);
`,
    );
    await write(
      '0003_after.sql',
      `CREATE TABLE public.nt_after (id int PRIMARY KEY);
`,
    );
    const tables = {
      migrationTableName: 'nt_probe_migration',
      migrationLockTableName: 'nt_probe_migration_lock',
    };
    const valid = async () =>
      (
        await pool(OWNER).query<{ indisvalid: boolean }>(
          `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = 'nt_probe_v'`,
        )
      ).rows.map((r) => r.indisvalid);
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ ...cluster.connection(OWNER), max: 1 }) }),
    });
    try {
      // Duplicate values: the build fails and leaves an invalid index; 0001 stays applied.
      await expect(runSqlMigrations(db, dir, tables)).rejects.toThrow(/0002_index failed/);
      expect(await valid()).toEqual([false]);
      await pool(OWNER).query('UPDATE public.nt_probe SET v = 2 WHERE id = 2');
      // The repeat drops the invalid index and builds it again, then carries on.
      expect((await runSqlMigrations(db, dir, tables)).applied).toEqual([
        '0002_index',
        '0003_after',
      ]);
      expect(await valid()).toEqual([true]);
      expect((await runSqlMigrations(db, dir, tables)).applied).toEqual([]);
      await write(
        '0004_drop.sql',
        `-- migrate: no-transaction
DROP INDEX CONCURRENTLY IF EXISTS public.nt_probe_v;
`,
      );
      expect((await runSqlMigrations(db, dir, tables)).applied).toEqual(['0004_drop']);
      expect(await valid()).toEqual([]);
      // Anything but the allowed statements is refused before it runs.
      await write(
        '0005_bad.sql',
        `-- migrate: no-transaction
DROP TABLE public.nt_after;
`,
      );
      await expect(runSqlMigrations(db, dir, tables)).rejects.toThrow(/ADR-047/);
    } finally {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
