/**
 * Job envelope, policies and scheduler helpers (T-0104, ADR-009). Queues are created by the
 * migrate job as ob_owner; the worker consumes them as ob_app.
 */
import { PgBoss, type ConstructorOptions } from 'pg-boss';

export const PACKAGE_NAME = '@omnibridge/queue';

/** pg-boss schema in db-main (ADR-009). Installed by the migrate job as ob_owner. */
export const QUEUE_SCHEMA = 'pgboss';

/** Platform heartbeat: no workspace, runs every minute, proves the worker is consuming jobs. */
export const HEARTBEAT_QUEUE = 'platform-heartbeat';
export const HEARTBEAT_CRON = '* * * * *';

/**
 * A pg-boss that only sends (web): no maintenance, no cron and no DDL, which stay with the
 * worker and the migrate job (ADR-032). Two connections are enough for the jobs web enqueues.
 */
export function createQueueClient(connection: ConstructorOptions): PgBoss {
  return new PgBoss({
    ...connection,
    schema: QUEUE_SCHEMA,
    max: 2,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    reindex: false,
  });
}

export {
  assertHeavyCron,
  deadLetterName,
  deadLetterOptions,
  DEFAULT_HEAVY_WINDOW,
  defineJob,
  definePlatformJob,
  JobDefinitionError,
  parseEnvelope,
  queueOptions,
  schedulePlatformJob,
  type HeavyWindow,
  type JobDefinition,
  type JobDefinitionInput,
  type JobEnvelope,
  type PlatformJobDefinition,
  type RetryPolicy,
} from './job.ts';
export {
  JobQueue,
  PermanentJobError,
  type ConcurrencyLimiter,
  type JobHandler,
  type JobRecordPatch,
  type JobRecordStore,
  type JobState,
  type PhasedHandler,
  type PreparingJob,
  type RunningJob,
  type SendInput,
  type WorkTuning,
} from './runtime.ts';
export { queueMetrics, type QueueMetricsOptions } from './metrics.ts';
export {
  auditRetentionJob,
  authLockNoticeJob,
  accessReviewJob,
  accessReviewSweepJob,
  housekeepingSweepJob,
  jobsRetentionJob,
  authInviteJob,
  authPasswordResetJob,
  auditRetentionSweepJob,
  filesScanJob,
  JOBS,
  notifyEmailJob,
  notifyPlatformEmailSweepJob,
  notifyRetentionJob,
  piiDeleteJob,
  piiExpiryJob,
  piiExpirySweepJob,
  PLATFORM_JOBS,
  platformDigestJob,
  securityScanJob,
  securityScanSweepJob,
  workspaceCloseJob,
} from './registry.ts';
export { JobAdmin, type DeadLetter, type QueueOverview, type RedriveOutcome } from './admin.ts';
export { deletionRunId, requestDeletion, type DeletionRequest } from './deletion.ts';
export { emailOnRaise, type EmailRecipients } from './notify.ts';
