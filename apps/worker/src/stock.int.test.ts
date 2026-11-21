import { randomUUID } from 'node:crypto';
import { Notifier, type TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  AccountCredentials,
  AmazonBucketRepository,
  CatalogueRepository,
  ChannelAccountRepository,
  CompanyRepository,
  ConnectionRepository,
  createMainDb,
  CredentialRepository,
  EbayBudgetRepository,
  JobLeaseRepository,
  migrateMain,
  NotificationRepository,
  OutboundWriteRepository,
  StockEngine,
  Tenancy,
  withTenantTransaction,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { AmazonGovernor } from '@omnibridge/governor-amazon';
import { EbayGovernor } from '@omnibridge/governor-ebay';
import { createLogger } from '@omnibridge/logger';
import { createEbayAdapter } from '@omnibridge/provider-ebay';
import {
  AccessTokenCache,
  MAX_SEND_ATTEMPTS,
  ProviderHttp,
  type OutboundPorts,
} from '@omnibridge/provider-kit';
import { buildMockServer, ScenarioStore } from '@omnibridge/provider-mocks';
import { createWebsiteAdapter } from '@omnibridge/provider-website';
import { OutboundQueue, type PreparingJob } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProviderGovernor } from './governor.ts';
import { outboundOperations, outboundSendHandler } from './outbound.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const keyring = parseKeyring('secrets', generateKekLine(1));

/**
 * The stock engine end to end (T-0901): a sale reserves stock, the engine queues the new
 * quantities through the M07 outbound path, outbound.send delivers them to the eBay and website
 * mocks through the real governors, and the settled hook records what was sent or sets Sync
 * failed (INV-4, INV-8, AT-4).
 */
