import { randomUUID } from 'node:crypto';
import {
  AuditLog,
  createMainDb,
  JobLeaseRepository,
  JobRecordRepository,
  migrateMain,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { WorkspaceDirectory } from '@omnibridge/db/platform';
import { createLogger } from '@omnibridge/logger';
import { auditRetentionJob, JobQueue } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRetentionHandler, sweepAuditRetention } from './audit-retention.ts';
import { registerPlatformHandlers } from './platform-jobs.ts';
import { createWorkerBoss } from './heartbeat.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });

describe('audit retention job (AUD-3)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let platform: MainDbHandle;
  let owner: pg.Pool;
  let boss: PgBoss;
  const workspaces = [randomUUID(), randomUUID()];

  /** Counts a workspace's events as ob_owner, old (past 6 years) and recent. */
  const counts = async (workspaceId: string) => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const { rows } = await client.query<{ old: string; recent: string }>(
        `SELECT count(*) FILTER (WHERE occurred_at < now() - interval '6 years') AS old,
                count(*) FILTER (WHERE occurred_at >= now() - interval '6 years') AS recent
           FROM app.audit_events`,
      );
      return rows[0];
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_worker',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    // The worker's own role (ADR-049): only it may run the purge.
    main = createMainDb({ ...cluster.connection('ob_worker'), max: 4 });
    platform = createMainDb({ ...cluster.connection('ob_platform'), max: 1 });
    owner = new pg.Pool({ ...cluster.connection('ob_owner'), max: 1 });
    const tenancy = new Tenancy(main.db);
    for (const workspaceId of workspaces) {
      await tenancy.run({ workspaceId, companyIds: [] }, (ctx) =>
        new WorkspaceRepository(main.db).create(ctx, { name: 'Retention test' }),
      );
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        for (const when of ["now() - interval '6 years 2 days'", "now() - interval '1 day'"]) {
          await client.query(
            `INSERT INTO app.audit_events (workspace_id, occurred_at, actor_kind, action,
                                           entity_type)
             VALUES ($1, ${when}, 'system', 'auth.login', 'user')`,
            [workspaceId],
          );
        }
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
    boss = createWorkerBoss(cluster.connection('ob_worker'), {
      monitorIntervalSeconds: 1,
      superviseIntervalSeconds: 1,
    });
    boss.on('error', () => undefined);
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
    await owner.end();
    await platform.destroy();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[AUD-3] the sweep sends one job per workspace, and each deletes only expired events', async () => {
    const queue = new JobQueue({
      boss,
      records: new JobRecordRepository(main.db),
      limiter: new JobLeaseRepository(main.db),
      tenancy: new Tenancy(main.db),
      logger,
    });
    await queue.work(auditRetentionJob, auditRetentionHandler(new AuditLog(main.db), logger), {
      pollingIntervalSeconds: 0.5,
    });
    const directory = new WorkspaceDirectory(platform.db);
    const now = new Date();
    expect(await sweepAuditRetention({ directory, queue, now })).toBe(workspaces.length);
    for (const workspaceId of workspaces) {
      await expect
        .poll(async () => (await counts(workspaceId))?.old, { timeout: 30_000 })
        .toBe('0');
      expect((await counts(workspaceId))?.recent).toBe('1');
    }
    // A second sweep the same day sends nothing new: the London date is the idempotency key.
    const sent: boolean[] = [];
    await sweepAuditRetention({
      directory,
      queue: {
        send: async (def, input) => {
          const result = await queue.send(def, input);
          sent.push(result.created);
          return result;
        },
      },
      now,
    });
    expect(sent).toEqual(workspaces.map(() => false));
  });

  it('[AUD-3] the worker schedules the sweep at 02:30 London time', async () => {
    await registerPlatformHandlers(
      boss,
      { 'audit.retention-sweep': () => Promise.resolve() },
      logger,
    );
    expect(await boss.getSchedules()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'audit.retention-sweep',
          cron: '30 2 * * *',
          timezone: 'Europe/London',
        }),
      ]),
    );
    // A platform job without a handler stops the worker at boot.
    await expect(registerPlatformHandlers(boss, {}, logger)).rejects.toThrow(
      /audit.retention-sweep/,
    );
  });
});
