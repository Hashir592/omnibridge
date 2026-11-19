import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPiiPool } from './pool.ts';

const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

// A-005 (ADR-069): a db-pii connection ended by the server (a restart, a terminated backend)
// must reach a handler, never become an uncaught exception that takes the vault down. Vitest
// fails the run on any uncaught exception, so these tests also prove there was none.
describe('db-pii pool errors (A-005)', () => {
  let cluster: RoleCluster;
  let admin: pg.Pool;

  beforeAll(async () => {
    cluster = await startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']);
    admin = new pg.Pool({
      host: cluster.container.getHost(),
      port: cluster.container.getPort(),
      database: cluster.database,
      user: cluster.container.getUsername(),
      password: cluster.container.getPassword(),
      max: 1,
    });
  });

  afterAll(async () => {
    await admin.end();
    await cluster.container.stop();
  });

  const terminate = (name: string) =>
    admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [name],
    );

  it('[DEL-1] the vault survives a terminated idle connection and reconnects', async () => {
    const errors: Error[] = [];
    const name = 'a005-idle';
    const pool = createPiiPool(
      { ...cluster.connection('vault_app'), max: 2, application_name: name },
      (err) => {
        errors.push(err);
      },
    );
    try {
      await pool.query('SELECT 1'); // leaves one idle client in the pool
      await terminate(name);
      await until(() => errors.length > 0);
      expect(errors[0]?.message).toMatch(/terminat/i);
      expect((await pool.query<{ ok: number }>('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });

  it('[DEL-1] a terminated checked-out client reports to the handler, not the process', async () => {
    const errors: Error[] = [];
    const name = 'a005-busy';
    const pool = createPiiPool(
      { ...cluster.connection('vault_app'), max: 2, application_name: name },
      (err) => {
        errors.push(err);
      },
    );
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      await terminate(name);
      await until(() => errors.length > 0);
      expect(errors[0]?.message).toMatch(/terminat/i);
    } finally {
      client.release(true);
    }
    try {
      expect((await pool.query<{ ok: number }>('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });
});
