import { fileURLToPath } from 'node:url';
import { Notifier, readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  AccessReviewRepository,
  ChannelAccountRepository,
  DeletionLog,
  ErasureRequestRepository,
  NotificationRepository,
  AuditLog,
  AuthStore,
  CompanyRepository,
  createMainDb,
  FileRepository,
  InviteRepository,
  JobLeaseRepository,
  JobRecordRepository,
  mainDbConfig,
  MemberAccessRepository,
  ping,
  PlatformConsole,
  Tenancy,
  WorkspaceRepository,
} from '@omnibridge/db';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';
import {
  createQueueClient,
  HEARTBEAT_QUEUE,
  JobAdmin,
  JOBS,
  JobQueue,
  QUEUE_SCHEMA,
} from '@omnibridge/queue';
import { VaultClient } from '@omnibridge/vault-client';
import { buildWebApp } from './app.ts';
import { parseIpAllowlist } from './auth/ip-allowlist.ts';
import { queueNotifier } from './auth/notifier.ts';
import { Passwords } from './auth/passwords.ts';
import { PlatformKeys } from './auth/platform-keys.ts';
import { AuthService } from './auth/service.ts';
import { loadSpa } from './spa.ts';
import { ebayWebhookFromEnv } from './webhooks/ebay.ts';

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
// The networks the platform console may be used from (PLAT-1); unset or empty allows nobody.
const platformAllowlist = parseIpAllowlist(process.env.PLATFORM_IP_ALLOWLIST);
const platformConsole = new PlatformConsole(main.db);
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
  // The current terms and privacy policy version, a platform setting (WWW-7); it must match the
  // date on the public site's legal pages (apps/site/src/settings.ts LEGAL_VERSION).
  termsVersion: requireEnv('TERMS_VERSION'),
  platformAllowlist,
  incidentBanner: () => platformConsole.incidentBanner(),
});

// The vault with web's own token (invariant 8): ingest, read, mask, search, match. Never delete.
const vault = new VaultClient({ baseUrl: piiVaultUrl, token: readSecretFile('VAULT_TOKEN') });

async function piiVaultHealthy(): Promise<boolean> {
  const res = await fetch(new URL('/healthz', piiVaultUrl), { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) return false;
  const body = (await res.json()) as { db_pii?: unknown };
  return body.db_pii === 'ok';
}

// The built SPA (ADR-060), copied next to dist/ in the image; boot fails if it is missing.
const spa = loadSpa(process.env.UI_DIST_DIR ?? fileURLToPath(new URL('../ui/', import.meta.url)));

const checks = { dbMain: () => ping(main.pool), dbPii: piiVaultHealthy };
const app = buildWebApp({
  logger,
  version,
  spa,
  checks,
  tenancy,
  directory: {
    workspaces: new WorkspaceRepository(main.db),
    companies: new CompanyRepository(main.db),
  },
  audit: new AuditLog(main.db),
  deletion: { log: new DeletionLog(main.db), accounts: new ChannelAccountRepository(main.db) },
  auth,
  people: {
    members: new MemberAccessRepository(main.db),
    invites: new InviteRepository(main.db),
    reviews: new AccessReviewRepository(main.db),
    workspaces: new WorkspaceRepository(main.db),
    store: authStore,
    notifier: queueNotifier(queue),
    audit: new AuditLog(main.db),
    tenancy,
  },
  // Erasure and subject access requests (DEL-4, DEL-5).
  privacy: {
    vault,
    erasures: new ErasureRequestRepository(main.db),
    queue,
    audit: new AuditLog(main.db),
  },
  // The notification centre (NTF-1, NTF-2).
  notifications: { notifications: new NotificationRepository(main.db) },
  // The platform console (PLAT-1, PLAT-2): counts and IDs only, never tenant business data.
  platform: {
    console: platformConsole,
    jobs: new JobAdmin({
      boss,
      types: JOBS.map((def) => def.type),
      records: new JobRecordRepository(main.db),
      heartbeat: { schema: QUEUE_SCHEMA, queue: HEARTBEAT_QUEUE },
      logger,
    }),
    queue,
    audit: new AuditLog(main.db),
    tenancy,
    checks,
    version,
    logger,
  },
  jobs: new JobRecordRepository(main.db),
  files: { store: fileStore, linkKey },
  // The eBay account deletion endpoint (EBAY-2), when its secrets are mounted.
  ...(() => {
    // AT-10: a verified notice is matched in the vault and queued by ref (FA-14).
    const ebay = ebayWebhookFromEnv(
      logger,
      {
        vault,
        accounts: new ChannelAccountRepository(main.db),
        tenancy,
        queue,
      },
      // SEC-12: a throttled key fetch raises a platform notice (T-0503).
      new Notifier({ store: new NotificationRepository(main.db) }),
    );
    return ebay === undefined ? {} : { ebay };
  })(),
  // compose sets uniquelocal: only the private-network edge may name the client address.
  ...(process.env.TRUSTED_PROXIES ? { trustedProxies: process.env.TRUSTED_PROXIES } : {}),
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

const shutdown = async () => {
  await app.close();
  // Reset requests answered with 202 may still be queuing their mail job.
  await auth.idle();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await main.destroy();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
