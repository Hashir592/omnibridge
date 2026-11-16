import { londonDate } from '@omnibridge/core';
import type { AuthStore, JobRecordRepository } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { jobsRetentionJob, type JobHandler, type JobQueue } from '@omnibridge/queue';

/** Finished job records and expired leases are kept this long (F-M01-end-05). */
export const JOB_RECORD_RETENTION_DAYS = 30;

/** jobs.retention for one workspace: finished records and expired leases past retention. */
export function jobsRetentionHandler(deps: {
  records: Pick<JobRecordRepository, 'purge'>;
  logger: Logger;
  now?: () => Date;
}): JobHandler<Record<string, never>> {
  return async (job) => {
    const now = (deps.now ?? (() => new Date()))();
    const cutOff = new Date(now.getTime() - JOB_RECORD_RETENTION_DAYS * 86_400_000);
    const { records, leases } = await deps.records.purge(job.ctx, cutOff);
    deps.logger.info(
      { event: 'jobs.retention', workspaceId: job.ctx.workspaceId, count: records + leases },
      'job records and leases past retention deleted',
    );
    return { records, leases };
  };
}

/**
 * The daily housekeeping sweep (T-0207). Sessions and reset links belong to users, not to a
 * workspace, so they are purged here in one short call; job records are per workspace, so one
 * jobs.retention job goes to each, keyed by the London date (a second sweep that day sends none).
 */
export async function sweepHousekeeping({
  auth,
  directory,
  queue,
  logger,
  now = new Date(),
}: {
  auth: Pick<AuthStore, 'purgeExpired'>;
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  logger: Logger;
  now?: Date;
}): Promise<number> {
  // Independent of the fan-out below: a failure here is reported after the jobs are sent.
  let authError: Error | undefined;
  try {
    const { sessions, resets } = await auth.purgeExpired();
    logger.info(
      { event: 'auth.retention', count: sessions + resets },
      `ended sessions (${String(sessions)}) and reset links (${String(resets)}) deleted`,
    );
  } catch (err) {
    authError = err instanceof Error ? err : new Error(String(err));
  }
  const day = londonDate(now);
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(jobsRetentionJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `jobs.retention:${day}`,
      payload: {},
    });
  }
  if (authError !== undefined) throw authError;
  return ids.length;
}
