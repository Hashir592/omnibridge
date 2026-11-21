import { randomUUID } from 'node:crypto';
import {
  AuditLog,
  AuthStore,
  createMainDb,
  PlatformHousekeeping,
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
import { sweepHousekeeping } from './housekeeping.ts';
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

  it('[NFR-3][USR-6] the housekeeping sweep purges as ob_worker and sends one jobs.retention and one notify.retention per workspace, keyed by the London day', async () => {
    const sent: { type: string; workspaceId: string; key: string }[] = [];
    const count = await sweepHousekeeping({
      auth: new AuthStore(main.db),
      notices: new PlatformHousekeeping(main.db),
      directory: new WorkspaceDirectory(platform.db),
      queue: {
        send: (def, input) => {
          sent.push({
            type: def.type,
            workspaceId: input.ctx.workspaceId,
            key: input.idempotencyKey,
          });
          return Promise.resolve({ id: randomUUID(), created: true });
        },
      },
      logger,
      now: new Date('2026-11-16T23:30:00Z'),
    });
    expect(count).toBe(workspaces.length);
    expect(sent).toEqual(
      expect.arrayContaining(
        workspaces.map((workspaceId) => ({
          type: 'jobs.retention',
          workspaceId,
          key: 'jobs.retention:2026-11-16',
        })),
      ),
    );
    expect(sent).toEqual(
      expect.arrayContaining(
        workspaces.map((workspaceId) => ({
          type: 'notify.retention',
          workspaceId,
          key: 'notify.retention:2026-11-16',
        })),
      ),
    );
  });

  it('[AUD-3] the worker schedules the sweep at 02:30 London time', async () => {
    await registerPlatformHandlers(
      boss,
      {
        'audit.retention-sweep': () => Promise.resolve(),
        'users.access-review-sweep': () => Promise.resolve(),
        'housekeeping.daily-sweep': () => Promise.resolve(),
        'pii.expiry-sweep': () => Promise.resolve(),
        'notify.platform-email-sweep': () => Promise.resolve(),
        'security.scan-sweep': () => Promise.resolve(),
        'platform.health-digest': () => Promise.resolve(),
        'outbound.recover-sweep': () => Promise.resolve(),
        'listings.discover-sweep': () => Promise.resolve(),
      },
      logger,
    );
    expect(await boss.getSchedules()).toEqual(
      expect.arrayContaining([
        // T-0702: the outbound safety net, every ten minutes.
        expect.objectContaining({ name: 'outbound.recover-sweep', cron: '*/10 * * * *' }),
        // T-0801: daily listing discovery (CAT-5), in the heavy window.
        expect.objectContaining({ name: 'listings.discover-sweep', cron: '15 3 * * *' }),
        expect.objectContaining({
          name: 'audit.retention-sweep',
          cron: '30 2 * * *',
          timezone: 'Europe/London',
        }),
        expect.objectContaining({
          name: 'users.access-review-sweep',
          cron: '0 3 * * *',
          timezone: 'Europe/London',
        }),
        expect.objectContaining({
          name: 'housekeeping.daily-sweep',
          cron: '45 2 * * *',
          timezone: 'Europe/London',
        }),
        // DEL-1: the PII expiry sweep runs every hour (ARCHITECTURE 6.2).
        expect.objectContaining({
          name: 'pii.expiry-sweep',
          cron: '5 * * * *',
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
