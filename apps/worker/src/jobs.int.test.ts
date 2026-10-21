import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  createMainDb,
  createQueues,
  JobLeaseRepository,
  JobRecordRepository,
  migrateMain,
  Tenancy,
  txTimeouts,
  withTenantTransaction,
  WorkspaceRepository,
  type MainDb,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import {
  defineJob,
  definePlatformJob,
  HEARTBEAT_QUEUE,
  JobQueue,
  queueMetrics,
  schedulePlatformJob,
} from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { type Kysely, sql } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkerBoss } from './heartbeat.ts';
import { startMetricsServer } from './metrics-server.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;
const FAST = { pollingIntervalSeconds: 0.5 } as const;

// Test-only job types; the migrate step creates their queues as ob_owner, like the real registry.
const restartJob = defineJob({
  type: 'test.restart',
  payload: z.object({ n: z.number() }),
  retry: { limit: 3, delaySeconds: 0 },
  heartbeatSeconds: 10,
});
const onceJob = defineJob({ type: 'test.once', payload: z.object({}) });
const flakyJob = defineJob({
  type: 'test.flaky',
  payload: z.object({}),
  retry: { limit: 1, delaySeconds: 0 },
});
const cappedJob = defineJob({
  type: 'test.capped',
  payload: z.object({ n: z.number() }),
  perAccountCap: 4,
});

const wideA = defineJob({ type: 'test.wide_a', payload: z.object({}) });
const wideB = defineJob({ type: 'test.wide_b', payload: z.object({}) });
const idleJob = defineJob({ type: 'test.idle', payload: z.object({}) });
const stuckJob = defineJob({
  type: 'test.stuck',
  payload: z.object({ mode: z.enum(['idle', 'slow']) }),
  retry: { limit: 0, delaySeconds: 0 },
});

