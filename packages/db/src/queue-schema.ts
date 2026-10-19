import {
  deadLetterOptions,
  HEARTBEAT_QUEUE,
  JOBS,
  QUEUE_SCHEMA,
  queueOptions,
  type JobDefinition,
} from '@omnibridge/queue';
import type { PoolConfig } from 'pg';
import { PgBoss, type ConstructorOptions } from 'pg-boss';

/**
 * Installs or upgrades the pg-boss schema and creates the platform queues and every registered
 * job queue (JOBS). Runs as ob_owner in the migrate job: pg-boss does DDL here (schema, tables,
 * one partition per queue), which ob_app is not allowed to do (ADR-032).
 */
export async function installQueueSchema(owner: PoolConfig): Promise<void> {
  await withOwnerBoss(owner, async (boss) => {
    if ((await boss.getQueue(HEARTBEAT_QUEUE)) === null) {
      await boss.createQueue(HEARTBEAT_QUEUE, {
        retentionSeconds: 3_600,
        deleteAfterSeconds: 3_600,
      });
    }
    await ensureQueues(boss, JOBS);
  });
}

/**
 * Creates the queue and dead-letter queue of each job type, as ob_owner. Existing queues get the
 * definition's retry settings again, so a changed policy reaches the database on the next deploy.
 * Exported for tests that define their own job types.
 */
export async function createQueues(
  owner: PoolConfig,
  defs: readonly JobDefinition[],
): Promise<void> {
  await withOwnerBoss(owner, (boss) => ensureQueues(boss, defs));
}

async function ensureQueues(boss: PgBoss, defs: readonly JobDefinition[]): Promise<void> {
  for (const def of defs) {
    const dlq = deadLetterOptions(def);
    if ((await boss.getQueue(dlq.name)) === null) await boss.createQueue(dlq.name, dlq);
    const options = queueOptions(def);
    if ((await boss.getQueue(options.name)) === null) {
      await boss.createQueue(options.name, options);
    } else {
      // Policy, dead-letter target, retryDelayMax and heartbeat are fixed at creation in pg-boss.
      await boss.updateQueue(options.name, {
        retryLimit: def.retry.limit,
        retryDelay: def.retry.delaySeconds,
        retryBackoff: def.retry.backoff ?? false,
        expireInSeconds: def.expireInSeconds,
      });
    }
  }
}

async function withOwnerBoss(
  owner: PoolConfig,
  fn: (boss: PgBoss) => Promise<void>,
): Promise<void> {
  const boss = new PgBoss({
    ...connection(owner),
    schema: QUEUE_SCHEMA,
    max: 2,
    supervise: false,
    schedule: false,
    registerInstance: false,
  });
  let failure: unknown;
  boss.on('error', (err) => {
    failure = err;
  });
  try {
    // start() installs or upgrades the schema; it sits inside try so the pool closes on failure.
    await boss.start();
    await fn(boss);
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
  if (failure !== undefined) throw new Error('pg-boss reported an error', { cause: failure });
}

/** pg PoolConfig → pg-boss connection options, leaving unset fields out entirely. */
export function connection(config: PoolConfig): ConstructorOptions {
  const options: ConstructorOptions = {};
  if (config.host !== undefined) options.host = config.host;
  if (config.port !== undefined) options.port = config.port;
  if (config.database !== undefined) options.database = config.database;
  if (config.user !== undefined) options.user = config.user;
  if (typeof config.password === 'string') options.password = config.password;
  if (config.application_name !== undefined) options.application_name = config.application_name;
  return options;
}
