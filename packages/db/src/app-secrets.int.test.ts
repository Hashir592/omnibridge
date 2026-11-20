import { randomUUID } from 'node:crypto';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import { scanDatabaseForMarkers, startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppSecretStore } from './app-secrets.ts';
import { AuthStore } from './auth.ts';
import { migrateMain } from './migrate.ts';
import { PlatformKeys } from './platform-keys.ts';
import { createMainDb, type MainDbHandle } from './pool.ts';

// T-0505 (PLAT-4): the app secrets store. Values are sealed under the platform data key, set and
// listed only by a platform admin with MFA, and read back only through the typed reader.

const MARKER = 'SECRETMARK-';

describe('app secrets store (PLAT-4, SEC-6)', () => {
  let cluster: RoleCluster;
  let web: MainDbHandle;
  let worker: MainDbHandle;
  let root: pg.Pool;
  const keyring = parseKeyring('secrets', generateKekLine(1));
  const admin = randomUUID();
  const notAdmin = randomUUID();
  const now = new Date('2026-11-20T10:00:00Z');

  const store = (db: MainDbHandle) =>
    new AppSecretStore(db.db, new PlatformKeys(new AuthStore(db.db), keyring));

  async function user(id: string, platformAdmin: boolean) {
    await root.query(
      `INSERT INTO app.users (id, email, name, platform_admin) VALUES ($1, $2, 'Operator', $3)`,
      [id, `${id.slice(0, 8)}@example.test`, platformAdmin],
    );
    await root.query(
      `INSERT INTO app.user_auth (user_id, password_hash, password_set_at, totp_secret,
                                  totp_key_version, mfa_confirmed_at)
       VALUES ($1, '$argon2id$synthetic', now(), '\\x00', 1, now())`,
      [id],
    );
  }

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    web = createMainDb({ ...cluster.connection('ob_app'), max: 2 });
    worker = createMainDb({ ...cluster.connection('ob_worker'), max: 2 });
    await user(admin, true);
    await user(notAdmin, false);
  });

  afterAll(async () => {
    await root.end();
    await web.destroy();
    await worker.destroy();
    await cluster.container.stop();
  });

  it('[PLAT-4] a raw SQL read shows ciphertext only; the worker reads the value through the typed reader', async () => {
    const value = `${MARKER}${randomUUID()}`;
    await store(web).set(
      admin,
      'amazon.lwa_client_secret',
      'current',
      new Secret(value),
      now,
      null,
    );
    const { rows } = await root.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM app.app_secrets WHERE name = 'amazon.lwa_client_secret'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext.includes(Buffer.from(MARKER))).toBe(false);
    expect(rows[0]?.ciphertext.toString('utf8')).not.toContain(value);
    // ob_app and ob_worker hold no grant on the table itself.
    for (const db of [web, worker]) {
      const client = await db.pool.connect();
      try {
        await expect(client.query('SELECT * FROM app.app_secrets')).rejects.toThrow(/permission/);
      } finally {
        client.release();
      }
    }
    const read = await store(worker).get('amazon.lwa_client_secret');
    expect(read?.reveal()).toBe(value);
    expect(String(read)).not.toContain(MARKER);
    expect(await store(worker).get('ads.client_secret')).toBeUndefined();
  });

  it('[PLAT-4] only a platform admin with MFA may set or list; nobody gets a value back', async () => {
    await expect(
      store(web).set(notAdmin, 'ads.client_id', 'current', new Secret('x'.repeat(16)), now, null),
    ).rejects.toThrow(/platform admin/);
    await expect(store(web).list(notAdmin)).rejects.toThrow(/platform admin/);
    // MFA no longer confirmed: refused as well.
    await root.query('UPDATE app.users SET platform_admin = true WHERE id = $1', [notAdmin]);
    await root.query(
      `UPDATE app.user_auth SET totp_secret = NULL, totp_key_version = NULL, mfa_confirmed_at = NULL
        WHERE user_id = $1`,
      [notAdmin],
    );
    await expect(store(web).list(notAdmin)).rejects.toThrow(/platform admin/);
    const list = await store(web).list(admin);
    expect(list.find((s) => s.name === 'amazon.lwa_client_secret')).toEqual({
      name: 'amazon.lwa_client_secret',
      current: { setAt: now },
      next: null,
    });
    expect(JSON.stringify(list)).not.toContain(MARKER);
  });

  it('[PLAT-4] next is promoted to current, and the old current value is gone', async () => {
    const s = store(web);
    expect(await s.promote(admin, 'ebay.client_secret', now, null)).toBe(false);
    await s.set(admin, 'ebay.client_secret', 'current', new Secret(`${MARKER}old`), now, null);
    await s.set(admin, 'ebay.client_secret', 'next', new Secret(`${MARKER}new`), now, null);
    expect((await store(worker).get('ebay.client_secret', 'next'))?.reveal()).toBe(`${MARKER}new`);
    expect(await s.promote(admin, 'ebay.client_secret', now, '192.0.2.10')).toBe(true);
    expect((await store(worker).get('ebay.client_secret'))?.reveal()).toBe(`${MARKER}new`);
    expect(await store(worker).get('ebay.client_secret', 'next')).toBeUndefined();
  });

  it('[PLAT-4] ciphertext moved to another name does not open (the name is in the AAD)', async () => {
    await store(web).set(admin, 'ebay.dev_id', 'current', new Secret(`${MARKER}dev`), now, null);
    await store(web).set(admin, 'ebay.client_id', 'current', new Secret('client'), now, null);
    await root.query(
      `UPDATE app.app_secrets SET ciphertext = (SELECT ciphertext FROM app.app_secrets
                                                 WHERE name = 'ebay.dev_id' AND slot = 'current')
        WHERE name = 'ebay.client_id' AND slot = 'current'`,
    );
    await expect(store(worker).get('ebay.client_id')).rejects.toThrow();
  });

  it('[PLAT-4] the audit holds names and slots, and no table anywhere holds a value', async () => {
    const { rows } = await root.query<{ action: string; params: unknown }>(
      `SELECT action, params FROM app.platform_audit_events WHERE user_id = $1 ORDER BY occurred_at`,
      [admin],
    );
    expect(rows).toContainEqual({
      action: 'app_secret.set',
      params: { name: 'amazon.lwa_client_secret', slot: 'current' },
    });
    expect(rows).toContainEqual({
      action: 'app_secret.promoted',
      params: { name: 'ebay.client_secret' },
    });
    expect(await scanDatabaseForMarkers(cluster, ['app', 'pgboss'], MARKER)).toEqual([]);
  });
});
