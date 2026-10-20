import {
  JOBS,
  PLATFORM_JOBS,
  schedulePlatformJob,
  type JobHandler,
  type JobQueue,
} from '@omnibridge/queue';
import type { Logger } from '@omnibridge/logger';
import type { PgBoss } from 'pg-boss';

/**
 * Registers a handler for every job type in JOBS. A type without one stops the worker at boot, so
 * a queue the migrate job created is never left unconsumed. Provider modules add theirs (M07 on).
 */
export async function registerHandlers(
  queue: JobQueue,
  handlers: Readonly<Record<string, JobHandler<never>>>,
): Promise<void> {
  for (const def of JOBS) {
    const handler = handlers[def.type];
    if (handler === undefined) throw new Error(`Job type ${def.type} has no handler`);
    await queue.work(def, handler as JobHandler<unknown>);
  }
}

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
