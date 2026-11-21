import { randomUUID } from 'node:crypto';
import { Notifier, type TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  AccountCredentials,
  CatalogueRepository,
  ChannelAccountRepository,
  CompanyRepository,
  ConnectionRepository,
  createMainDb,
  CredentialRepository,
  migrateMain,
  NotificationRepository,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { createEbayAdapter } from '@omnibridge/provider-ebay';
import { AccessTokenCache, ProviderHttp, type SyncPorts } from '@omnibridge/provider-kit';
import { buildMockServer, ScenarioStore } from '@omnibridge/provider-mocks';
import { createWebsiteAdapter } from '@omnibridge/provider-website';
import type { JobDefinition, PreparingJob, SendInput } from '@omnibridge/queue';
import { startRoleCluster, TOKEN_MARKER, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listingMappedHandler,
  listingsDiscoverAccountsHandler,
  listingsDiscoverHandler,
} from './catalogue.ts';

const logger = createLogger({ service: 'test', version: '0', level: 'silent' });
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const NOW = new Date('2026-11-21T03:15:00.000Z');

/**
 * CAT-5 discovery end to end (T-0801): a listings.discover job reads every page of an account's
 * listings from provider-mocks through the egress allowlist and the governor, upserts them by
 * (account, external SKU), maps exact codes, queues the rest, and ends what a complete scan no
 * longer finds. Each auto-mapping sends the CAT-6 event.
 */
describe('listings.discover against the eBay and website mocks (CAT-5, CAT-6)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let tenancy: Tenancy;
  let http: ProviderHttp;
  let ports: Omit<SyncPorts, 'cursors'>;
  let catalogue: CatalogueRepository;
  const scenarios = new ScenarioStore();
  const mock = buildMockServer(
    createLogger({ service: 'mock', version: '0', level: 'silent' }),
    scenarios,
  );
  const A = randomUUID();
  const accounts = { ebay: '', website: '' };
  const sent: { type: string; key: string; account?: string; payload: unknown }[] = [];
  const governed: string[] = [];
  const queue = {
    send: <P>(def: JobDefinition, input: SendInput<P>) => {
      sent.push({
        type: def.type,
        key: input.idempotencyKey,
        ...(input.channelAccountId === undefined ? {} : { account: input.channelAccountId }),
        payload: input.payload,
      });
      return Promise.resolve({ id: randomUUID(), created: true });
    },
  };
  const inA = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: A }, fn);
  const job = (account: string): PreparingJob<Record<string, never>> => ({
    jobId: randomUUID(),
    envelope: {
      workspace_id: A,
      channel_account_id: account,
      idempotency_key: randomUUID(),
      attempt: 1,
      type: 'listings.discover',
      payload: {},
    },
    payload: {},
    attempt: 1,
    progress: () => Promise.resolve(),
  });
  const handler = () =>
    listingsDiscoverHandler({
      ports,
      adapters: {
        ebay: () =>
          Promise.resolve(
            createEbayAdapter({
              http,
              clientId: new Secret('synthetic-client-id'),
              clientSecret: new Secret('synthetic-client-secret'),
            }),
          ),
        website: () => Promise.resolve(createWebsiteAdapter({ http })),
      },
      catalogue,
      queue,
      logger,
    });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    db = createMainDb({ ...cluster.connection('ob_worker'), max: 4 });
    tenancy = new Tenancy(db.db);
    catalogue = new CatalogueRepository(db.db);
    http = new ProviderHttp({
      mode: 'mock',
      mocksUrl: await mock.listen({ host: '127.0.0.1', port: 0 }),
    });
    const keyring = parseKeyring('secrets', generateKekLine(1));
    const connections = new ConnectionRepository(db.db, { environment: 'mock' });
    const credentials = new AccountCredentials(
      db.db,
      new CredentialRepository({ keyring, logger, environment: 'mock' }),
    );
    ports = {
      tenancy,
      accounts: connections,
      credentials,
      health: connections,
      notifier: new Notifier({ store: new NotificationRepository(db.db) }),
      tokens: new AccessTokenCache(),
      governor: {
        admit: (input) => {
          governed.push(`${input.provider}:${input.api}`);
          return Promise.resolve({ ok: true, usageRecorded: false });
        },
        run: (_input, fn) => fn(),
      },
      now: () => NOW,
    };
    await tenancy.run({ workspaceId: A, companyIds: [] }, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Discovery test' }),
    );
    const company = await inA((c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'Disc Ltd',
        tradingName: 'Disc',
        registeredAddress: address,
      }),
    );
    for (const provider of ['ebay', 'website'] as const) {
      accounts[provider] = await inA((c) =>
        new ChannelAccountRepository(db.db).create(c, {
          companyId: company,
          provider,
          displayName: `${provider} main`,
        }),
      );
      await inA((c) =>
        credentials.replace(
          c,
          accounts[provider],
          provider,
          new Secret(`${TOKEN_MARKER}${randomUUID()}`),
        ),
      );
    }
    for (const code of ['MOCK-SKU-1', 'MOCK-SKU-2']) {
      await inA((c) =>
        catalogue.createSku(
          c,
          { sku: code, title: code, shortDescription: code, weightG: 1, vatType: 'standard' },
          null,
          NOW,
        ),
      );
    }
  });

  afterAll(async () => {
    await mock.close();
    await db.destroy();
    await cluster.container.stop();
  });

  it('[CAT-5] [CAT-6] an eBay scan maps the exact codes, queues the rest and sends one event per new mapping', async () => {
    // A listing the account had before, which the mock no longer serves: it has ended.
    await inA((c) =>
      catalogue.upsertDiscovered(
        c,
        accounts.ebay,
        'ebay',
        [
          {
            externalSku: 'OLD-GONE-1',
            externalId: 'OLD-GONE-1',
            title: null,
            fulfilment: null,
            inventoryApi: true,
            quantity: 0,
          },
        ],
        new Date('2026-11-20T03:15:00.000Z'),
      ),
    );
    sent.length = 0;
    const result = await handler().prepare(job(accounts.ebay));
    // The mock serves 2 per page: the scan reads both pages before it concludes.
    expect(result).toEqual({ pages: 2, listings: 3, complete: true });
    expect(governed).toEqual(
      expect.arrayContaining(['ebay:identity.user_token', 'ebay:sell.inventory']),
    );
    const listed = await inA((c) =>
      catalogue.listListings(c, { channelAccountId: accounts.ebay, offset: 0, limit: 50 }, 100),
    );
    const bySku = new Map(listed.items.map((l) => [l.externalSku, l]));
    expect(bySku.get('MOCK-SKU-1')?.masterSku?.sku).toBe('MOCK-SKU-1');
    expect(bySku.get('MOCK-SKU-2')?.masterSku?.sku).toBe('MOCK-SKU-2');
    expect(bySku.get('MOCK-UNMATCHED-1')?.masterSku).toBeNull();
    expect(bySku.get('OLD-GONE-1')?.endedAt).toEqual(NOW);
    expect(sent.map((s) => s.type)).toEqual([
      'catalogue.listing_mapped',
      'catalogue.listing_mapped',
    ]);

    // A second scan changes no mapping and sends nothing (INT-8 upsert by external ID).
    sent.length = 0;
    await handler().prepare(job(accounts.ebay));
    expect(sent).toEqual([]);
    const again = await inA((c) =>
      catalogue.listListings(c, { channelAccountId: accounts.ebay, offset: 0, limit: 50 }, 100),
    );
    expect(again.total).toBe(4);
  });

  it('[CAT-5] the website scan stores its products the same way', async () => {
    const result = await handler().prepare(job(accounts.website));
    expect(result).toMatchObject({ listings: 3, complete: true });
    const queue = await inA((c) =>
      catalogue.listListings(
        c,
        { channelAccountId: accounts.website, mapped: false, offset: 0, limit: 50 },
        100,
      ),
    );
    expect(queue.items.map((l) => l.externalSku)).toEqual(['MOCK-UNMATCHED-1']);
  });

  it('[CAT-5] the daily fan-out sends one discovery per connected sales account, once a day', async () => {
    sent.length = 0;
    const fanOut = listingsDiscoverAccountsHandler({
      connections: new ConnectionRepository(db.db, { environment: 'mock' }),
      queue,
      now: () => NOW,
    });
    await inA((ctx) =>
      fanOut({
        jobId: randomUUID(),
        ctx,
        envelope: {
          workspace_id: A,
          idempotency_key: 'x',
          attempt: 1,
          type: 'listings.discover_accounts',
          payload: {},
        },
        payload: {},
        attempt: 1,
        progress: () => Promise.resolve(),
      }),
    );
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'listings.discover',
          account: accounts.ebay,
          key: `listings.discover:${accounts.ebay}:2026-11-21`,
        }),
        expect.objectContaining({ type: 'listings.discover', account: accounts.website }),
      ]),
    );
    expect(sent).toHaveLength(2);
  });

  it('[CAT-6] the mapped job runs every registered listener with the change', async () => {
    const seen: unknown[] = [];
    const run = listingMappedHandler({
      listeners: [
        {
          name: 'probe',
          onMapped: (_ctx, change) => {
            seen.push(change);
            return Promise.resolve();
          },
        },
      ],
    });
    const listing = randomUUID();
    const sku = randomUUID();
    await inA((ctx) =>
      run({
        jobId: randomUUID(),
        ctx,
        envelope: {
          workspace_id: A,
          idempotency_key: 'y',
          attempt: 1,
          type: 'catalogue.listing_mapped',
          payload: { listing_id: listing, master_sku_id: sku, previous_master_sku_id: null },
        },
        payload: { listing_id: listing, master_sku_id: sku, previous_master_sku_id: null },
        attempt: 1,
        progress: () => Promise.resolve(),
      }),
    );
    expect(seen).toEqual([{ listingId: listing, masterSkuId: sku, previousMasterSkuId: null }]);
  });
});
