/**
 * Job envelope, policies and scheduler helpers (T-0104, ADR-009). Queues are created by the
 * migrate job as ob_owner; the worker consumes them as ob_app.
 */
export const PACKAGE_NAME = '@omnibridge/queue';

/** pg-boss schema in db-main (ADR-009). Installed by the migrate job as ob_owner. */
export const QUEUE_SCHEMA = 'pgboss';

/** Platform heartbeat: no workspace, runs every minute, proves the worker is consuming jobs. */
export const HEARTBEAT_QUEUE = 'platform-heartbeat';
export const HEARTBEAT_CRON = '* * * * *';

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
  type ConcurrencyLimiter,
  type JobHandler,
  type JobRecordPatch,
  type JobRecordStore,
  type JobState,
  type RunningJob,
  type SendInput,
  type WorkTuning,
} from './runtime.ts';
export { queueMetrics, type QueueMetricsOptions } from './metrics.ts';
export { JOBS } from './registry.ts';
