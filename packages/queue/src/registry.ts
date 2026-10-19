import { z } from 'zod';
import { defineJob, type JobDefinition } from './job.ts';

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
 * Every workspace job type the app runs. The migrate job creates a queue and a dead-letter queue
 * for each one as ob_owner (ADR-032), and the worker registers a handler for each. Provider
 * modules add their job types here (M07 onwards).
 */
export const JOBS: readonly JobDefinition[] = [filesScanJob];
