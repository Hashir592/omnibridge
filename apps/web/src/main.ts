import { readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  AuditLog,
  AuthStore,
  CompanyRepository,
  createMainDb,
  FileRepository,
  JobLeaseRepository,
  JobRecordRepository,
  mainDbConfig,
  MembershipRepository,
  ping,
  Tenancy,
  WorkspaceRepository,
} from '@omnibridge/db';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';
import { createQueueClient, JobQueue } from '@omnibridge/queue';
import { buildWebApp } from './app.ts';
import { queueNotifier } from './auth/notifier.ts';
import { Passwords } from './auth/passwords.ts';
import { PlatformKeys } from './auth/platform-keys.ts';
import { AuthService } from './auth/service.ts';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
const logger = createLogger({ service: 'web', version });
// Fail at boot, not at first use, if the secrets master key is missing or malformed (SEC-6).
const secretsKeyring = loadKeyring('secrets');
logger.info(
  { event: 'keyring.loaded', kekVersion: secretsKeyring.activeVersion },
  'secrets KEK loaded',
);
const main = createMainDb(mainDbConfig('omnibridge-web', 10), (err) => {
  logger.warn({ event: 'db.connection_error', err }, 'db-main connection error');
});
const piiVaultUrl = requireEnv('PII_VAULT_URL');

// Encrypted files and the key that signs their 5-minute download links (NFR-5).
const linkKey = Buffer.from(readSecretFile('FILE_LINK_HMAC_KEY'), 'base64url');
if (linkKey.length < 32) throw new Error('FILE_LINK_HMAC_KEY must hold at least 32 bytes');
const filesDir = requireEnv('FILES_DIR');
const fileStore = new EncryptedLocalFileStore({
  root: filesDir,
  keys: new FileKeyStore(filesDir, secretsKeyring),
  metadata: new FileRepository(main.db),
  linkKey,
});

// Sign-in, MFA and sessions (T-0203). auth_hmac_key keys the lockout counters and recovery codes.
const hmacKey = Buffer.from(readSecretFile('AUTH_HMAC_KEY'), 'base64url');
if (hmacKey.length < 32) throw new Error('AUTH_HMAC_KEY must hold at least 32 bytes');
// The origins allowed on state-changing requests (SEC-1): the app's own, nothing else.
const origins = requireEnv('APP_ORIGINS')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o !== '');
const tenancy = new Tenancy(main.db);
const authStore = new AuthStore(main.db);
// Web only sends jobs (the auth mail); the worker runs them (ADR-050).
const boss = createQueueClient({
  host: requireEnv('DB_MAIN_HOST'),
  port: Number(process.env.DB_MAIN_PORT ?? '5432'),
  database: requireEnv('DB_MAIN_NAME'),
  user: requireEnv('DB_MAIN_USER'),
  password: readSecretFile('DB_MAIN_PASSWORD'),
  application_name: 'omnibridge-web-queue',
});
boss.on('error', (err) => {
  logger.error({ err, event: 'queue.error' }, 'pg-boss error');
});
await boss.start();
const queue = new JobQueue({
  boss,
  records: new JobRecordRepository(main.db),
  limiter: new JobLeaseRepository(main.db),
  tenancy,
  logger,
});
const auth = new AuthService({
  store: authStore,
  passwords: new Passwords(),
  platformKeys: new PlatformKeys(authStore, secretsKeyring),
  tenancy,
  audit: new AuditLog(main.db),
  notifier: queueNotifier(queue),
  logger,
  hmacKey,
  origins,
});

async function piiVaultHealthy(): Promise<boolean> {
  const res = await fetch(new URL('/healthz', piiVaultUrl), { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) return false;
  const body = (await res.json()) as { db_pii?: unknown };
  return body.db_pii === 'ok';
}

const app = buildWebApp({
  logger,
  version,
  checks: { dbMain: () => ping(main.pool), dbPii: piiVaultHealthy },
  tenancy,
  directory: {
    workspaces: new WorkspaceRepository(main.db),
    companies: new CompanyRepository(main.db),
  },
  members: new MembershipRepository(main.db),
  audit: new AuditLog(main.db),
  auth,
  jobs: new JobRecordRepository(main.db),
  files: { store: fileStore, linkKey },
  // compose sets uniquelocal: only the private-network edge may name the client address.
  ...(process.env.TRUSTED_PROXIES ? { trustedProxies: process.env.TRUSTED_PROXIES } : {}),
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

const shutdown = async () => {
  await app.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await main.destroy();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
