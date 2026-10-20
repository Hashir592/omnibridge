import { readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  AuditLog,
  createMainDb,
  FileRepository,
  JobLeaseRepository,
  JobRecordRepository,
  mainDbConfig,
  platformDbConfig,
  Tenancy,
  WorkspaceDirectory,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
import { JOBS, JobQueue, queueMetrics } from '@omnibridge/queue';
import { auditRetentionHandler, sweepAuditRetention } from './audit-retention.ts';
import { workerHandlerDbConfig } from './db.ts';
import { registerHandlers, registerPlatformHandlers } from './handlers.ts';
import { createWorkerBoss, startHeartbeat } from './heartbeat.ts';
import { startMetricsServer } from './metrics-server.ts';
import { scanFileHandler } from './scan.ts';

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

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? '8');
const onDbError = (err: Error) => {
  // An idle-in-transaction timeout ends the session; the stuck job's next query then fails.
  log.warn({ event: 'db.connection_error', err }, 'db-main connection error');
};
// Job handlers: one tenant transaction each, under the transaction timeouts.
const handlerDb = createMainDb(workerHandlerDbConfig(concurrency), onDbError);
// Job records and lease slots: short transactions of their own, on a pool the handlers never
// fill, so progress and leases always commit while jobs run (PS-017).
const bookkeepingDb = createMainDb(mainDbConfig('omnibridge-worker-bookkeeping', 2), onDbError);
// The workspace list for the scheduled fan-out, as ob_platform (invariant 2): ids only.
const platformDb = createMainDb(platformDbConfig('omnibridge-worker-fanout'), onDbError);
const queue = new JobQueue({
  boss,
  records: new JobRecordRepository(bookkeepingDb.db),
  limiter: new JobLeaseRepository(bookkeepingDb.db),
  tenancy: new Tenancy(handlerDb.db),
  globalConcurrency: concurrency,
  logger: log,
});

await boss.start();
await startHeartbeat({
  boss,
  log,
  healthFile: process.env.WORKER_HEALTH_FILE ?? '/tmp/worker-heartbeat',
});
const filesDir = requireEnv('FILES_DIR');
const files = new EncryptedLocalFileStore({
  root: filesDir,
  keys: new FileKeyStore(filesDir, secretsKeyring),
  metadata: new FileRepository(handlerDb.db),
});
await registerHandlers(queue, {
  'files.scan': scanFileHandler({
    files,
    clamd: { host: requireEnv('CLAMD_HOST'), port: Number(process.env.CLAMD_PORT ?? '3310') },
    logger: log,
  }),
  'audit.retention': auditRetentionHandler(new AuditLog(handlerDb.db), log),
});
const directory = new WorkspaceDirectory(platformDb.db);
await registerPlatformHandlers(
  boss,
  {
    'audit.retention-sweep': async () => {
      const workspaces = await sweepAuditRetention({ directory, queue });
      log.info({ event: 'audit.retention_sweep', count: workspaces }, 'audit retention sent');
    },
  },
  log,
);
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
  await handlerDb.destroy();
  await bookkeepingDb.destroy();
  await platformDb.destroy();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
