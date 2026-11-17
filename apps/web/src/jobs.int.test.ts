import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  JobRecordRepository,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDb,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const A: TenantContext = { workspaceId: randomUUID(), companyIds: [] };
const B: TenantContext = { workspaceId: randomUUID(), companyIds: [] };

const USER = randomUUID();

/** Test-only stand-in for T-0203 sessions: the workspace comes from a header. */
const fromHeader = (request: { headers: Record<string, unknown> }) => {
  const ws = request.headers['x-test-workspace'];
  return typeof ws === 'string'
    ? { workspaceId: ws, userId: USER, sessionId: 'test-session' }
    : undefined;
};

describe('GET /jobs/:id (NFR-4)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let records: JobRecordRepository;
  let tenancy: Tenancy;
  let jobId = '';

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 3 }),
      }),
    });
    records = new JobRecordRepository(db);
    tenancy = new Tenancy(db);
    // The session user is an admin of both workspaces: only the tenant check keeps B's job apart.
    for (const [ctx, name] of [
      [A, 'Jobs test'],
      [B, 'Jobs test B'],
    ] as const) {
      await tenancy.run({ ...ctx, userId: USER }, async (c) => {
        await new WorkspaceRepository(db).create(c, { name });
        if (ctx === A) {
          await new UserRepository(db).create(c, {
            id: USER,
            email: `${USER}@example.test`,
            name: 'U',
          });
        }
        await new MembershipRepository(db).add(c, { userId: USER, role: 'admin' });
      });
    }
    // A job record as the queue writes it; the pg-boss send itself is not needed here.
    jobId = (
      await records.createAndEnqueue(
        A,
        { id: randomUUID(), type: 'orders.export', idempotencyKey: 'export-1' },
        () => Promise.resolve(),
      )
    ).id;
  });

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  it('[NFR-4] progress route reports percent and result', async () => {
    const app = buildWebApp({
      logger,
      version: '0',
      checks,
      jobs: records,
      tenancy,
      resolveSession: fromHeader,
    });
    const get = () =>
      app.inject({
        method: 'GET',
        url: `/api/jobs/${jobId}`,
        headers: { 'x-test-workspace': A.workspaceId },
      });

    const key = { type: 'orders.export', idempotencyKey: 'export-1' };
    await records.update(A, key, { state: 'active', attempt: 1, percent: 40 });
    const running = await get();
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({ id: jobId, state: 'active', percent: 40, result: null });

    await records.update(A, key, { state: 'completed', percent: 100, result: { rows: 1250 } });
    const finished = await get();
    expect(finished.json()).toMatchObject({
      state: 'completed',
      percent: 100,
      attempt: 1,
      result: { rows: 1250 },
      error_code: null,
    });
    await app.close();
  });

  it('[NFR-4] another workspace gets 404, and no session gets 401', async () => {
    const app = buildWebApp({
      logger,
      version: '0',
      checks,
      jobs: records,
      tenancy,
      resolveSession: fromHeader,
    });
    const other = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { 'x-test-workspace': B.workspaceId },
    });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toMatchObject({ code: 'not_found' });
    expect(JSON.stringify(other.json())).not.toContain('orders.export');

    const anonymous = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'unauthorized' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/jobs/not-a-uuid',
          headers: { 'x-test-workspace': A.workspaceId },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();

    // Until M02 wires sessions, production passes no resolver: the route is closed, never open.
    const prod = buildWebApp({ logger, version: '0', checks, jobs: records });
    const res = await prod.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: { 'x-test-workspace': A.workspaceId },
    });
    expect(res.statusCode).toBe(401);
    await prod.close();
  });
});
