import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePii } from './migrate.ts';

const ROLES = ['vault_owner', 'vault_app'] as const;

describe('db-pii roles and migrations', () => {
  let cluster: RoleCluster;
  const pools: pg.Pool[] = [];
  const pool = (role: string) => {
    const p = new pg.Pool({ ...cluster.connection(role), max: 2 });
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-pii', 'omnibridge_pii', ROLES);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
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
    expect((await migratePii(owner)).applied).toEqual(['0001_baseline']);
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
});
