import {
  Notifier,
  providerModeFrom,
  readSecretFile,
  requireEnv,
  type TenantContext,
} from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  AccessReviewRepository,
  AccountCredentials,
  AmazonBucketRepository,
  EbayBudgetRepository,
  OutboundWriteRepository,
  AppSecretStore,
  ConnectionRepository,
  CredentialRepository,
  PlatformKeys,
  SyncCursorRepository,
  DeletionLog,
  AuditLog,
  AuthStore,
  createMainDb,
  ErasureRequestRepository,
  FileRepository,
  InviteRepository,
  JobLeaseRepository,
  JobRecordRepository,
  mainDbConfig,
  MembershipRepository,
  NotificationRepository,
  PlatformHousekeeping,
  PlatformSecuritySignals,
  SecuritySignals,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  CatalogueRepository,
  OrderIngest,
  OrderReads,
  StockEngine,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { Mailer } from '@omnibridge/mail';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
import { AmazonGovernor } from '@omnibridge/governor-amazon';
import { EbayGovernor } from '@omnibridge/governor-ebay';
import { createEbayAdapter, ebayOrderStream } from '@omnibridge/provider-ebay';
import { createWebsiteAdapter, websiteOrderStream } from '@omnibridge/provider-website';
import { AccessTokenCache, ProviderHttp } from '@omnibridge/provider-kit';
import {
  emailOnRaise,
  JOBS,
  JobQueue,
  OutboundQueue,
  PermanentJobError,
  queueMetrics,
} from '@omnibridge/queue';
import { VaultClient } from '@omnibridge/vault-client';
import { auditRetentionHandler } from './audit-retention.ts';
import {
  listingMappedHandler,
  listingsDiscoverAccountsHandler,
  listingsDiscoverHandler,
  sweepListingsDiscover,
} from './catalogue.ts';
import { lockNoticeHandler, passwordResetHandler } from './auth-mail.ts';
import { piiDeleteHandler, piiExpiryHandler } from './deletion.ts';
import { jobsRetentionHandler } from './housekeeping.ts';
import {
  notifyRetentionHandler,
  sendPlatformDigest,
  workspaceCloseHandler,
} from './platform-console.ts';
import { notifyEmailHandler, sweepPlatformEmails } from './notify-mail.ts';
import {
  scanPlatformSecurity,
  securityScanHandler,
  securityThresholdsFromEnv,
} from './security.ts';
import { accessReviewHandler, inviteHandler } from './users-jobs.ts';
import { workerHandlerDbConfig } from './db.ts';
import { registerHandlers } from './handlers.ts';
import { createWorkerBoss, startHeartbeat } from './heartbeat.ts';
import { startMetricsServer } from './metrics-server.ts';
import { startPlatformJobs } from './platform-jobs.ts';
import { scanFileHandler } from './scan.ts';
import { syncPollHandler } from './sync.ts';
import {
  orderIngestPorts,
  orderIngestStream,
  ordersOrphanSweepHandler,
  ordersGroupRecomputeHandler,
  ordersPiiExpiryHandler,
  ordersSyncAccountsHandler,
} from './orders.ts';
import { createProviderGovernor } from './governor.ts';
import {
  outboundOperations,
  outboundRecoverHandler,
  outboundSendHandler,
  sweepOutboundRecover,
} from './outbound.ts';

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
const appOrigin = requireEnv('APP_ORIGIN');
// Notification emails (T-0502): one job per recipient, plus the minute sweep of platform notices.
const notifications = new NotificationRepository(handlerDb.db);
// Raising in a job emails its recipients through the same transaction (T-0502).
const notifier = new Notifier({
  store: notifications,
  onRaised: emailOnRaise({ queue, recipients: notifications }),
});
// SEC-12 thresholds, read once at boot (a bad value stops the worker).
const securityThresholds = securityThresholdsFromEnv(process.env);
// DEL-1: the deletion jobs reach pii-vault with the deletion token, the only one that may delete.
const deletionDeps = {
  vault: new VaultClient({
    baseUrl: requireEnv('PII_VAULT_URL'),
    token: readSecretFile('VAULT_DELETION_TOKEN'),
    timeoutMs: 60_000,
  }),
  log: new DeletionLog(handlerDb.db),
  erasures: new ErasureRequestRepository(handlerDb.db),
  notifier,
  // ADR-086 (3): an erased buyer leaves its same-buyer group at once, with F-M10-end-08's key.
  regroup: (ctx: TenantContext, input: { channelAccountId: string }) =>
    orderIngestPorts(queue, { notifier, logger: log }).regroup(ctx, input),
  logger: log,
};
// The platform console's jobs (T-0504): workspace closure, notification retention, the digest.
const housekeeping = new PlatformHousekeeping(handlerDb.db);
// Providers (T-0701): every call goes through the one HTTP client and its egress allowlist
// (invariant 17). PROVIDER_MODE is mock unless set; mock mode reaches provider-mocks only.
const providerMode = providerModeFrom(process.env.PROVIDER_MODE);
const providerHttp = new ProviderHttp({
  mode: providerMode,
  ...(process.env.PROVIDER_MOCKS_URL ? { mocksUrl: process.env.PROVIDER_MOCKS_URL } : {}),
});
const connections = new ConnectionRepository(handlerDb.db, { environment: providerMode });
const appSecrets = new AppSecretStore(
  handlerDb.db,
  new PlatformKeys(new AuthStore(handlerDb.db), secretsKeyring),
);
const appSecret = async (name: Parameters<AppSecretStore['get']>[0]) => {
  const value = await appSecrets.get(name);
  if (value === undefined) throw new PermanentJobError('provider.not_configured');
  return value;
};
// The rate governors (T-0702): the Amazon bucket and eBay budget, each its own package (RL-3),
// and the carrier and website cap of 4 per account on the PostgreSQL semaphore (RL-4).
const providerGovernor = createProviderGovernor({
  amazon: new AmazonGovernor(new AmazonBucketRepository(handlerDb.db)),
  ebay: new EbayGovernor(new EbayBudgetRepository(handlerDb.db)),
  limiter: new JobLeaseRepository(handlerDb.db),
  notifier,
});
const ebayAdapter = async () =>
  createEbayAdapter({
    http: providerHttp,
    clientId: await appSecret('ebay.client_id'),
    clientSecret: await appSecret('ebay.client_secret'),
  });
