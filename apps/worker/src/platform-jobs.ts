import { createMainDb, type PoolErrorHandler } from '@omnibridge/db';
// The only worker module allowed to hold ob_platform (dependency-cruiser, ADR-049).
import { platformDbConfig, WorkspaceDirectory } from '@omnibridge/db/platform';
import type { Logger } from '@omnibridge/logger';
import { PLATFORM_JOBS, schedulePlatformJob, type JobQueue } from '@omnibridge/queue';
import type { PgBoss } from 'pg-boss';
import { sweepAuditRetention } from './audit-retention.ts';

/**
 * Schedules every platform job in PLATFORM_JOBS on its London cron and consumes it. A platform
 * job has no workspace: it fans out to workspace jobs, which carry the envelope (invariant 12).
 * A type without a handler stops the worker at boot.
 */
export async function registerPlatformHandlers(
  boss: PgBoss,
  handlers: Readonly<Record<string, () => Promise<void>>>,
  logger: Logger,
): Promise<void> {
  for (const def of PLATFORM_JOBS) {
    const handler = handlers[def.type];
    if (handler === undefined) throw new Error(`Platform job ${def.type} has no handler`);
    await schedulePlatformJob(boss, def);
    // One job per fetch (the pg-boss default batch size), so one handler call per job.
    await boss.work(def.type, async () => {
      try {
        await handler();
      } catch (err) {
        // pg-boss retries it; the log makes a sweep that keeps failing visible.
        logger.error(
          { event: 'platform_job.failed', jobName: def.type, err },
          'platform job failed',
        );
        throw err;
      }
    });
  }
}

/**
 * Opens the worker's one ob_platform connection (the workspace id list, invariant 2) and starts
 * the platform jobs that fan out over it. Returns the function that closes the connection.
 */
export async function startPlatformJobs({
  boss,
  queue,
  logger,
  onDbError,
}: {
  boss: PgBoss;
  queue: Pick<JobQueue, 'send'>;
  logger: Logger;
  onDbError: PoolErrorHandler;
}): Promise<() => Promise<void>> {
  const platformDb = createMainDb(platformDbConfig('omnibridge-worker-fanout'), onDbError);
  const directory = new WorkspaceDirectory(platformDb.db);
  await registerPlatformHandlers(
    boss,
    {
      'audit.retention-sweep': async () => {
        const workspaces = await sweepAuditRetention({ directory, queue });
        logger.info({ event: 'audit.retention_sweep', count: workspaces }, 'audit retention sent');
      },
    },
    logger,
  );
  return () => platformDb.destroy();
}
