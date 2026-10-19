import { utimes, writeFile } from 'node:fs/promises';
import type { Logger } from '@omnibridge/logger';
import { HEARTBEAT_CRON, HEARTBEAT_QUEUE, QUEUE_SCHEMA } from '@omnibridge/queue';
import { PgBoss, type ConstructorOptions } from 'pg-boss';

/**
 * pg-boss as ob_app. ob_app may not run DDL, so everything that needs it is off here and done by
 * the migrate job instead: schema install and upgrades (migrate, createSchema), queue creation,
 * and index rebuilds (reindex needs table ownership).
 */
export function createWorkerBoss(
  connection: ConstructorOptions,
  overrides: Pick<ConstructorOptions, 'monitorIntervalSeconds' | 'superviseIntervalSeconds'> = {},
): PgBoss {
  return new PgBoss({
    ...connection,
    ...overrides,
    schema: QUEUE_SCHEMA,
    max: 8,
    migrate: false,
    createSchema: false,
    reindex: false,
  });
}

export interface HeartbeatOptions {
  boss: PgBoss;
  log: Logger;
  /** Touched on start and on every heartbeat; the container healthcheck reads its age. */
  healthFile: string;
}

/** Schedules the platform heartbeat every minute and consumes it. */
export async function startHeartbeat({ boss, log, healthFile }: HeartbeatOptions): Promise<void> {
  await touch(healthFile);
  await boss.schedule(HEARTBEAT_QUEUE, HEARTBEAT_CRON, null, { tz: 'UTC' });
  await boss.work(HEARTBEAT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      log.info({ event: 'heartbeat', jobId: job.id, queue: HEARTBEAT_QUEUE }, 'heartbeat');
    }
    await touch(healthFile);
  });
}

async function touch(file: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(file, now, now);
  } catch {
    await writeFile(file, now.toISOString());
  }
}
