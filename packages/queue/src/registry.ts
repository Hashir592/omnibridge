import type { JobDefinition } from './job.ts';

/**
 * Every workspace job type the app runs. The migrate job creates a queue and a dead-letter queue
 * for each one as ob_owner (ADR-032), and the worker registers a handler for each. Provider
 * modules add their job types here (M07 onwards).
 */
export const JOBS: readonly JobDefinition[] = [];
