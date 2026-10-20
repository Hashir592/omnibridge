import { londonDate } from '@omnibridge/core';
import type { AuditLog } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { auditRetentionJob, type JobHandler, type JobQueue } from '@omnibridge/queue';

/**
 * audit.retention for one workspace (AUD-3): deletes its events older than 6 years in the job's
 * tenant transaction, through the only function allowed to (migration 0010).
 */
export function auditRetentionHandler(
  audit: Pick<AuditLog, 'purgeExpired'>,
  logger: Logger,
): JobHandler<Record<string, never>> {
  return async (job) => {
    const deleted = await audit.purgeExpired(job.ctx);
    logger.info(
      { event: 'audit.retention', workspaceId: job.ctx.workspaceId, count: deleted },
      'audit events past retention deleted',
    );
    return { deleted };
  };
}

/**
 * The daily sweep: one audit.retention job per workspace, keyed by the London date, so a second
 * sweep on the same day sends nothing new. Returns how many workspaces it covered.
 */
export async function sweepAuditRetention({
  directory,
  queue,
  now = new Date(),
}: {
  /** The workspace id list (WorkspaceDirectory, read as ob_platform). */
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const day = londonDate(now);
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(auditRetentionJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `audit.retention:${day}`,
      payload: {},
    });
  }
  return ids.length;
}
