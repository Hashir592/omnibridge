import { readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  createPool,
  JobLeaseRepository,
  JobRecordRepository,
  mainDbConfig,
  type MainDb,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { JOBS, JobQueue, queueMetrics } from '@omnibridge/queue';
import { Kysely, PostgresDialect } from 'kysely';
import { registerHandlers } from './handlers.ts';
import { createWorkerBoss, startHeartbeat } from './heartbeat.ts';
import { startMetricsServer } from './metrics-server.ts';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
const log = createLogger({ service: 'worker', version });
// Fail at boot, not at first use, if the secrets master key is missing or malformed (SEC-6).
const secretsKeyring = loadKeyring('secrets');
log.info(
  { event: 'keyring.loaded', kekVersion: secretsKeyring.activeVersion },
  'secrets KEK loaded',
);

const boss = createWorkerBoss({
  host: requireEnv('DB_MAIN_HOST'),
  port: Number(process.env.DB_MAIN_PORT ?? '5432'),
  database: requireEnv('DB_MAIN_NAME'),
  user: requireEnv('DB_MAIN_USER'),
  password: readSecretFile('DB_MAIN_PASSWORD'),
  application_name: 'omnibridge-worker',
});
boss.on('error', (err) => {
  log.error({ err, event: 'queue.error' }, 'pg-boss error');
});

// Job records and lease slots, as ob_app inside tenant transactions.
const db = new Kysely<MainDb>({
  dialect: new PostgresDialect({ pool: createPool(mainDbConfig('omnibridge-worker-jobs', 4)) }),
});
const queue = new JobQueue({
  boss,
  records: new JobRecordRepository(db),
  limiter: new JobLeaseRepository(db),
  globalConcurrency: Number(process.env.WORKER_CONCURRENCY ?? '8'),
  logger: log,
});

await boss.start();
await startHeartbeat({
  boss,
  log,
  healthFile: process.env.WORKER_HEALTH_FILE ?? '/tmp/worker-heartbeat',
});
await registerHandlers(queue);
const metrics = await startMetricsServer(
  queueMetrics({ boss, types: JOBS.map((def) => def.type) }),
  Number(process.env.METRICS_PORT ?? '9464'),
);
log.info({ event: 'worker.started' }, 'worker started');

// Docker allows 30 s (stop_grace_period) before SIGKILL: running jobs get 25 s to finish, and
// a job still running then is retried by another worker once its heartbeat lapses (NFR-3).
const shutdown = async (signal: string) => {
  log.info({ event: 'worker.stopping', status: signal }, 'worker stopping');
  metrics.close();
  await boss.stop({ graceful: true, timeout: 25_000 });
  await db.destroy();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
