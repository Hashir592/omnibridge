import { readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { createWorkerBoss, startHeartbeat } from './heartbeat.ts';

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

await boss.start();
await startHeartbeat({
  boss,
  log,
  healthFile: process.env.WORKER_HEALTH_FILE ?? '/tmp/worker-heartbeat',
});
log.info({ event: 'worker.started' }, 'worker started');

const shutdown = async (signal: string) => {
  log.info({ event: 'worker.stopping', status: signal }, 'worker stopping');
  await boss.stop({ graceful: true, timeout: 20_000 });
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
