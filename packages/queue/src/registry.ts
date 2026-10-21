import { z } from 'zod';
import {
  defineJob,
  definePlatformJob,
  type JobDefinition,
  type PlatformJobDefinition,
} from './job.ts';

/**
 * Virus scan of an uploaded file (SEC-2, T-0105). If clamd is unreachable the job fails and
 * retries with backoff, and the file stays `scanning`: never clean by default (ADR-021).
 */
export const filesScanJob = defineJob({
  type: 'files.scan',
  payload: z.object({ file_id: z.uuid() }),
  retry: { limit: 8, delaySeconds: 15, backoff: true, maxDelaySeconds: 1_800 },
  expireInSeconds: 600,
});

/**
 * Audit retention for one workspace (AUD-3): deletes its events older than 6 years. Sent once a
 * day per workspace by the sweep below; running it twice the same day deletes nothing more.
 */
export const auditRetentionJob = defineJob({
  type: 'audit.retention',
  payload: z.object({}),
  retry: { limit: 5, delaySeconds: 60, backoff: true, maxDelaySeconds: 3_600 },
  expireInSeconds: 900,
});

/**
 * Lock notice (USR-5): the worker emails the locked user and the admins of this workspace. Web
 * only enqueues it, so a lock costs the same time for a real email and an unknown one (ADR-050).
 */
export const authLockNoticeJob = defineJob({
  type: 'auth.lock_notice',
  payload: z.object({ user_id: z.uuid(), locked_until: z.iso.datetime() }),
  retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 900 },
  expireInSeconds: 120,
});

/**
 * Password reset email (USR-7): the worker makes the 30-minute token and sends the link, so the
 * token never sits in the queue or the database.
 */
export const authPasswordResetJob = defineJob({
  type: 'auth.password_reset',
  payload: z.object({ user_id: z.uuid() }),
  // Few retries: a link sent late is little use, and the user can ask again.
  retry: { limit: 2, delaySeconds: 30 },
  expireInSeconds: 120,
});

/**
 * Every workspace job type the app runs. The migrate job creates a queue and a dead-letter queue
 * for each one as ob_owner (ADR-032), and the worker registers a handler for each. Provider
 * modules add their job types here (M07 onwards).
 */
export const JOBS: readonly JobDefinition[] = [
  filesScanJob,
  auditRetentionJob,
  authLockNoticeJob,
  authPasswordResetJob,
];

/**
 * The daily audit retention sweep (AUD-3): lists every workspace as ob_platform and sends one
 * audit.retention job each. Heavy, so it runs in the low-traffic window (02:30 London).
 */
export const auditRetentionSweepJob = definePlatformJob({
  type: 'audit.retention-sweep',
  cron: '30 2 * * *',
  heavy: true,
});

/**
 * Every platform job with a cron (no workspace). The migrate job creates their queues, and the
 * worker schedules and consumes each one.
 */
export const PLATFORM_JOBS: readonly PlatformJobDefinition[] = [auditRetentionSweepJob];
