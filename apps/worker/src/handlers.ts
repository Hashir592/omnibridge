import { JOBS, type JobHandler, type JobQueue } from '@omnibridge/queue';

/**
 * Handlers for the registered job types, keyed by type. Provider modules add theirs (M07 on).
 * Every type in JOBS must have one, so a queue the migrate job created is never left unconsumed.
 */
export const HANDLERS: Readonly<Record<string, JobHandler<unknown>>> = {};

export async function registerHandlers(
  queue: JobQueue,
  handlers: Readonly<Record<string, JobHandler<unknown>>> = HANDLERS,
): Promise<void> {
  for (const def of JOBS) {
    const handler = handlers[def.type];
    if (handler === undefined) throw new Error(`Job type ${def.type} has no handler`);
    await queue.work(def, handler);
  }
}
