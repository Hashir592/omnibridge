import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionRepository } from './connections.ts';
import { CredentialRepository } from './credentials.ts';
import { migrateMain } from './migrate.ts';
import { OAuthStateRepository, oauthStateWorkspace } from './oauth-states.ts';
import type { MainDb } from './schema.ts';
import { SyncCursorRepository } from './sync-cursors.ts';
import { withTenantTransaction } from './tenant.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;
const silent = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
/** One company per workspace, in scope, as an admin's context has (accounts are company data). */
const tenant = (): TenantContext => ({ workspaceId: randomUUID(), companyIds: [randomUUID()] });
const A = tenant();
const B = tenant();
const at = (iso: string) => new Date(iso);

/**
 * Provider-sourced tables: any app table with an external_id. Each must carry the origin tag and
 * its channel account, with the composite foreign key the helper adds (INT-6).
 */
const UNTAGGED_PROVIDER_TABLES = `
  SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                   AND a.attname = 'external_id' AND NOT a.attisdropped)
     AND NOT (
       EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                 AND a.attname = 'origin' AND a.attnotnull AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_constraint k
                    WHERE k.conrelid = c.oid AND k.contype = 'f'
                      AND k.confrelid = 'app.channel_accounts'::regclass)
       AND EXISTS (SELECT 1 FROM pg_constraint k
                    WHERE k.conrelid = c.oid AND k.contype = 'c'
                      AND pg_get_constraintdef(k.oid) LIKE '%manual%'))
   ORDER BY 1`;

