import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateMain } from './migrate.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;

describe('db-main roles and migrations', () => {
  let cluster: RoleCluster;
  const pools: pg.Pool[] = [];
  const pool = (role: string) => {
    const p = new pg.Pool({ ...cluster.connection(role), max: 2 });
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
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
});
