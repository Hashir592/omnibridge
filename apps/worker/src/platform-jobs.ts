import {
  createMainDb,
  type AuthStore,
  type PlatformHousekeeping,
  type PoolErrorHandler,
} from '@omnibridge/db';
// The only worker module allowed to hold ob_platform (dependency-cruiser, ADR-049).
import { platformDbConfig, WorkspaceDirectory } from '@omnibridge/db/platform';
import type { Logger } from '@omnibridge/logger';
import { PLATFORM_JOBS, schedulePlatformJob, type JobQueue } from '@omnibridge/queue';
import type { PgBoss } from 'pg-boss';
import { sweepAuditRetention } from './audit-retention.ts';
import { sweepPiiExpiry } from './deletion.ts';
import { sweepHousekeeping } from './housekeeping.ts';
import { sweepSecurityScan } from './security.ts';
import { sweepAccessReviews } from './users-jobs.ts';

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
  auth,
  logger,
  onDbError,
  sendPlatformEmails,
  notices,
  sendDigest,
  scanPlatform,
  recoverOutbound,
}: {
  boss: PgBoss;
  queue: Pick<JobQueue, 'send'>;
  /** The worker's own role (ob_worker), the only one allowed to purge sessions and resets. */
  auth: Pick<AuthStore, 'purgeExpired'>;
  logger: Logger;
  onDbError: PoolErrorHandler;
  /** Emails critical platform notices to platform admins (T-0502); returns how many were sent. */
  sendPlatformEmails: () => Promise<number>;
  /** Resolved platform notices past retention (ADR-071 4a), as ob_worker. */
  notices: Pick<PlatformHousekeeping, 'purgePlatformNotices'>;
  /** OPS-6: the daily health digest; returns how many were sent. */
  sendDigest: () => Promise<number>;
  /** SEC-12: the platform-level security rule (T-0507); returns how many notices it raised. */
  scanPlatform: () => Promise<number>;
  /** T-0702: one outbound.recover job per workspace; returns how many were sent. */
  recoverOutbound: (directory: { listIds(): Promise<string[]> }) => Promise<number>;
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
      'users.access-review-sweep': async () => {
        const workspaces = await sweepAccessReviews({ directory, queue });
        logger.info({ event: 'users.access_review_sweep', count: workspaces }, 'reviews sent');
      },
      'pii.expiry-sweep': async () => {
        const workspaces = await sweepPiiExpiry({ directory, queue });
        logger.info({ event: 'pii.expiry_sweep', count: workspaces }, 'PII expiry sent');
      },
      'housekeeping.daily-sweep': async () => {
        const workspaces = await sweepHousekeeping({ auth, notices, directory, queue, logger });
        logger.info({ event: 'housekeeping.sweep', count: workspaces }, 'job retention sent');
      },
      'security.scan-sweep': async () => {
        await sweepSecurityScan({ directory, queue });
        // Platform admins' sign-ins have no workspace: one run per sweep (ADR-076).
        await scanPlatform();
      },
      'platform.health-digest': async () => {
        await sendDigest();
      },
      'outbound.recover-sweep': async () => {
        await recoverOutbound(directory);
      },
      'notify.platform-email-sweep': async () => {
        const sent = await sendPlatformEmails();
        if (sent > 0) logger.info({ event: 'notify.platform_emails', count: sent }, 'sent');
      },
    },
    logger,
  );
  return () => platformDb.destroy();
}