describe('stock pushes through the outbound path to the mocks (AT-4, INV-4, INV-8)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let tenancy: Tenancy;
  let ports: OutboundPorts;
  let outbound: OutboundQueue;
  let engine: StockEngine;
  const scenarios = new ScenarioStore();
  const mock = buildMockServer(
    createLogger({ service: 'mock', version: '0', level: 'silent' }),
    scenarios,
  );
  const received: { url: string; body: unknown }[] = [];
  let http: ProviderHttp;
  const W = {
    id: randomUUID(),
    company: '',
    ebay: '',
    website: '',
    sku: '',
    ebayListing: '',
    siteListing: '',
  };

  const inW = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: W.id }, fn);
  const handler = () =>
    outboundSendHandler({
      ports,
      operations: outboundOperations({
        ebay: () =>
          Promise.resolve(
            createEbayAdapter({
              http,
              clientId: new Secret('synthetic-client-id'),
              clientSecret: new Secret('synthetic-client-secret'),
            }),
          ),
        website: () => Promise.resolve(createWebsiteAdapter({ http })),
      }),
      settled: (ctx, writeId) => engine.recordPushResult(ctx, writeId),
      logger,
    });
  /** Runs outbound.send for every waiting stock write, as the worker would. */
  const sendPending = async () => {
    const pending = await inW(async (ctx) => {
      const { rows } = await withTenantTransaction(db.db, ctx, (trx) =>
        sql<{ id: string; channel_account_id: string }>`
        SELECT id, channel_account_id FROM app.outbound_writes
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND state = 'pending'
         ORDER BY created_at`.execute(trx),
      );
      return rows;
    });
    for (const w of pending) {
      const job: PreparingJob<{ write_id: string }> = {
        jobId: randomUUID(),
        envelope: {
          workspace_id: W.id,
          channel_account_id: w.channel_account_id,
          idempotency_key: randomUUID(),
          attempt: 1,
          type: 'outbound.send',
          payload: { write_id: w.id },
        },
        payload: { write_id: w.id },
        attempt: 1,
        progress: () => Promise.resolve(),
      };
      const h = handler();
      const result = await h.prepare(job);
      await inW((ctx) => Promise.resolve(h.commit({ ...job, ctx }, result)));
    }
    return pending.length;
  };
  const siteListing = async () =>
    (await inW((ctx) => engine.getStock(ctx, W.sku)))?.listings.find((l) => l.id === W.siteListing);

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    db = createMainDb({ ...cluster.connection('ob_worker'), max: 6 });
    tenancy = new Tenancy(db.db);
    mock.addHook('preHandler', (request, _reply, done) => {
      if (
        request.url.includes('bulk_update_price_quantity') ||
        request.url.includes('/website/api/stock')
      ) {
        received.push({ url: request.url, body: request.body });
      }
      done();
    });
    http = new ProviderHttp({
      mode: 'mock',
      mocksUrl: await mock.listen({ host: '127.0.0.1', port: 0 }),
    });
    const writes = new OutboundWriteRepository(db.db);
    outbound = new OutboundQueue({
      queue: { send: () => Promise.resolve({ id: randomUUID(), created: true }) },
      writes,
    });
    const notifier = new Notifier({ store: new NotificationRepository(db.db) });
    const connections = new ConnectionRepository(db.db);
    ports = {
      tenancy,
      writes,
      dispatch: (ctx, w, seq, startAfter) => outbound.dispatch(ctx, w, seq, startAfter),
      accounts: connections,
      credentials: new AccountCredentials(db.db, new CredentialRepository({ keyring, logger })),
      health: connections,
      notifier,
      tokens: new AccessTokenCache(),
      governor: createProviderGovernor({
        amazon: new AmazonGovernor(new AmazonBucketRepository(db.db)),
        ebay: new EbayGovernor(new EbayBudgetRepository(db.db), new Proxy({}, { get: () => 1000 })),
        limiter: new JobLeaseRepository(db.db),
        notifier,
      }),
    };
    engine = new StockEngine(db.db, { pushes: outbound, notifier });
    await tenancy.run({ workspaceId: W.id, companyIds: [] }, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Stock e2e' }),
    );
    W.company = await inW((c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'E2E Ltd',
        tradingName: 'E2E',
        registeredAddress: address,
      }),
    );
    const credentials = new AccountCredentials(
      db.db,
      new CredentialRepository({ keyring, logger }),
    );
    for (const provider of ['ebay', 'website'] as const) {
      W[provider] = await inW((c) =>
        new ChannelAccountRepository(db.db).create(c, {
          companyId: W.company,
          provider,
          displayName: provider,
        }),
      );
      await inW((c) =>
        credentials.replace(c, W[provider], provider, new Secret(`TOKENMARK-${randomUUID()}`)),
      );
    }
    const catalogue = new CatalogueRepository(db.db);
    W.sku = await inW((c) =>
      catalogue.createSku(
        c,
        {
          sku: 'MOCK-SKU-1',
          title: 'Bowl',
          shortDescription: 'Bowl',
          weightG: 1,
          vatType: 'standard',
        },
        null,
        new Date(),
      ),
    );
    for (const provider of ['ebay', 'website'] as const) {
      const { autoMapped } = await inW((c) =>
        catalogue.upsertDiscovered(
          c,
          W[provider],
          provider,
          [
            {
              externalSku: 'MOCK-SKU-1',
              externalId: `${provider}-1`,
              title: null,
              fulfilment: null,
              inventoryApi: null,
              quantity: 0,
            },
          ],
          new Date(),
        ),
      );
      if (provider === 'ebay') W.ebayListing = autoMapped[0]?.listingId ?? '';
      else W.siteListing = autoMapped[0]?.listingId ?? '';
    }
    await inW((ctx) =>
      engine.stockIn(ctx, W.sku, { quantity: 10, clientRef: randomUUID(), userId: null }),
    );
    await sendPending();
  });

  afterAll(async () => {
    await mock.close();
    await db.destroy();
    await cluster.container.stop();
  });

  it('[AT-4] [INV-4] one eBay sale reaches the website mock as the lower quantity within 2 minutes', async () => {
    received.length = 0;
    const started = Date.now();
    await inW((ctx) =>
      engine.reserve(ctx, {
        orderLineId: randomUUID(),
        listingId: W.ebayListing,
        quantity: 1,
        companyId: W.company,
      }),
    );
    expect(await sendPending()).toBe(1);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(120_000);
    // Only the other channel was written (the eBay listing counted down itself, INV-4).
    expect(received).toEqual([
      { url: '/website/api/stock', body: { items: [{ sku: 'MOCK-SKU-1', quantity: 9 }] } },
    ]);
    expect(await siteListing()).toMatchObject({
      lastSentQty: 9,
      lastPush: { result: 'sent' },
      syncFailed: false,
    });
  });

  it('[INV-8] the last failure of a push sets Sync failed; the next good push clears it', async () => {
    scenarios.set('website', '*', 'revoked');
    // The write's earlier attempts are spent: this send is its last retry (INV-8, 3.0 rules).
    const lastTry = () =>
      inW((ctx) =>
        withTenantTransaction(db.db, ctx, (trx) =>
          sql`UPDATE app.outbound_writes SET attempts = ${MAX_SEND_ATTEMPTS - 1}
               WHERE workspace_id = ${ctx.workspaceId}::uuid AND state = 'pending'`.execute(trx),
        ),
      );
    await inW((ctx) =>
      engine.reserve(ctx, {
        orderLineId: randomUUID(),
        listingId: W.ebayListing,
        quantity: 1,
        companyId: W.company,
      }),
    );
    await lastTry();
    await sendPending();
    expect(await siteListing()).toMatchObject({ syncFailed: true, lastPush: { result: 'failed' } });
    expect((await inW((ctx) => engine.getStock(ctx, W.sku)))?.syncFailed).toBe(true);
    scenarios.clear();
    await inW((ctx) => engine.pushAccounts(ctx, [W.website]));
    await sendPending();
    expect(await siteListing()).toMatchObject({
      syncFailed: false,
      lastSentQty: 8,
      lastPush: { result: 'sent' },
    });
  });
});
