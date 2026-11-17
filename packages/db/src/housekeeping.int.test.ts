import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthStore,
  createMainDb,
  JobLeaseRepository,
  JobRecordRepository,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from './index.ts';
import { createPool } from './pool.ts';

const DAY = 86_400_000;
const sha = (v: string) => createHash('sha256').update(v).digest();

describe('housekeeping: job records, leases, sessions and reset links (T-0207)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let worker: MainDbHandle;
  // One pool per role: the roles script caps each role's connections (T-0207).
  const pools = new Map<string, pg.Pool>();
  const raw = (role: string) => {
    const open = pools.get(role);
    if (open !== undefined) return open;
    const pool = createPool({ ...cluster.connection(role), max: 2 });
    pools.set(role, pool);
    return pool;
  };
  const A = randomUUID();
  const B = randomUUID();
  const user = randomUUID();
  const ctx = (workspaceId: string): TenantContext => ({ workspaceId, companyIds: [] });

  /** Runs one statement as ob_owner inside workspace `ws` (FORCE RLS binds the owner too). */
  async function asOwnerIn<R extends pg.QueryResultRow = Record<string, unknown>>(
    ws: string,
    text: string,
    values: unknown[],
  ) {
    const client = await raw('ob_owner').connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [ws]);
      const res = await client.query<R>(text, values);
      await client.query('COMMIT');
      return res;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    worker = createMainDb({ ...cluster.connection('ob_worker'), max: 2 });
    const tenancy = new Tenancy(main.db);
    for (const ws of [A, B]) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: user }, async (c) => {
        await new WorkspaceRepository(main.db).create(c, { name: `Workspace ${ws.slice(0, 4)}` });
        if (ws === A) {
          await new UserRepository(main.db).create(c, {
            id: user,
            email: `${user.slice(0, 8)}@example.test`,
            name: 'Hal Housekeeping',
          });
          await new MembershipRepository(main.db).add(c, { userId: user, role: 'admin' });
        }
      });
    }
  });

  afterAll(async () => {
    // Every pool closes before the container stops (ADR-057).
    await Promise.all([...pools.values()].map((p) => p.end()));
    await worker.destroy();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[NFR-3][NFR-4] purge removes finished job records and expired leases older than the cut-off, and nothing else', async () => {
    const records = new JobRecordRepository(worker.db);
    const leases = new JobLeaseRepository(worker.db);
    const now = Date.now();
    const cutOff = new Date(now - 30 * DAY);
    const make = async (ws: string, key: string, state: string, ageDays: number) => {
      const { id } = await records.createAndEnqueue(
        ctx(ws),
        { id: randomUUID(), type: 'test.housekeeping', idempotencyKey: key },
        () => Promise.resolve(),
      );
      await asOwnerIn(ws, 'UPDATE app.job_records SET state = $2, updated_at = $3 WHERE id = $1', [
        id,
        state,
        new Date(now - ageDays * DAY),
      ]);
      return id;
    };
    await make(A, 'old-done', 'completed', 40);
    await make(A, 'old-failed', 'failed', 31);
    const oldRunning = await make(A, 'old-running', 'active', 40);
    const oldQueued = await make(A, 'old-queued', 'queued', 40);
    const recentDone = await make(A, 'recent-done', 'completed', 5);
    const otherWorkspace = await make(B, 'b-old-done', 'completed', 40);

    expect(await leases.acquire(ctx(A), 'old', 1, randomUUID(), 60)).toBe(true);
    expect(await leases.acquire(ctx(A), 'live', 1, randomUUID(), 60)).toBe(true);
    expect(await leases.acquire(ctx(B), 'old', 1, randomUUID(), 60)).toBe(true);
    for (const ws of [A, B]) {
      await asOwnerIn(ws, "UPDATE app.job_leases SET expires_at = $1 WHERE scope_key = 'old'", [
        new Date(now - 31 * DAY),
      ]);
    }

    expect(await records.purge(ctx(A), cutOff)).toEqual({ records: 2, leases: 1 });
    const left = await asOwnerIn(A, 'SELECT id FROM app.job_records', []);
    expect(new Set(left.rows.map((r) => r.id))).toEqual(
      new Set([oldRunning, oldQueued, recentDone]),
    );
    const leftLeases = await asOwnerIn(A, 'SELECT scope_key FROM app.job_leases', []);
    expect(leftLeases.rows).toEqual([{ scope_key: 'live' }]);
    // Workspace B is untouched by A's purge.
    expect((await asOwnerIn(B, 'SELECT id FROM app.job_records', [])).rows).toEqual([
      { id: otherWorkspace },
    ]);
    expect((await asOwnerIn(B, 'SELECT scope_key FROM app.job_leases', [])).rowCount).toBe(1);
    // A repeat deletes nothing more.
    expect(await records.purge(ctx(A), cutOff)).toEqual({ records: 0, leases: 0 });
  });

  it('[NFR-3] a job result over 16 KiB is refused', async () => {
    const records = new JobRecordRepository(worker.db);
    const key = { type: 'test.housekeeping', idempotencyKey: 'big-result' };
    await records.createAndEnqueue(ctx(A), { id: randomUUID(), ...key }, () => Promise.resolve());
    await expect(
      records.update(ctx(A), key, { state: 'completed', result: { ids: 'x'.repeat(17_000) } }),
    ).rejects.toThrow(/job_records_result_size/);
    await records.update(ctx(A), key, { state: 'completed', result: { count: 3 } });
  });

  it('[USR-6][USR-7] auth_purge deletes sessions ended over 30 days ago and reset links over 7 days ago; only the worker may run it', async () => {
    const store = new AuthStore(main.db);
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * DAY);
    const session = async (startedDaysAgo: number, expiresDaysAgo: number) => {
      const id = randomUUID();
      await store.createSession({
        id,
        tokenHash: sha(`token-${id}`),
        csrfHash: sha(`csrf-${id}`),
        userId: user,
        stage: 'pre_mfa',
        now: ago(startedDaysAgo),
        expiresAt: ago(expiresDaysAgo),
      });
      return id;
    };
    const longExpired = await session(60, 59);
    const recentlyExpired = await session(11, 10);
    const live = await session(0, -1);
    const longRevoked = await session(41, -1);
    await store.revokeSession(longRevoked, ago(40));
    const recentlyRevoked = await session(3, -1);
    await store.revokeSession(recentlyRevoked, ago(2));

    const oldReset = sha('reset-old');
    const usedLongAgo = sha('reset-used');
    const freshReset = sha('reset-fresh');
    await store.createReset(oldReset, user, ago(10), new Date(ago(10).getTime() + 1_800_000));
    await store.createReset(usedLongAgo, user, ago(9), new Date(ago(9).getTime() + 1_800_000));
    await raw('ob_owner').query(
      'UPDATE app.password_resets SET used_at = $2 WHERE token_hash = $1',
      [usedLongAgo, ago(9)],
    );
    await store.createReset(freshReset, user, ago(0), new Date(now + 1_800_000));

    // ob_app (web) cannot run it; the worker can.
    await expect(raw('ob_app').query('SELECT * FROM app.auth_purge()')).rejects.toThrow(
      /permission denied/,
    );
    expect(await new AuthStore(worker.db).purgeExpired()).toEqual({ sessions: 2, resets: 2 });

    const sessions = await raw('ob_owner').query<{ id: string }>(
      'SELECT id FROM app.sessions WHERE user_id = $1',
      [user],
    );
    expect(new Set(sessions.rows.map((r) => r.id))).toEqual(
      new Set([recentlyExpired, live, recentlyRevoked]),
    );
    expect(sessions.rows.some((r) => r.id === longExpired)).toBe(false);
    const resets = await raw('ob_owner').query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM app.password_resets WHERE user_id = $1',
      [user],
    );
    expect(resets.rows.map((r) => r.token_hash.toString('hex'))).toEqual([
      freshReset.toString('hex'),
    ]);
    expect(await new AuthStore(worker.db).purgeExpired()).toEqual({ sessions: 0, resets: 0 });
  });

  it('[USR-5] auth_purge drops lock-notice rows older than 24 hours (T-0210)', async () => {
    const owner = raw('ob_owner');
    const old = randomUUID();
    const fresh = randomUUID();
    await owner.query(
      `INSERT INTO app.lock_notices (user_id, sent_at)
         VALUES ($1, now() - interval '25 hours'), ($2, now() - interval '1 hour')`,
      [old, fresh],
    );
    await new AuthStore(worker.db).purgeExpired();
    const { rows } = await owner.query<{ user_id: string }>(
      'SELECT user_id FROM app.lock_notices WHERE user_id = ANY($1::uuid[])',
      [[old, fresh]],
    );
    expect(rows.map((r) => r.user_id)).toEqual([fresh]);
  });

  it('[NFR-2] the housekeeping indexes exist and are valid, and the old credential purge index is gone', async () => {
    const { rows } = await raw('ob_owner').query<{ name: string; valid: boolean }>(
      `SELECT c.relname AS name, i.indisvalid AS valid
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ANY($1) ORDER BY 1`,
      [
        [
          'credentials_purge',
          'credentials_purge_due',
          'job_leases_expires',
          'job_records_finished',
          'password_resets_ended',
          'sessions_ended',
        ],
      ],
    );
    expect(rows).toEqual([
      { name: 'credentials_purge_due', valid: true },
      { name: 'job_leases_expires', valid: true },
      { name: 'job_records_finished', valid: true },
      { name: 'password_resets_ended', valid: true },
      { name: 'sessions_ended', valid: true },
    ]);
  });
});