const syncPorts = {
  governor: providerGovernor,
  tenancy: new Tenancy(handlerDb.db),
  accounts: connections,
  credentials: new AccountCredentials(
    handlerDb.db,
    new CredentialRepository({ keyring: secretsKeyring, logger: log, environment: providerMode }),
  ),
  cursors: new SyncCursorRepository(handlerDb.db),
  health: connections,
  notifier,
  tokens: new AccessTokenCache(),
};
// Every automated provider write goes through one send path (T-0702, invariant 20).
const outboundWrites = new OutboundWriteRepository(handlerDb.db);
const outbound = new OutboundQueue({ queue, writes: outboundWrites });
// The stock engine (T-0901): movements, targets and pushes through the outbound path above. CAT-6
// back-fill reads the order lines stored while a listing was unmapped (M10).
const stockEngine: StockEngine = new StockEngine(handlerDb.db, {
  pushes: outbound,
  notifier,
  demand: {
    lockOrders: (ctx, listingId) => orderIngest.lockOrders(ctx, listingId),
    openLines: (ctx, listingId) => orderIngest.openLines(ctx, listingId),
    markOversold: (ctx, orderLineId) => orderIngest.markOversold(ctx, orderLineId),
  },
});
// M10 order ingest: vault first (the worker's token), then db-main in the sync transaction.
const workerVault = new VaultClient({
  baseUrl: requireEnv('PII_VAULT_URL'),
  token: readSecretFile('VAULT_TOKEN'),
});
const catalogueRepo = new CatalogueRepository(handlerDb.db);
const orderIngest: OrderIngest = new OrderIngest(handlerDb.db, {
  catalogue: catalogueRepo,
  stock: stockEngine,
  ports: orderIngestPorts(queue, { notifier, logger: log }),
});
const orderStream = orderIngestStream({
  tenancy: syncPorts.tenancy,
  ingest: orderIngest,
  vault: workerVault,
  logger: log,
});
const websiteAdapter = () => Promise.resolve(createWebsiteAdapter({ http: providerHttp }));
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
    appOrigin,
    logger: log,
  }),
  'auth.invite': inviteHandler({
    invites: new InviteRepository(handlerDb.db),
    users,
    workspaces: new WorkspaceRepository(handlerDb.db),
    mailer,
    appOrigin,
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
  // SEC-12: the vault's read counts and canary reads come through the worker's own token.
  'security.scan': securityScanHandler({
    vault: workerVault,
    signals: new SecuritySignals(handlerDb.db),
    notifications,
    notifier,
    thresholds: securityThresholds,
    logger: log,
  }),
  'notify.retention': notifyRetentionHandler({ housekeeping, logger: log }),
  'workspace.close': workspaceCloseHandler({ queue, housekeeping, logger: log }),
  'sync.poll': syncPollHandler({
    ports: syncPorts,
    streams: {
      'ebay.orders': async () => ebayOrderStream(await ebayAdapter(), orderStream),
      'website.orders': async () => websiteOrderStream(await websiteAdapter(), orderStream),
    },
    logger: log,
  }),
  'outbound.send': outboundSendHandler({
    ports: {
      ...syncPorts,
      writes: outboundWrites,
      dispatch: (ctx, write, seq, startAfter) => outbound.dispatch(ctx, write, seq, startAfter),
    },
    operations: outboundOperations({
      ebay: ebayAdapter,
      website: () => Promise.resolve(createWebsiteAdapter({ http: providerHttp })),
    }),
    // INV-8: a settled stock write records what was sent, or sets Sync failed.
    settled: (ctx, writeId) => stockEngine.recordPushResult(ctx, writeId),
    logger: log,
  }),
  'outbound.recover': outboundRecoverHandler({
    outbound,
    maintenance: (ctx) => connections.maintenance(ctx),
  }),
  // The catalogue (T-0801): CAT-6 listeners (M09 and M10 add theirs) and CAT-5 discovery.
  'catalogue.listing_mapped': listingMappedHandler({
    // M09: back-fill the movements and push the target; reset a remapped listing (C7.3).
    listeners: [
      { name: 'stock', onMapped: (ctx, change) => stockEngine.onListingMapped(ctx, change) },
      // M10 (FA-11): provisional order lines take their write-once snapshots, once.
      {
        name: 'orders',
        onMapped: async (ctx, change) => {
          if (change.masterSkuId !== null) await orderIngest.fillSnapshots(ctx, change.listingId);
        },
      },
    ],
  }),
  'listings.discover': listingsDiscoverHandler({
    ports: syncPorts,
    adapters: { ebay: ebayAdapter, website: websiteAdapter },
    catalogue: catalogueRepo,
    queue,
    // C7.3 and INV-7: ended listings lose their manual settings; the nightly scan reconciles.
    ended: { onEnded: (ctx, ids) => stockEngine.onListingsEnded(ctx, ids) },
    lateMapped: (ctx, accountId) => orderIngest.reportLateMapped(ctx, accountId),
    reconcile: async (workspaceId, accountId, startedAt) => {
      await stockEngine.reconcile(
        (fn) => syncPorts.tenancy.runWorkspace({ workspaceId }, fn),
        accountId,
        startedAt,
      );
    },
    logger: log,
  }),
  'stock.retention': async (job) => ({ deleted: await stockEngine.purgeExpired(job.ctx) }),
  'listings.discover_accounts': listingsDiscoverAccountsHandler({ connections, queue }),
  // M10: order polls every 5 minutes, expiry after dispatch or delivery, the nightly orphan sweep.
  'orders.sync_accounts': ordersSyncAccountsHandler({ connections, queue }),
  'orders.pii_expiry': ordersPiiExpiryHandler({
    tenancy: syncPorts.tenancy,
    ingest: orderIngest,
    vault: workerVault,
  }),
  'orders.group_recompute': ordersGroupRecomputeHandler({
    tenancy: syncPorts.tenancy,
    reads: new OrderReads(handlerDb.db),
    vault: workerVault,
  }),
  'orders.orphan_sweep': ordersOrphanSweepHandler({
    tenancy: syncPorts.tenancy,
    ingest: orderIngest,
    vault: workerVault,
    logger: log,
  }),
  'notify.email': notifyEmailHandler({
    tenancy: new Tenancy(handlerDb.db),
    notifications,
    mailer,
    appOrigin,
    logger: log,
  }),
});
// The scheduled fan-out, the worker's only use of ob_platform (invariant 2).
const closePlatformJobs = await startPlatformJobs({
  boss,
  queue,
  auth: new AuthStore(bookkeepingDb.db),
  logger: log,
  onDbError,
  sendPlatformEmails: () => sweepPlatformEmails({ notifications, mailer, appOrigin, logger: log }),
  notices: new PlatformHousekeeping(bookkeepingDb.db),
  sendDigest: () =>
    sendPlatformDigest({
      housekeeping: new PlatformHousekeeping(bookkeepingDb.db),
      mailer,
      appOrigin,
      logger: log,
    }),
  // T-0702: the outbound safety net, every ten minutes.
  recoverOutbound: (directory) => sweepOutboundRecover({ directory, queue }),
  // T-0801: the daily listing discovery (CAT-5).
  discoverListings: (directory) => sweepListingsDiscover({ directory, queue }),
  // SEC-12: platform admins' sign-ins, once per security sweep (T-0507, ADR-076).
  scanPlatform: () =>
    scanPlatformSecurity({
      signals: new PlatformSecuritySignals(handlerDb.db),
      notifications,
      notifier,
      thresholds: securityThresholds,
      logger: log,
    }),
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
