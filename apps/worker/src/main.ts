import { readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  AccessReviewRepository,
  DeletionLog,
  AuditLog,
  AuthStore,
  createMainDb,
  FileRepository,
  InviteRepository,
  JobLeaseRepository,
  JobRecordRepository,
  mainDbConfig,
  MembershipRepository,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { Mailer } from '@omnibridge/mail';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
import { JOBS, JobQueue, queueMetrics } from '@omnibridge/queue';
import { VaultClient } from '@omnibridge/vault-client';
import { auditRetentionHandler } from './audit-retention.ts';
import { lockNoticeHandler, passwordResetHandler } from './auth-mail.ts';
import { piiDeleteHandler, piiExpiryHandler } from './deletion.ts';
import { jobsRetentionHandler } from './housekeeping.ts';
import { accessReviewHandler, inviteHandler } from './users-jobs.ts';
import { workerHandlerDbConfig } from './db.ts';
import { registerHandlers } from './handlers.ts';
import { createWorkerBoss, startHeartbeat } from './heartbeat.ts';
import { startMetricsServer } from './metrics-server.ts';
import { startPlatformJobs } from './platform-jobs.ts';
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
// Auth mail (T-0203): web enqueues, the worker sends (ADR-050). Plain SMTP is allowed only when
// SMTP_ALLOW_PLAIN is set, for Mailpit on the dev network.
const mailer = new Mailer({
  host: requireEnv('SMTP_HOST'),
  port: Number(process.env.SMTP_PORT ?? '587'),
  secure: process.env.SMTP_SECURE === '1',
  ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER } : {}),
  ...(process.env.SMTP_PASSWORD_FILE ? { password: readSecretFile('SMTP_PASSWORD') } : {}),
  allowPlain: process.env.SMTP_ALLOW_PLAIN === '1',
});
const users = new UserRepository(handlerDb.db);
// DEL-1: the deletion jobs reach pii-vault with the deletion token, the only one that may delete.
const deletionDeps = {
  vault: new VaultClient({
    baseUrl: requireEnv('PII_VAULT_URL'),
    token: readSecretFile('VAULT_DELETION_TOKEN'),
    timeoutMs: 60_000,
  }),
  log: new DeletionLog(handlerDb.db),
  logger: log,
};
await registerHandlers(queue, {
  'files.scan': scanFileHandler({
    files,
    clamd: { host: requireEnv('CLAMD_HOST'), port: Number(process.env.CLAMD_PORT ?? '3310') },
    logger: log,
  }),
  'audit.retention': auditRetentionHandler(new AuditLog(handlerDb.db), log),
  'auth.lock_notice': lockNoticeHandler({
    users,
    members: new MembershipRepository(handlerDb.db),
    mailer,
    logger: log,
  }),
  'auth.password_reset': passwordResetHandler({
    store: new AuthStore(handlerDb.db),
    users,
    mailer,
    appOrigin: requireEnv('APP_ORIGIN'),
    logger: log,
  }),
  'auth.invite': inviteHandler({
    invites: new InviteRepository(handlerDb.db),
    users,
    workspaces: new WorkspaceRepository(handlerDb.db),
    mailer,
    appOrigin: requireEnv('APP_ORIGIN'),
    logger: log,
  }),
  'users.access_review': accessReviewHandler({
    reviews: new AccessReviewRepository(handlerDb.db),
    logger: log,
  }),
  'jobs.retention': jobsRetentionHandler({
    records: new JobRecordRepository(handlerDb.db),
    logger: log,
  }),
  'pii.delete': piiDeleteHandler(deletionDeps),
  'pii.expiry': piiExpiryHandler(deletionDeps),
});
// The scheduled fan-out, the worker's only use of ob_platform (invariant 2).
const closePlatformJobs = await startPlatformJobs({
  boss,
  queue,
  auth: new AuthStore(bookkeepingDb.db),
  logger: log,
  onDbError,
});
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
  await closePlatformJobs();
  mailer.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
