import type { PgBoss } from 'pg-boss';
import { Gauge, Registry } from 'prom-client';
import { deadLetterName } from './job.ts';

export interface QueueMetricsOptions {
  boss: PgBoss;
  /** Job types to report; each one's dead-letter queue is reported too. */
  types: readonly string[];
}

/**
 * Queue metrics for the worker's /metrics endpoint (ADR-017): depth, age of the oldest ready
 * job, failures and dead-letter size per job type. Read on every scrape, in one query, from the
 * queue counts pg-boss's supervisor refreshes each monitor interval, so a value can lag by that much
 * and no scrape ever counts job rows.
 */
export function queueMetrics({ boss, types }: QueueMetricsOptions): Registry {
  const registry = new Registry();
  const labelNames = ['queue'] as const;
  const gauge = (name: string, help: string) =>
    new Gauge({ name, help, labelNames, registers: [registry] });
  // prom-client serialises gauges in registration order, so the first one reads pg-boss and
  // fills in the rest before they are written out.
  new Gauge({
    name: 'ob_queue_depth',
    help: 'Jobs waiting to run, including deferred and retrying ones',
    labelNames,
    registers: [registry],
    async collect() {
      const names = types.flatMap((type) => [type, deadLetterName({ type })]);
      if (names.length === 0) return;
      const queues = new Map((await boss.getQueues(names)).map((q) => [q.name, q]));
      for (const type of types) {
        const q = queues.get(type);
        const labels = { queue: type };
        // pg-boss counts deferred jobs inside queuedCount (every state before active).
        this.set(labels, q?.queuedCount ?? 0);
        active.set(labels, q?.activeCount ?? 0);
        oldest.set(labels, q?.readyOldestSeconds ?? 0);
        failed.set(labels, q?.failedCount ?? 0);
        dlq.set(labels, queues.get(deadLetterName({ type }))?.queuedCount ?? 0);
      }
    },
  });
  const active = gauge('ob_queue_active', 'Jobs running now');
  const oldest = gauge('ob_queue_oldest_ready_seconds', 'Age of the oldest job ready to run');
  const failed = gauge('ob_queue_failed', 'Jobs in the failed state');
  const dlq = gauge('ob_queue_dead_letter_size', 'Jobs waiting in the dead-letter queue');
  return registry;
}
