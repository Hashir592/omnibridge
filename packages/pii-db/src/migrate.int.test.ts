import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      '0005_erasure_canary',
      '0006_buyer_exact',
      '0007_security_log_retention',
      '0008_order_ingest',
      '0009_order_subject_index',
      '0010_deleted_buyer_date',
      '0011_vault_wide_deleted_buyers',
      '0012_retire_deleted_buyers',
      '0013_maintenance_done',
    ]);
    expect((await migratePii(owner)).applied).toEqual([]);
  });

  // ADR-085 (2): retired, not dropped. The drop comes with M22's first db-pii migration.
  it('[NFR-2][DEL-1] no role can use the retired vault.deleted_buyers, and no code names it', async () => {
    await migratePii(cluster.connection(OWNER));
    const { rows } = await pool(OWNER).query<{ rolname: string; priv: string }>(
      `SELECT r.rolname, p.priv
         FROM pg_roles r
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                'REFERENCES', 'TRIGGER']) AS p(priv)
        WHERE r.rolname NOT LIKE 'pg\\_%' AND NOT r.rolsuper
          AND (has_table_privilege(r.oid, 'vault.deleted_buyers', p.priv)
               OR (p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                   AND has_any_column_privilege(r.oid, 'vault.deleted_buyers', p.priv)))
        ORDER BY 1, 2`,
    );
    expect(rows).toEqual([]);
    await expect(pool('vault_app').query('SELECT 1 FROM vault.deleted_buyers')).rejects.toThrow(
      /permission denied/,
    );
    // Only the migrations that made and retire it may name it.
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const self = fileURLToPath(import.meta.url);
    const skip = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo']);
    const named: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skip.has(entry.name) && path !== join(root, 'packages', 'pii-db', 'migrations')) {
            await walk(path);
          }
        } else if (/\.(ts|tsx|js|mjs|cjs|sql|sh|json|ya?ml)$/.test(entry.name) && path !== self) {
          if (/\bvault\.deleted_buyers\b/.test(await readFile(path, 'utf8'))) named.push(path);
        }
      }
    };
    for (const top of ['apps', 'packages', 'infra', 'scripts', 'mocks', 'tests']) {
      await walk(join(root, top)).catch((err: unknown) => {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      });
    }
    expect(named).toEqual([]);
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