describe('durable job queue (NFR-3, OPS-10)', () => {
  let cluster: RoleCluster;
  let bookkeeping: MainDbHandle;
  let db: Kysely<MainDb>;
  const bosses: PgBoss[] = [];
  const errors: unknown[] = [];
  const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
  const ws: TenantContext = { workspaceId: randomUUID(), companyIds: [] };
  /** Handler transactions get their own pool, apart from the bookkeeping one (PS-017). */
  let handlers: MainDbHandle;

  const startBoss = async (overrides = {}) => {
    const boss = createWorkerBoss(cluster.connection('ob_app'), {
      monitorIntervalSeconds: 1,
      superviseIntervalSeconds: 1,
      ...overrides,
    });
    boss.on('error', (err) => errors.push(err));
    await boss.start();
    bosses.push(boss);
    return boss;
  };
  const queueOn = (boss: PgBoss, handlerDb: MainDbHandle = handlers) =>
    new JobQueue({
      boss,
      records: new JobRecordRepository(db),
      limiter: new JobLeaseRepository(db),
      tenancy: new Tenancy(handlerDb.db),
      logger,
    });

  const record = (type: string, idempotencyKey: string) =>
    db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', ${ws.workspaceId}, true)`.execute(trx);
      return trx
        .selectFrom('app.job_records')
        .selectAll()
        .where('type', '=', type)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
    });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    const owner = cluster.connection('ob_owner');
    await migrateMain(owner);
    await createQueues(owner, [
      restartJob,
      onceJob,
      flakyJob,
      cappedJob,
      wideA,
      wideB,
      idleJob,
      stuckJob,
    ]);
    // createMainDb's pool handles a dropped connection, so stopping the container cannot raise
    // an unhandled 57P01 from an idle client.
    bookkeeping = createMainDb({ ...cluster.connection('ob_app'), max: 6 });
    db = bookkeeping.db;
    handlers = createMainDb({ ...cluster.connection('ob_app'), max: 6 });
    await new Tenancy(handlers.db).run(ws, (ctx) =>
      new WorkspaceRepository(handlers.db).create(ctx, { name: 'Worker test' }),
    );
  });

  // Each test's pg-boss is closed after it, so the tests stay inside ob_app's connection limit.
  afterEach(async () => {
    for (const boss of bosses.splice(0)) {
      await boss.stop({ graceful: false, close: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    await handlers.destroy();
    await bookkeeping.destroy();
    await cluster.container.stop();
  });

  it('[NFR-3] job survives worker restart', async () => {
    const first = await startBoss();
    // The "dead" worker never releases its handler connection, as in a real crash, so it gets a
    // pool of its own that is never closed; stopping the container ends it.
    const dying = createMainDb({ ...cluster.connection('ob_app'), max: 1 });
    let started = false;
    await queueOn(first, dying).work(
      restartJob,
      () =>
        new Promise<never>(() => {
          started = true; // the worker "dies" mid-job: this promise never settles
        }),
      FAST,
    );
    await queueOn(first, dying).send(restartJob, {
      ctx: ws,
      idempotencyKey: 'restart-1',
      payload: { n: 1 },
    });
    await expect.poll(() => started, { timeout: 30_000 }).toBe(true);
    await first.stop({ graceful: false, close: true });

    // A new worker picks the job up once its heartbeat lapses, and finishes it.
    const second = await startBoss();
    await queueOn(second).work(
      restartJob,
      (job) => Promise.resolve({ doubled: job.payload.n * 2 }),
      FAST,
    );
    await expect
      .poll(async () => (await record('test.restart', 'restart-1'))?.state, { timeout: 90_000 })
      .toBe('completed');
    expect((await record('test.restart', 'restart-1'))?.result).toEqual({ doubled: 2 });
  });

  it('[NFR-3] same idempotency key runs once', async () => {
    const boss = await startBoss();
    const queue = queueOn(boss);
    let runs = 0;
    await queue.work(
      onceJob,
      () => {
        runs += 1;
        return Promise.resolve();
      },
      FAST,
    );
    const a = await queue.send(onceJob, { ctx: ws, idempotencyKey: 'once-1', payload: {} });
    const b = await queue.send(onceJob, { ctx: ws, idempotencyKey: 'once-1', payload: {} });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    await expect
      .poll(async () => (await record('test.once', 'once-1'))?.state, { timeout: 30_000 })
      .toBe('completed');
    // A third send after completion is still the same job, not a re-run.
    expect(
      (await queue.send(onceJob, { ctx: ws, idempotencyKey: 'once-1', payload: {} })).created,
    ).toBe(false);
    expect(runs).toBe(1);
  });

  it('[NFR-3] job exceeding attempts lands in DLQ and redrive re-runs it', async () => {
    const boss = await startBoss();
    const queue = queueOn(boss);
    let healed = false;
    let attempts = 0;
    await queue.work(
      flakyJob,
      () => {
        attempts += 1;
        return healed ? Promise.resolve() : Promise.reject(new Error('synthetic failure'));
      },
      FAST,
    );
    await queue.send(flakyJob, { ctx: ws, idempotencyKey: 'flaky-1', payload: {} });

    // retry limit 1 = 2 attempts, then the dead-letter queue.
    await expect
      .poll(async () => (await record('test.flaky', 'flaky-1'))?.state, { timeout: 60_000 })
      .toBe('failed');
    expect(attempts).toBe(2);
    await expect
      .poll(async () => (await boss.getQueueStats('test.flaky.dlq'))[0]?.queuedCount ?? 0, {
        timeout: 30_000,
      })
      .toBe(1);
    expect((await record('test.flaky', 'flaky-1'))?.error_code).toBe('handler_failed');

    healed = true;
    expect(await queue.redrive(flakyJob)).toBe(1);
    await expect
      .poll(async () => (await record('test.flaky', 'flaky-1'))?.state, { timeout: 60_000 })
      .toBe('completed');
    expect(attempts).toBe(3);
  });

  it('[OPS-10] per-account cap of 4 never exceeded under 50 concurrent jobs', async () => {
    const boss = await startBoss();
    const queue = queueOn(boss);
    const accounts = [randomUUID(), randomUUID()];
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    let done = 0;
    await queue.work(
      cappedJob,
      async (job) => {
        const account = job.envelope.channel_account_id ?? 'none';
        const now = (active.get(account) ?? 0) + 1;
        active.set(account, now);
        peak.set(account, Math.max(peak.get(account) ?? 0, now));
        await new Promise((resolve) => setTimeout(resolve, 150));
        active.set(account, (active.get(account) ?? 1) - 1);
        done += 1;
      },
      { ...FAST, localConcurrency: 20 },
    );
    await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        queue.send(cappedJob, {
          ctx: ws,
          channelAccountId: accounts[n % 2] ?? '',
          idempotencyKey: `capped-${String(n)}`,
          payload: { n },
        }),
      ),
    );
    await expect.poll(() => done, { timeout: 120_000 }).toBe(50);
    for (const account of accounts) {
      expect(peak.get(account) ?? 0).toBeLessThanOrEqual(4);
      // The cap limits, it does not serialise: each account really ran jobs side by side.
      expect(peak.get(account) ?? 0).toBeGreaterThan(1);
    }
  });

  it('[NFR-3] the worker role cannot run queue DDL (that stays with the migrate job)', async () => {
    // pg-boss 12 creates a plain queue with an INSERT, but a partitioned queue needs CREATE TABLE,
    // which ob_app may never do (ADR-032).
    const boss = await startBoss();
    await expect(boss.createQueue('test.not_allowed', { partition: true })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('[OPS-10] one worker never runs more jobs at once than its global cap, across queues', async () => {
    const boss = await startBoss();
    const queue = new JobQueue({
      boss,
      records: new JobRecordRepository(db),
      tenancy: new Tenancy(handlers.db),
      globalConcurrency: 3,
      logger,
    });
    let running = 0;
    let peak = 0;
    let done = 0;
    const handler = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 150));
      running -= 1;
      done += 1;
    };
    await queue.work(wideA, handler, { ...FAST, localConcurrency: 5 });
    await queue.work(wideB, handler, { ...FAST, localConcurrency: 5 });
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        queue.send(n % 2 === 0 ? wideA : wideB, {
          ctx: ws,
          idempotencyKey: `wide-${String(n)}`,
          payload: {},
        }),
      ),
    );
    await expect.poll(() => done, { timeout: 60_000 }).toBe(12);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('[NFR-3] /metrics reports queue depth and dead-letter size per job type', async () => {
    const boss = await startBoss();
    const queue = queueOn(boss);
    for (const n of [1, 2]) {
      await queue.send(idleJob, { ctx: ws, idempotencyKey: `idle-${String(n)}`, payload: {} });
    }
    const server = await startMetricsServer(
      queueMetrics({ boss, types: ['test.idle', 'test.flaky'] }),
      0,
    );
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const scrape = async () => (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();
      // Counts come from pg-boss's queue cache, refreshed by the supervisor (1 s in this test).
      await expect
        .poll(scrape, { timeout: 30_000 })
        .toContain('ob_queue_depth{queue="test.idle"} 2');
      const text = await scrape();
      expect(text).toContain('ob_queue_dead_letter_size{queue="test.flaky"} 0');
      expect(text).toContain('ob_queue_oldest_ready_seconds{queue="test.idle"}');
      expect((await fetch(`http://127.0.0.1:${String(port)}/other`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('[NFR-3] a job whose data fails validation goes to the DLQ without burning retries', async () => {
    const boss = await startBoss();
    let runs = 0;
    await queueOn(boss).work(
      onceJob,
      () => {
        runs += 1;
        return Promise.resolve();
      },
      FAST,
    );
    // Sent around JobQueue on purpose: no envelope at all.
    await boss.send('test.once', { not: 'an envelope' });
    await expect
      .poll(async () => (await boss.getQueueStats('test.once.dlq'))[0]?.queuedCount ?? 0, {
        timeout: 30_000,
      })
      .toBe(1);
    expect(runs).toBe(0);
  });

  it('[NFR-3] a stuck job is cut off by the worker transaction timeouts', async () => {
    // The worker's settings (WORKER_TX_TIMEOUTS), shortened so the test runs in seconds.
    const short = createMainDb({
      ...cluster.connection('ob_app'),
      max: 2,
      ...txTimeouts({ statementMs: 1_000, idleInTransactionMs: 1_000 }),
    });
    try {
      const boss = await startBoss();
      const failures = new Map<string, string>();
      await queueOn(boss, short).work(
        stuckJob,
        async (job) => {
          const query = (text: string) =>
            withTenantTransaction(short.db, job.ctx, (trx) => sql.raw(text).execute(trx));
          try {
            if (job.payload.mode === 'slow') {
              await query('SELECT pg_sleep(5)');
            } else {
              await query('SELECT 1');
              await new Promise((resolve) => setTimeout(resolve, 2_500)); // idle in transaction
              await query('SELECT 1');
            }
          } catch (err) {
            failures.set(job.payload.mode, String(err));
            throw err;
          }
        },
        FAST,
      );
      for (const mode of ['idle', 'slow'] as const) {
        await queueOn(boss, short).send(stuckJob, {
          ctx: ws,
          idempotencyKey: `stuck-${mode}`,
          payload: { mode },
        });
      }
      for (const mode of ['idle', 'slow']) {
        await expect
          .poll(async () => (await record('test.stuck', `stuck-${mode}`))?.state, {
            timeout: 60_000,
          })
          .toBe('failed');
      }
      expect(failures.get('slow')).toMatch(/statement timeout/);
      expect(failures.get('idle')).toMatch(/idle-in-transaction|terminat|not queryable/i);
    } finally {
      await short.destroy();
    }
  });

  it('[NFR-3] platform cron jobs are registered on Europe/London time', async () => {
    const boss = await startBoss();
    // The heartbeat queue already exists (the migrate job made it); reuse it for a nightly schedule.
    const nightly = definePlatformJob({ type: HEARTBEAT_QUEUE, cron: '15 3 * * *', heavy: true });
    await schedulePlatformJob(boss, nightly);
    expect(await boss.getSchedules()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: HEARTBEAT_QUEUE,
          cron: '15 3 * * *',
          timezone: 'Europe/London',
        }),
      ]),
    );
  });
});
