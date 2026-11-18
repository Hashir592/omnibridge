import { JOBS, type JobHandler, type JobQueue, type PhasedHandler } from '@omnibridge/queue';

/**
 * Registers a handler for every job type in JOBS. A type without one stops the worker at boot, so
 * a queue the migrate job created is never left unconsumed. Provider modules add theirs (M07 on).
 */
export async function registerHandlers(
  queue: JobQueue,
  handlers: Readonly<Record<string, JobHandler<never> | PhasedHandler<never, unknown>>>,
): Promise<void> {
  for (const def of JOBS) {
    const handler = handlers[def.type];
    if (handler === undefined) throw new Error(`Job type ${def.type} has no handler`);
    await queue.work(def, handler as JobHandler<unknown> | PhasedHandler<unknown, unknown>);
  }
}