describe('connections, cursors and OAuth states (T-0701)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let owner: pg.Pool;
  let connections: ConnectionRepository;
  const keyring = parseKeyring('secrets', generateKekLine(1));
  const credentials = new CredentialRepository({ keyring, logger: silent, environment: 'mock' });

  const asTenant = <T>(ctx: TenantContext, fn: (trx: Kysely<MainDb>) => Promise<T>) =>
    withTenantTransaction(db, ctx, async (trx) => {
      await trx
        .insertInto('app.workspaces')
        .values({ id: ctx.workspaceId, name: 'Connections test' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      return fn(trx);
    });

  const newAccount = (ctx: TenantContext, provider: 'ebay' | 'evri' = 'ebay') =>
    asTenant(ctx, async (trx) => {
      const company = ctx.companyIds[0] ?? '';
      const id = randomUUID();
      await trx
        .insertInto('app.companies')
        .values({
          id: company,
          workspace_id: ctx.workspaceId,
          legal_name: 'Connections test Ltd',
          trading_name: 'Connections test',
          address_line1: '1 Test Street',
          address_city: 'Testville',
          address_postcode: 'TE1 1ST',
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('app.channel_accounts')
        .values({
          id,
          workspace_id: ctx.workspaceId,
          company_id: company,
          provider,
          display_name: `Account ${provider}`,
        })
        .execute();
      return id;
    });

  const connect = (ctx: TenantContext, id: string) =>
    asTenant(ctx, (trx) =>
      credentials.store(
        trx,
        ctx,
        { kind: 'ebay.refresh_token', channelAccountId: id },
        'current',
        new Secret(`TOKENMARK-${randomUUID()}`),
      ),
    );

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 3 }),
      }),
    });
    owner = new pg.Pool({ ...cluster.connection('ob_owner'), max: 1 });
    connections = new ConnectionRepository(db, { environment: 'mock' });
  });

  afterAll(async () => {
    await db.destroy();
    await owner.end();
    await cluster.container.stop();
  });

  it('[INT-4] three auth failures within an hour mark Needs re-authorisation once; a success clears it', async () => {
    const id = await newAccount(A);
    const t = (m: number) => at(`2026-11-21T10:${String(m).padStart(2, '0')}:00.000Z`);
    const r1 = await asTenant(A, () =>
      connections.recordAuthFailure(A, id, t(0), { revoked: false }),
    );
    const r2 = await asTenant(A, () =>
      connections.recordAuthFailure(A, id, t(10), { revoked: false }),
    );
    const r3 = await asTenant(A, () =>
      connections.recordAuthFailure(A, id, t(20), { revoked: false }),
    );
    const r4 = await asTenant(A, () =>
      connections.recordAuthFailure(A, id, t(30), { revoked: false }),
    );
    expect([r1, r2, r3, r4]).toEqual([
      { failures: 1, marked: false },
      { failures: 2, marked: false },
      { failures: 3, marked: true },
      { failures: 4, marked: false },
    ]);
    await connect(A, id);
    const marked = await asTenant(A, () => connections.get(A, id, t(31)));
    expect(marked).toMatchObject({
      status: 'needs_reauth',
      authFailures: 4,
      needsReauthAt: t(20),
      lastError: { code: 'provider.auth_failed', at: t(30) },
    });

    expect(await asTenant(A, () => connections.recordSuccess(A, id, t(40)))).toEqual({
      reauthCleared: true,
    });
    expect(await asTenant(A, () => connections.recordSuccess(A, id, t(41)))).toEqual({
      reauthCleared: false,
    });
    expect(await asTenant(A, () => connections.get(A, id, t(42)))).toMatchObject({
      status: 'active',
      authFailures: 0,
      needsReauthAt: null,
      lastSuccessAt: t(41),
    });
  });

  it('[INT-4] failures spread over more than an hour do not mark it; a revocation marks it at once', async () => {
    const id = await newAccount(A);
    for (const iso of ['2026-11-21T08:00:00.000Z', '2026-11-21T08:50:00.000Z']) {
      await asTenant(A, () => connections.recordAuthFailure(A, id, at(iso), { revoked: false }));
    }
    // An hour after the first: the window starts again.
    const third = await asTenant(A, () =>
      connections.recordAuthFailure(A, id, at('2026-11-21T09:05:00.000Z'), { revoked: false }),
    );
    expect(third).toEqual({ failures: 1, marked: false });

    const other = await newAccount(A);
    expect(
      await asTenant(A, () =>
        connections.recordAuthFailure(A, other, at('2026-11-21T09:05:00.000Z'), { revoked: true }),
      ),
    ).toEqual({ failures: 1, marked: true });
  });

  it("[INT-4] the list shows every field, the status by precedence and today's usage per API", async () => {
    const now = at('2026-11-21T12:00:00.000Z');
    const ctx = tenant();
    const disconnected = await newAccount(ctx);
    const active = await newAccount(ctx);
    const paused = await newAccount(ctx, 'evri');
    const failing = await newAccount(ctx);
    for (const id of [active, paused, failing]) await connect(ctx, id);
    await asTenant(ctx, async (trx) => {
      await connections.recordSuccess(ctx, active, at('2026-11-21T11:00:00.000Z'), {
        tokenRefreshed: true,
      });
      await trx
        .updateTable('app.channel_accounts')
        .set({ paused_at: at('2026-11-21T11:30:00.000Z') })
        .where('id', '=', paused)
        .execute();
      await connections.recordSuccess(ctx, failing, at('2026-11-21T10:00:00.000Z'));
      await connections.recordError(
        ctx,
        failing,
        'provider.server_error',
        at('2026-11-21T11:00:00.000Z'),
      );
      await connections.recordCalls(
        ctx,
        { channelAccountId: active, provider: 'ebay', api: 'sell.fulfillment', calls: 2 },
        now,
      );
      await connections.recordCalls(
        ctx,
        { channelAccountId: active, provider: 'ebay', api: 'sell.fulfillment', calls: 3 },
        now,
      );
      // Yesterday's calls are not today's.
      await connections.recordCalls(
        ctx,
        { channelAccountId: active, provider: 'ebay', api: 'sell.inventory', calls: 9 },
        at('2026-11-19T12:00:00.000Z'),
      );
    });

    const list = await asTenant(ctx, () => connections.list(ctx, now));
    expect(list.map((c) => [c.id, c.status])).toEqual([
      [disconnected, 'disconnected'],
      [active, 'active'],
      [paused, 'paused'],
      [failing, 'error'],
    ]);
    expect(list[1]).toEqual({
      id: active,
      provider: 'ebay',
      displayName: 'Account ebay',
      companyId: expect.any(String) as string,
      status: 'active',
      lastSuccessAt: at('2026-11-21T11:00:00.000Z'),
      lastTokenRefreshAt: at('2026-11-21T11:00:00.000Z'),
      authFailures: 0,
      needsReauthAt: null,
      lastError: null,
      pausedAt: null,
      usageToday: [{ api: 'sell.fulfillment', calls: 5, cap: null }],
    });
    // Another workspace sees none of it.
    expect(await asTenant(B, () => connections.list(B, now))).toEqual([]);
    expect(await asTenant(B, () => connections.get(B, active, now))).toBeUndefined();
  });

  it('[INT-8] a cursor is stored per account and stream, and only its own workspace reads it', async () => {
    const cursors = new SyncCursorRepository(db);
    const id = await newAccount(A);
    expect(await asTenant(A, () => cursors.get(A, id, 'ebay.orders'))).toEqual({
      cursorAt: null,
      overlap: [],
    });
    const state = {
      cursorAt: at('2026-11-21T11:00:00.000Z'),
      overlap: [{ id: '12-34', at: '2026-11-21T11:00:00.000Z' }],
    };
    await asTenant(A, () =>
      cursors.save(A, id, 'ebay.orders', state, at('2026-11-21T11:01:00.000Z')),
    );
    expect(await asTenant(A, () => cursors.get(A, id, 'ebay.orders'))).toEqual(state);
    expect(await asTenant(B, () => cursors.get(B, id, 'ebay.orders'))).toEqual({
      cursorAt: null,
      overlap: [],
    });
    const detail = await asTenant(A, () => connections.get(A, id, at('2026-11-21T12:00:00.000Z')));
    expect(detail?.streams).toEqual([
      {
        stream: 'ebay.orders',
        cursorAt: at('2026-11-21T11:00:00.000Z'),
        lastSuccessAt: at('2026-11-21T11:01:00.000Z'),
      },
    ]);
  });

  it('[INT-2] an OAuth state is taken once, before it expires, by its own workspace only', async () => {
    const states = new OAuthStateRepository(db);
    const id = await newAccount(A);
    const userId = randomUUID();
    const now = at('2026-11-21T12:00:00.000Z');
    const state = await asTenant(A, () =>
      states.create(A, { channelAccountId: id, userId, provider: 'ebay' }, now),
    );
    expect(oauthStateWorkspace(state)).toBe(A.workspaceId);
    expect(oauthStateWorkspace('not-a-state')).toBeUndefined();
    // Not as another workspace, nor for another provider.
    expect(await asTenant(B, () => states.take(B, state, 'ebay', now))).toBeUndefined();
    expect(await asTenant(A, () => states.take(A, state, 'amazon', now))).toBeUndefined();
    expect(await asTenant(A, () => states.take(A, state, 'ebay', now))).toEqual({
      channelAccountId: id,
      userId,
      provider: 'ebay',
    });
    expect(await asTenant(A, () => states.take(A, state, 'ebay', now))).toBeUndefined();

    const late = await asTenant(A, () =>
      states.create(A, { channelAccountId: id, userId, provider: 'ebay' }, now),
    );
    const after = new Date(now.getTime() + 10 * 60_000 + 1);
    expect(await asTenant(A, () => states.take(A, late, 'ebay', after))).toBeUndefined();
    // Only the hash is kept.
    const rows = await asTenant(A, (trx) =>
      trx.selectFrom('app.oauth_states').select('state_hash').execute(),
    );
    expect(JSON.stringify(rows)).not.toContain(state.split('.')[1] ?? 'x');
  });

  it('[INT-6] every provider table carries its origin and account; the shared helper adds them', async () => {
    expect((await owner.query(UNTAGGED_PROVIDER_TABLES)).rows).toEqual([]);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE app.origin_fixture (
        workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
        id uuid NOT NULL, external_id text NOT NULL, PRIMARY KEY (workspace_id, id))`);
      await client.query(`CREATE TABLE app.untagged_fixture (
        workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
        id uuid NOT NULL, external_id text NOT NULL, PRIMARY KEY (workspace_id, id))`);
      await client.query(`CALL app.add_origin_columns('app.origin_fixture')`);
      // The check finds the table built without the helper, and only that one.
      const { rows } = await client.query<{ name: string }>(UNTAGGED_PROVIDER_TABLES);
      expect(rows).toEqual([{ name: 'untagged_fixture' }]);
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [A.workspaceId]);
      await client.query(`ALTER TABLE app.origin_fixture DISABLE ROW LEVEL SECURITY`);
      // A provider row needs its account; only a manual row may have none.
      await expect(
        client.query(
          `INSERT INTO app.origin_fixture VALUES ($1, gen_random_uuid(), 'x-1', 'ebay', NULL)`,
          [A.workspaceId],
        ),
      ).rejects.toThrow(/origin_fixture_origin_account/);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(`CREATE TABLE app.origin_fixture (
        workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
        id uuid NOT NULL, external_id text NOT NULL, PRIMARY KEY (workspace_id, id))`);
      await client.query(`CALL app.add_origin_columns('app.origin_fixture')`);
      await expect(
        client.query(
          `INSERT INTO app.origin_fixture VALUES ($1, gen_random_uuid(), 'x-1', 'scraped', NULL)`,
          [A.workspaceId],
        ),
      ).rejects.toThrow(/origin_fixture_origin/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
