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
 * Every workspace job type the app runs. The migrate job creates a queue and a dead-letter queue
 * for each one as ob_owner (ADR-032), and the worker registers a handler for each. Provider
 * modules add their job types here (M07 onwards).
 */
export const JOBS: readonly JobDefinition[] = [filesScanJob, auditRetentionJob];

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
