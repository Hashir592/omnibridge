import { randomUUID } from 'node:crypto';
import { Notifier, type TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  AccountCredentials,
  AmazonBucketRepository,
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
  SyncCursorRepository,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { AmazonGovernor } from '@omnibridge/governor-amazon';
import { EbayGovernor } from '@omnibridge/governor-ebay';
import { createLogger } from '@omnibridge/logger';
import { createEbayAdapter, ebayOrderStream } from '@omnibridge/provider-ebay';
import {
  AccessTokenCache,
  ProviderHttp,
  runIncrementalSync,
  type OutboundPorts,
} from '@omnibridge/provider-kit';
import { buildMockServer } from '@omnibridge/provider-mocks';
import { createWebsiteAdapter } from '@omnibridge/provider-website';
import { OutboundQueue, type PreparingJob } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProviderGovernor } from './governor.ts';
import { outboundOperations, outboundSendHandler } from './outbound.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
/** One master key for the whole test: tokens stored and read under it. */
const keyring = parseKeyring('secrets', generateKekLine(1));

/**
 * The outbound send path end to end (T-0702): writes queued through OutboundQueue, sent by the
 * outbound.send handler to the eBay mock through the real governors, with the switches read just
 * before each send. The mock counts what actually reached it.
 */
describe('outbound writes, switches and governors against the eBay mock (SAFE-2, SAFE-3, RL-2)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  const mock = buildMockServer(createLogger({ service: 'mock', version: '0', level: 'silent' }));
  const pushes: string[] = [];
  const reads: string[] = [];
  let http: ProviderHttp;
  let ports: OutboundPorts;
  const sent: { writeId: string; startAfter: Date | undefined }[] = [];
  let outbound: OutboundQueue;
  const writes = () => new OutboundWriteRepository(db.db);
  const connections = () => new ConnectionRepository(db.db);
  let caps: Record<string, number> = {
    'identity.user_token': 1000,
    'sell.inventory': 1000,
    'sell.fulfillment': 1000,
  };

  const ebay = () =>
    Promise.resolve(
      createEbayAdapter({
        http,
        clientId: new Secret('synthetic-client-id'),
        clientSecret: new Secret('synthetic-client-secret'),
      }),
    );

  /** A workspace with one eBay account, connected. */
  async function workspace(): Promise<{ id: string; account: string }> {
    const id = randomUUID();
    await tenancy.run({ workspaceId: id, companyIds: [] }, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Outbound test' }),
    );
    const company = await tenancy.runWorkspace({ workspaceId: id }, (c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'Out Ltd',
        tradingName: 'Out',
        registeredAddress: address,
      }),
    );
    const account = await tenancy.runWorkspace({ workspaceId: id }, (c) =>
      new ChannelAccountRepository(db.db).create(c, {
        companyId: company,
        provider: 'ebay',
        displayName: 'eBay',
      }),
    );
    const credentials = new AccountCredentials(
      db.db,
      new CredentialRepository({ keyring, logger }),
    );
    await tenancy.runWorkspace({ workspaceId: id }, (c) =>
      credentials.replace(c, account, 'ebay', new Secret(`TOKENMARK-${randomUUID()}`)),
    );
    return { id, account };
  }

  const inWs = <T>(id: string, fn: (ctx: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: id }, fn);
  const enqueue = (ws: { id: string; account: string }, sku = 'MOCK-SKU-1') =>
    inWs(ws.id, (ctx) =>
      outbound.enqueue(ctx, {
        channelAccountId: ws.account,
        provider: 'ebay',
        operation: 'ebay.stock_push',
        urgent: false,
        idempotencyKey: `stock:${sku}:${randomUUID()}`,
        payload: { levels: [{ sku, quantity: 4 }] },
      }),
    );
  const send = (ws: { id: string; account: string }, writeId: string) =>
    outboundSendHandler({
      ports,
      operations: outboundOperations({
        ebay,
        website: () => Promise.resolve(createWebsiteAdapter({ http })),
      }),
      logger,
    }).prepare({
      jobId: randomUUID(),
      envelope: {
        workspace_id: ws.id,
        channel_account_id: ws.account,
        idempotency_key: randomUUID(),
        attempt: 1,
        type: 'outbound.send',
        payload: { write_id: writeId },
      },
      payload: { write_id: writeId },
      attempt: 1,
      progress: () => Promise.resolve(),
    } satisfies PreparingJob<{ write_id: string }>);
  const setMaintenance = async (on: boolean) => {
    if (on) {
      await root.query(
        `INSERT INTO app.platform_settings (key, value, updated_at, updated_by)
         VALUES ('maintenance', 'true', now(), (SELECT id FROM app.users LIMIT 1))
         ON CONFLICT (key) DO UPDATE SET value = 'true'`,
      );
    } else {
      await root.query(`DELETE FROM app.platform_settings WHERE key = 'maintenance'`);
    }
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    await root.query(
      `INSERT INTO app.users (id, email, name) VALUES ($1, 'op@example.test', 'Operator')`,
      [randomUUID()],
    );
    db = createMainDb({ ...cluster.connection('ob_worker'), max: 6 });
    tenancy = new Tenancy(db.db);
    mock.addHook('onRequest', (request, _reply, done) => {
      if (request.url.includes('bulk_update_price_quantity')) pushes.push(request.url);
      if (request.url.includes('/sell/fulfillment/')) reads.push(request.url);
      done();
    });
    http = new ProviderHttp({
      mode: 'mock',
      mocksUrl: await mock.listen({ host: '127.0.0.1', port: 0 }),
    });
    outbound = new OutboundQueue({
      queue: {
        send: (_def, input) => {
          sent.push({
            writeId: (input.payload as { write_id: string }).write_id,
            startAfter: input.startAfter,
          });
          return Promise.resolve({ id: randomUUID(), created: true });
        },
      },
      writes: writes(),
    });
    const notifier = new Notifier({ store: new NotificationRepository(db.db) });
    ports = {
      tenancy,
      writes: writes(),
      dispatch: (ctx, w, seq, startAfter) => outbound.dispatch(ctx, w, seq, startAfter),
      accounts: connections(),
      credentials: new AccountCredentials(db.db, new CredentialRepository({ keyring, logger })),
      health: connections(),
      notifier,
      tokens: new AccessTokenCache(),
      governor: createProviderGovernor({
        amazon: new AmazonGovernor(new AmazonBucketRepository(db.db)),
        ebay: new EbayGovernor(
          new EbayBudgetRepository(db.db),
          new Proxy({}, { get: (_t, api: string) => caps[api] }),
        ),
        limiter: new JobLeaseRepository(db.db),
        notifier,
      }),
    };
  });

  afterAll(async () => {
    await mock.close();
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[SAFE-2] a write for a paused account is not sent and spends no attempt; resuming sends it once', async () => {
    const ws = await workspace();
    await inWs(ws.id, (ctx) => connections().setPaused(ctx, ws.account, true, new Date()));
    const { id } = await enqueue(ws);
    expect(await send(ws, id)).toEqual({ paused: 'kill_switch' });
    expect(pushes).toHaveLength(0);
    expect(await inWs(ws.id, (ctx) => writes().get(ctx, id))).toMatchObject({
      state: 'pending',
      pausedReason: 'kill_switch',
      attempts: 0,
    });

    // Unpause: the waiting write is dispatched again at once (SAFE-2).
    sent.length = 0;
    await inWs(ws.id, async (ctx) => {
      await connections().setPaused(ctx, ws.account, false, new Date());
      expect(await outbound.resumeAccount(ctx, ws.account)).toBe(1);
    });
    expect(sent.map((s) => s.writeId)).toEqual([id]);
    expect(await send(ws, id)).toEqual({ sent: true });
    expect(pushes).toHaveLength(1);
    expect(await inWs(ws.id, (ctx) => writes().get(ctx, id))).toMatchObject({
      state: 'sent',
      attempts: 1,
    });
  });

  it('[SAFE-2] the switch is read at send time: paused after the write was queued, it is still held', async () => {
    const ws = await workspace();
    const { id } = await enqueue(ws);
    await inWs(ws.id, (ctx) => connections().setPaused(ctx, ws.account, true, new Date()));
    const before = pushes.length;
    expect(await send(ws, id)).toEqual({ paused: 'kill_switch' });
    expect(pushes).toHaveLength(before);
  });

  it('[SAFE-3] maintenance stops writes in every workspace while reads go on', async () => {
    const one = await workspace();
    const two = await workspace();
    const w1 = await enqueue(one);
    const w2 = await enqueue(two);
    const before = pushes.length;
    await setMaintenance(true);
    try {
      expect(await send(one, w1.id)).toEqual({ paused: 'maintenance' });
      expect(await send(two, w2.id)).toEqual({ paused: 'maintenance' });
      expect(pushes).toHaveLength(before);
      // A read is not a write: polling goes on.
      const readsBefore = reads.length;
      await runIncrementalSync(
        { ...ports, cursors: new SyncCursorRepository(db.db) },
        ebayOrderStream(await ebay(), { sink: () => Promise.resolve() }),
        { workspaceId: one.id, channelAccountId: one.account },
      );
      expect(reads.length).toBeGreaterThan(readsBefore);
    } finally {
      await setMaintenance(false);
    }
    // Maintenance off: each workspace's held writes go again.
    expect(await writes().maintenanceWorkspaces()).toEqual(
      expect.arrayContaining([one.id, two.id]),
    );
    await inWs(one.id, (ctx) => outbound.resumeMaintenance(ctx));
    await inWs(two.id, (ctx) => outbound.resumeMaintenance(ctx));
    expect(await send(one, w1.id)).toEqual({ sent: true });
    expect(await send(two, w2.id)).toEqual({ sent: true });
    expect(pushes).toHaveLength(before + 2);
  });

  it('[RL-2][RL-5] the eBay budget is reserved before the send; past the limit nothing is sent and the write waits', async () => {
    const ws = await workspace();
    // Room for exactly one more non-urgent write today (80% of 10 = 8 calls; 2 per write).
    caps = { 'identity.user_token': 10, 'sell.inventory': 10, 'sell.fulfillment': 1000 };
    await root.query(`DELETE FROM app.ebay_budget_daily`);
    const first = await enqueue(ws);
    expect(await send(ws, first.id)).toEqual({ sent: true });
    // Usage is visible at once, written by the reservation (RL-5).
    const { rows } = await root.query<{ api: string; calls: string }>(
      `SELECT api, calls FROM app.api_usage_daily WHERE channel_account_id = $1 ORDER BY api`,
      [ws.account],
    );
    expect(rows).toEqual([
      { api: 'identity.user_token', calls: '1' },
      { api: 'sell.inventory', calls: '1' },
    ]);
    await root.query(`UPDATE app.ebay_budget_daily SET calls = 8 WHERE api = 'sell.inventory'`);
    const before = pushes.length;
    const second = await enqueue(ws);
    sent.length = 0;
    expect(await send(ws, second.id)).toEqual({ deferred: 'rate_limit' });
    expect(pushes).toHaveLength(before);
    expect(await inWs(ws.id, (ctx) => writes().get(ctx, second.id))).toMatchObject({
      state: 'pending',
      attempts: 0,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.startAfter?.getTime()).toBeGreaterThan(Date.now());
    caps = { 'identity.user_token': 1000, 'sell.inventory': 1000, 'sell.fulfillment': 1000 };
  });
});
