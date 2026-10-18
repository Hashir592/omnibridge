import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { CryptoError, generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialRepository } from './credentials.ts';
import { migrateMain } from './migrate.ts';
import type { MainDb } from './schema.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;
const DAY_MS = 86_400_000;

const A: TenantContext = { workspaceId: randomUUID() };
const B: TenantContext = { workspaceId: randomUUID() };
const marker = () => `SECRETMARK-${randomUUID()}`;

describe('credential store (SEC-6, INT-3)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  const kek1 = generateKekLine(1);
  const kek2 = generateKekLine(2);
  const silent = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
  const repo = (lines: string[] = [kek1], logger = silent) =>
    new CredentialRepository({ keyring: parseKeyring('secrets', lines.join('\n')), logger });

  /** One transaction with SET LOCAL app.workspace_id, as T-0201's wrappers will open. */
  const asTenant = <T>(ctx: TenantContext, fn: (trx: Kysely<MainDb>) => Promise<T>) =>
    db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`.execute(trx);
      return fn(trx);
    });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 3 }),
      }),
    });
  });

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  it('[SEC-6] stored credentials hold ciphertext only, bound to their row', async () => {
    const value = marker();
    const r = repo();
    const ref = { kind: 'amazon.refresh_token', channelAccountId: randomUUID() };
    const id = await asTenant(A, (trx) => r.store(trx, A, ref, 'current', new Secret(value)));

    const row = await asTenant(A, (trx) =>
      trx.selectFrom('app.credentials').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
    );
    expect(row.encrypted_value.includes(Buffer.from(value))).toBe(false);
    expect(row.encrypted_value[0]).toBe(0x01);
    expect(Number(row.key_version)).toBe(1);
    expect(row).toMatchObject({ slot: 'current', is_active: true, kind: 'amazon.refresh_token' });

    const keys = await asTenant(A, (trx) => trx.selectFrom('app.data_keys').selectAll().execute());
    expect(keys).toHaveLength(1);
    expect(keys[0]?.wrapped_key.length).toBe(65);

    const got = await asTenant(A, (trx) => r.get(trx, A, ref));
    expect(got?.reveal()).toBe(value);

    // Ciphertext copied onto another row does not decrypt there (AAD binds the row id).
    const other = { kind: 'ebay.refresh_token' };
    const otherId = await asTenant(A, (trx) => r.store(trx, A, other, 'current', new Secret('x')));
    await asTenant(A, (trx) =>
      trx
        .updateTable('app.credentials')
        .set({ encrypted_value: row.encrypted_value })
        .where('id', '=', otherId)
        .execute(),
    );
    await expect(asTenant(A, (trx) => r.get(trx, A, other))).rejects.toThrow(CryptoError);
  });

  it('[SEC-6] RLS keeps each workspace’s credentials and data keys apart', async () => {
    const r = repo();
    const ref = { kind: 'dpd.api_key' };
    await asTenant(A, (trx) => r.store(trx, A, ref, 'current', new Secret(marker())));

    expect(await asTenant(B, (trx) => r.get(trx, B, ref))).toBeUndefined();
    const seenByB = await asTenant(B, (trx) =>
      trx.selectFrom('app.credentials').select('id').execute(),
    );
    expect(seenByB).toEqual([]);
    const noContext = await db.selectFrom('app.data_keys').select('workspace_id').execute();
    expect(noContext).toEqual([]);
    // A row for workspace A cannot be written while acting for workspace B.
    await expect(
      asTenant(B, (trx) =>
        trx
          .insertInto('app.data_keys')
          .values({
            workspace_id: A.workspaceId,
            version: 9,
            kek_version: 1,
            wrapped_key: Buffer.alloc(65),
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('[SEC-6] the app role can neither delete nor replace a data key', async () => {
    await asTenant(A, (trx) =>
      repo().store(trx, A, { kind: 'evri.api_key' }, 'current', new Secret('x')),
    );
    await expect(asTenant(A, (trx) => trx.deleteFrom('app.data_keys').execute())).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asTenant(A, (trx) => trx.updateTable('app.data_keys').set({ version: 5 }).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('[SEC-6] next is promoted to current; the old current stays inactive, then is purged', async () => {
    const r = repo();
    const ref = { kind: 'amazon.lwa_client_secret' };
    const [oldValue, newValue] = [marker(), marker()];
    const expiresAt = new Date(Date.now() + 180 * DAY_MS);
    await asTenant(A, async (trx) => {
      await r.store(trx, A, ref, 'current', new Secret(oldValue));
      await r.store(trx, A, ref, 'next', new Secret(newValue), { expiresAt });
    });
    // During the overlap both slots are readable.
    expect((await asTenant(A, (trx) => r.get(trx, A, ref, 'current')))?.reveal()).toBe(oldValue);
    expect((await asTenant(A, (trx) => r.get(trx, A, ref, 'next')))?.reveal()).toBe(newValue);

    await asTenant(A, (trx) => r.promoteNext(trx, A, ref, { retainOldForMs: 7 * DAY_MS }));
    expect((await asTenant(A, (trx) => r.get(trx, A, ref, 'current')))?.reveal()).toBe(newValue);
    expect(await asTenant(A, (trx) => r.get(trx, A, ref, 'next'))).toBeUndefined();

    const rows = await asTenant(A, (trx) =>
      trx
        .selectFrom('app.credentials')
        .selectAll()
        .where('kind', '=', ref.kind)
        .orderBy('created_at')
        .execute(),
    );
    expect(rows.map((x) => [x.slot, x.is_active])).toEqual([
      ['current', false],
      ['current', true],
    ]);
    expect(rows[0]?.rotated_at).toBeInstanceOf(Date);
    expect(rows[1]?.expires_at?.getTime()).toBe(expiresAt.getTime());

    // Nothing to promote is an error, not a silent no-op.
    await expect(
      asTenant(A, (trx) => r.promoteNext(trx, A, ref, { retainOldForMs: 0 })),
    ).rejects.toThrow(/no next credential/);

    expect(await asTenant(A, (trx) => r.purgeExpired(trx, A, new Date(Date.now() + DAY_MS)))).toBe(
      0,
    );
    expect(
      await asTenant(A, (trx) => r.purgeExpired(trx, A, new Date(Date.now() + 8 * DAY_MS))),
    ).toBe(1);
    const left = await asTenant(A, (trx) =>
      trx.selectFrom('app.credentials').select('is_active').where('kind', '=', ref.kind).execute(),
    );
    expect(left).toEqual([{ is_active: true }]);
  });

  it('[SEC-6] replacing current keeps the old token inactive for 7 days, then deletes it', async () => {
    const r = repo();
    const ref = { kind: 'amazon.refresh_token', channelAccountId: randomUUID() };
    const [first, second] = [marker(), marker()];
    await asTenant(A, (trx) => r.store(trx, A, ref, 'current', new Secret(first)));
    await asTenant(A, (trx) =>
      r.replaceCurrent(trx, A, ref, new Secret(second), { retainOldForMs: 7 * DAY_MS }),
    );
    expect((await asTenant(A, (trx) => r.get(trx, A, ref)))?.reveal()).toBe(second);

    const retired = await asTenant(A, (trx) =>
      trx
        .selectFrom('app.credentials')
        .select(['expires_at', 'is_active'])
        .where('channel_account_id', '=', ref.channelAccountId)
        .where('is_active', '=', false)
        .executeTakeFirstOrThrow(),
    );
    const keepMs = (retired.expires_at?.getTime() ?? 0) - Date.now();
    expect(keepMs).toBeGreaterThan(7 * DAY_MS - 60_000);
    expect(keepMs).toBeLessThanOrEqual(7 * DAY_MS);

    await asTenant(A, (trx) => r.purgeExpired(trx, A, new Date(Date.now() + 7 * DAY_MS + 1)));
    const remaining = await asTenant(A, (trx) =>
      trx
        .selectFrom('app.credentials')
        .select('is_active')
        .where('channel_account_id', '=', ref.channelAccountId)
        .execute(),
    );
    expect(remaining).toEqual([{ is_active: true }]);
  });

  it('[SEC-6] KEK rotation re-wraps DEKs in the database; stored data is untouched and decrypts', async () => {
    const C: TenantContext = { workspaceId: randomUUID() };
    const value = marker();
    const ref = { kind: 'ebay.refresh_token' };
    await asTenant(C, (trx) => repo([kek1]).store(trx, C, ref, 'current', new Secret(value)));
    const before = await asTenant(C, (trx) =>
      trx.selectFrom('app.credentials').select('encrypted_value').executeTakeFirstOrThrow(),
    );

    // Step 1: the new KEK is appended; re-wrap moves every DEK of the workspace onto it.
    expect(await asTenant(C, (trx) => repo([kek1, kek2]).rewrapDataKeys(trx, C))).toBe(1);
    expect(await asTenant(C, (trx) => repo([kek1, kek2]).rewrapDataKeys(trx, C))).toBe(0);
    const key = await asTenant(C, (trx) =>
      trx.selectFrom('app.data_keys').selectAll().executeTakeFirstOrThrow(),
    );
    expect(Number(key.kek_version)).toBe(2);
    expect(key.rewrapped_at).toBeInstanceOf(Date);

    // Step 2: the old KEK is removed; the credential row was never re-encrypted.
    const after = await asTenant(C, (trx) =>
      trx.selectFrom('app.credentials').select('encrypted_value').executeTakeFirstOrThrow(),
    );
    expect(after.encrypted_value.equals(before.encrypted_value)).toBe(true);
    expect((await asTenant(C, (trx) => repo([kek2]).get(trx, C, ref)))?.reveal()).toBe(value);
  });

  it('[INT-3] credential repository never logs plaintext', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'test',
      version: '0',
      level: 'trace',
      destination: { write: (line: string) => lines.push(line) },
    });
    const r = repo([kek1], logger);
    const D: TenantContext = { workspaceId: randomUUID() };
    const values = [marker(), marker(), marker()];
    const ref = { kind: 'amazon.refresh_token', channelAccountId: randomUUID() };

    await asTenant(D, async (trx) => {
      await r.store(trx, D, ref, 'current', new Secret(values[0] ?? ''));
      await r.store(trx, D, ref, 'next', new Secret(values[1] ?? ''));
      await r.promoteNext(trx, D, ref, { retainOldForMs: DAY_MS });
      await r.replaceCurrent(trx, D, ref, new Secret(values[2] ?? ''), { retainOldForMs: DAY_MS });
      await r.purgeExpired(trx, D, new Date(Date.now() + 2 * DAY_MS));
    });
    await asTenant(D, (trx) => repo([kek1, kek2], logger).rewrapDataKeys(trx, D));

    // A careless caller logs what it got back, in every shape the logger accepts.
    const got = await asTenant(D, (trx) => repo([kek2], logger).get(trx, D, ref));
    expect(got?.reveal()).toBe(values[2]);
    logger.info({ status: got, err: new Error(`token is ${String(got)}`) }, `got ${String(got)}`);
    logger.info(got, 'object form');

    // A failed decrypt is logged with its error.
    const failing = repo([generateKekLine(2)], logger);
    await asTenant(D, (trx) => failing.get(trx, D, ref)).catch((err: unknown) => {
      logger.error({ err }, 'credential read failed');
    });

    const output = lines.join('\n');
    expect(output).toContain('credential.stored');
    expect(output).toContain('credential.promoted');
    expect(output).toContain('credential.purged');
    expect(output).toContain('data_keys.rewrapped');
    expect(output).toContain('credential read failed');
    for (const value of values) expect(output).not.toContain(value);
    expect(output).not.toContain('SECRETMARK-');
  });
});
