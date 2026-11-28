import { fileURLToPath } from 'node:url';
import { Notifier, providerModeFrom, readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  AccessReviewRepository,
  AccountCredentials,
  BulkConfirmationRepository,
  ChannelAccountRepository,
  OutboundWriteRepository,
  ConnectionRepository,
  CredentialRepository,
  OAuthStateRepository,
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
  AppSecretStore,
  PlatformConsole,
  Tenancy,
  WorkspaceRepository,
  CatalogueRepository,
  StockEngine,
  OrderIngest,
  OrderReads,
  WebsiteConnectionRepository,
} from '@omnibridge/db';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';
import {
  createQueueClient,
  HEARTBEAT_QUEUE,
  JobAdmin,
  JOBS,
  JobQueue,
  OutboundQueue,
  QUEUE_SCHEMA,
  listingMappedJob,
  listingsDiscoverJob,
} from '@omnibridge/queue';
import { VaultClient } from '@omnibridge/vault-client';
import { z } from 'zod';
import { buildWebApp } from './app.ts';
import { parseIpAllowlist } from './auth/ip-allowlist.ts';
import { queueNotifier } from './auth/notifier.ts';
import { Passwords } from './auth/passwords.ts';
import { PlatformKeys } from './auth/platform-keys.ts';
import { AuthService } from './auth/service.ts';
import { createOAuthFlows } from './oauth-exchange.ts';
import { loadSpa } from './spa.ts';
import { ebayWebhookFromEnv } from './webhooks/ebay.ts';
import { websiteIngest, websiteMapped } from './website.ts';

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
// The stock engine (T-0901), shared by the stock routes and the bulk stock push (SAFE-1).
const stockEngine = new StockEngine(main.db, {
  pushes: new OutboundQueue({ queue, writes: new OutboundWriteRepository(main.db) }),
  notifier: new Notifier({ store: new NotificationRepository(main.db) }),
});
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
    orders: new OrderReads(main.db),
  },
  // The notification centre (NTF-1, NTF-2).
  notifications: { notifications: new NotificationRepository(main.db) },
  // Connections and the OAuth connect flow (T-0701: INT-2, INT-3, INT-4).
  connections: (() => {
    const mode = providerModeFrom(process.env.PROVIDER_MODE);
    const secrets = new AppSecretStore(main.db, new PlatformKeys(authStore, secretsKeyring));
    const connections = new ConnectionRepository(main.db, { environment: mode });
    return {
      connections,
      // SAFE-2: resuming an account sends its held writes in the same transaction (T-0702).
      outbound: new OutboundQueue({ queue, writes: new OutboundWriteRepository(main.db) }),
      audit: new AuditLog(main.db),
      // SAFE-1: the modules register their bulk actions (M09 stock_push, M12, M19).
      bulk: {
        confirmations: new BulkConfirmationRepository(main.db),
        actions: {
          // SAFE-1 (T-0901): send every listing of the confirmed accounts its target now.
          stock_push: {
            tab: 'stock-catalogue',
            params: z.object({}).strict(),
            run: (ctx, input) =>
              stockEngine.pushAccounts(
                ctx,
                input.accounts.map((a) => a.id),
              ),
          },
        },
      },
      oauth: {
        flows: createOAuthFlows({
          mode,
          ...(process.env.PROVIDER_MOCKS_URL ? { mocksUrl: process.env.PROVIDER_MOCKS_URL } : {}),
          ...(process.env.PROVIDER_MOCKS_PUBLIC_URL
            ? { mocksPublicUrl: process.env.PROVIDER_MOCKS_PUBLIC_URL }
            : {}),
          ...(process.env.EBAY_RUNAME ? { ebayRuName: process.env.EBAY_RUNAME } : {}),
          secrets: (name) => secrets.get(name),
        }),
        states: new OAuthStateRepository(main.db),
        credentials: new AccountCredentials(
          main.db,
          new CredentialRepository({ keyring: secretsKeyring, logger, environment: mode }),
        ),
        tenancy,
        audit: new AuditLog(main.db),
        notifier: new Notifier({ store: new NotificationRepository(main.db) }),
        appOrigin: process.env.APP_ORIGIN ?? origins[0] ?? '',
        // CAT-5: discovery runs on connect as well as daily.
        connected: async (ctx, channelAccountId, at) => {
          await queue.send(listingsDiscoverJob, {
            ctx,
            channelAccountId,
            idempotencyKey: `listings.discover:connect:${channelAccountId}:${String(at.getTime())}`,
            payload: {},
          });
        },
      },
      logger,
    };
  })(),
  // Module toggles (PLAT-2, ADR-059): a route behind one answers 404 while it is off.
  modules: new WorkspaceRepository(main.db),
  // The website connector (T-1101: WEB-1 to WEB-3) and Disconnect for any channel account.
  website: (() => {
    const mode = providerModeFrom(process.env.PROVIDER_MODE);
    const catalogue = new CatalogueRepository(main.db);
    return {
      connections: new WebsiteConnectionRepository(main.db),
      accounts: new ChannelAccountRepository(main.db),
      view: new ConnectionRepository(main.db, { environment: mode }),
      credentials: new AccountCredentials(
        main.db,
        new CredentialRepository({ keyring: secretsKeyring, logger, environment: mode }),
      ),
      audit: new AuditLog(main.db),
      tenancy,
      appOrigin: process.env.APP_ORIGIN ?? origins[0] ?? '',
      ingest: websiteIngest({
        ingest: (ports) => new OrderIngest(main.db, { catalogue, stock: stockEngine, ports }),
        queue,
        notifier: new Notifier({ store: new NotificationRepository(main.db) }),
        tenancy,
        vault,
        logger,
      }),
      products: {
        listings: catalogue,
        mapped: websiteMapped(queue),
        // After the call's transaction, in short transactions of its own (one per SKU).
        reconcile: (workspaceId, accountId, seenAt) =>
          stockEngine.reconcile(
            (fn) => tenancy.runWorkspace({ workspaceId }, fn),
            accountId,
            seenAt,
          ),
      },
      disconnect: { listings: catalogue, stock: stockEngine },
      logger,
    };
  })(),
  // The stock engine (T-0901): movements, targets and pushes through the outbound path.
  stock: {
    engine: stockEngine,
    catalogue: new CatalogueRepository(main.db),
    audit: new AuditLog(main.db),
  },
  // Orders (T-1002): db-main reads under the user's company scope, masked and full values from
  // pii-vault with the web token (ORD-5).
  orders: { reads: new OrderReads(main.db), vault, audit: new AuditLog(main.db) },
  // The catalogue (T-0801: CAT-1 to CAT-6). A mapping change is told to M09 and M10 through a
  // job sent in the request's transaction (CAT-6).
  catalogue: {
    catalogue: new CatalogueRepository(main.db),
    audit: new AuditLog(main.db),
    mappingChanged: async (ctx, change, at) => {
      await queue.send(listingMappedJob, {
        ctx,
        idempotencyKey: `listing_mapped:${change.listingId}:${String(at.getTime())}`,
        payload: {
          listing_id: change.listingId,
          master_sku_id: change.masterSkuId,
          previous_master_sku_id: change.previousMasterSkuId,
        },
      });
    },
  },
  // The platform console (PLAT-1, PLAT-2): counts and IDs only, never tenant business data.
  platform: {
    console: platformConsole,
    // SAFE-3: turning maintenance off sends each workspace's held writes (T-0702).
    outbound: (() => {
      const writes = new OutboundWriteRepository(main.db);
      const outbound = new OutboundQueue({ queue, writes });
      return {
        maintenanceWorkspaces: () => writes.maintenanceWorkspaces(),
        resume: (ctx: Parameters<OutboundQueue['resumeMaintenance']>[0]) =>
          outbound.resumeMaintenance(ctx),
      };
    })(),
    // App secrets (PLAT-4): sealed under the platform data key, which secrets_kek wraps.
    secrets: new AppSecretStore(main.db, new PlatformKeys(authStore, secretsKeyring)),
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
