import { HEARTBEAT_QUEUE, QUEUE_SCHEMA } from '@omnibridge/queue';
import type { PoolConfig } from 'pg';
import { PgBoss, type ConstructorOptions } from 'pg-boss';

/**
 * Installs or upgrades the pg-boss schema and creates the platform queues. Runs as ob_owner in
 * the migrate job: pg-boss does DDL here (schema, tables, one partition per queue), which ob_app
 * is not allowed to do.
 */
export async function installQueueSchema(owner: PoolConfig): Promise<void> {
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
    if ((await boss.getQueue(HEARTBEAT_QUEUE)) === null) {
      await boss.createQueue(HEARTBEAT_QUEUE, {
        retentionSeconds: 3_600,
        deleteAfterSeconds: 3_600,
      });
    }
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
