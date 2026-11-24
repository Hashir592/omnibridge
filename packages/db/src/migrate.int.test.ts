import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateMain } from './migrate.ts';
import { runSqlMigrations } from './sql-migrations.ts';

const OWNER = 'ob_owner';
const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;

describe('db-main roles and migrations', () => {
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
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
  });

  afterAll(async () => {
    await Promise.all([...pools.values()].map((p) => p.end()));
    await cluster.container.stop();
  });

  it('[NFR-2] ob_app and ob_platform have no BYPASSRLS, superuser or DDL rights', async () => {
    const { rows } = await pool('ob_owner').query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `SELECT rolname, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [[...ROLES]],
    );
    expect(rows.map((r) => r.rolname)).toEqual(['ob_app', 'ob_owner', 'ob_platform']);
    for (const row of rows) {
      expect(row).toMatchObject({
        rolbypassrls: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
    }
  });

  it('[NFR-2] forward-only migrations apply once as ob_owner', async () => {
    const owner = cluster.connection('ob_owner');
    expect((await migrateMain(owner)).applied).toEqual([
      '0001_baseline',
      '0002_credentials',
      '0003_job_records',
      '0004_files',
      '0005_credentials_delete_after',
      '0006_files_state_guard',
      '0007_tenancy',
      '0008_workspace_fks',
      '0009_validate_workspace_fks',
      '0010_audit_events',
      '0011_auth',
      '0012_reset_requests',
      '0013_role_split',
      '0014_terms_acceptances',
      '0015_permissions',
      '0016_housekeeping',
      '0017_housekeeping_indexes',
      '0018_auth_audit_fixes',
      '0019_workspace_modules',
      '0020_retire_rollout_functions',
      '0021_m02_end_fixes',
      '0022_validate_job_company',
      '0023_drop_retired_functions',
      '0024_deletion',
      '0025_erasure_requests',
      '0026_erasure_withdraw',
      '0027_validate_erasure_states',
      '0028_erasure_outcome',
      '0029_validate_erasure_outcome',
      '0030_notifications',
      '0031_notification_email',
      '0032_security_signals',
      '0033_platform_console',
      '0034_app_secrets',
      '0035_platform_signin_alerts',
      '0036_validate_auth_events_action',
      '0037_integration_framework',
      '0038_validate_integration_framework',
      '0039_outbound_governors',
      '0040_validate_outbound_governors',
      '0041_m05_minors',
      '0042_catalogue',
      '0043_stock_engine',
      '0044_validate_stock_engine',
      '0045_stock_line_reserves',
      '0046_validate_stock_line_reserves',
      '0047_stock_line_reserves_index',
      '0048_orders',
      '0049_order_groups',
      '0050_validate_order_groups',
      '0051_order_group_index',
      '0052_orders_fixed_amounts',
    ]);
    expect((await migrateMain(owner)).applied).toEqual([]);
  });

  it('[NFR-2] ob_app uses tables ob_owner creates but cannot create its own', async () => {
    await pool('ob_owner').query('CREATE TABLE app.skeleton_probe (id int PRIMARY KEY)');
    const app = pool('ob_app');
    await app.query('INSERT INTO app.skeleton_probe (id) VALUES (1)');
    expect((await app.query('SELECT id FROM app.skeleton_probe')).rowCount).toBe(1);
    await expect(app.query('CREATE TABLE app.not_allowed (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query('CREATE TABLE public.not_allowed (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('[NFR-2] the pg-boss schema is owned by ob_owner, with DML only for ob_app', async () => {
    const { rows } = await pool('ob_app').query<{ owner: string; can_create: boolean }>(
      `SELECT pg_get_userbyid(nspowner) AS owner,
              has_schema_privilege('ob_app', oid, 'CREATE') AS can_create
         FROM pg_namespace WHERE nspname = 'pgboss'`,
    );
    expect(rows).toEqual([{ owner: 'ob_owner', can_create: false }]);
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
