import { randomUUID } from 'node:crypto';
import { Notifier, type TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  AccountCredentials,
  ChannelAccountRepository,
  CompanyRepository,
  ConnectionRepository,
  createMainDb,
  CredentialRepository,
  migrateMain,
  NotificationRepository,
  SyncCursorRepository,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { createEbayAdapter, ebayOrderStream } from '@omnibridge/provider-ebay';
import {
  AccessTokenCache,
  defineParser,
  ProviderHttp,
  type ChannelOrder,
  type SyncPorts,
} from '@omnibridge/provider-kit';
import { buildMockServer, ScenarioStore } from '@omnibridge/provider-mocks';
import { PermanentJobError, type PreparingJob, type SyncStreamName } from '@omnibridge/queue';
import {
  scanDatabaseForMarkers,
  scanTextForMarkers,
  startRoleCluster,
  TOKEN_MARKER,
  type RoleCluster,
} from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { syncPollHandler } from './sync.ts';

const lines: string[] = [];
const logger = createLogger({
  service: 'test',
  version: '0',
  destination: { write: (line: string) => lines.push(line) },
});
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };

/**
 * The M07 reference path end to end (T-0701): a sync.poll job for an eBay account runs the eBay
 * adapter against provider-mocks through the egress allowlist, parses the answer, stores the
 * cursor, health and usage in db-main, and raises the notices a failure calls for.
 */
describe('sync.poll: job, governor, parser and cursor against the eBay mock (INT-1, INT-8)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  const scenarios = new ScenarioStore();
  const mock = buildMockServer(
    createLogger({ service: 'mock', version: '0', level: 'silent' }),
    scenarios,
  );
  let http: ProviderHttp;
  let ports: SyncPorts;
  const A = randomUUID();
  let account = '';
  const refresh = `${TOKEN_MARKER}${randomUUID()}`;
  const received: ChannelOrder[] = [];
  const governed: string[] = [];

  const job = (
    stream: SyncStreamName = 'ebay.orders',
  ): PreparingJob<{ stream: SyncStreamName }> => ({
    jobId: randomUUID(),
    envelope: {
      workspace_id: A,
      channel_account_id: account,
      idempotency_key: randomUUID(),
      attempt: 1,
      type: 'sync.poll',
      payload: { stream },
    },
    payload: { stream },
    attempt: 1,
    progress: () => Promise.resolve(),
  });

  const ebay = () =>
    createEbayAdapter({
      http,
      clientId: new Secret('synthetic-client-id'),
      clientSecret: new Secret('synthetic-client-secret'),
    });
  const handler = (
    stream = () =>
      Promise.resolve(
        ebayOrderStream(ebay(), {
          sink: (_ctx, _id, items) => {
            received.push(...items);
            return Promise.resolve();
          },
        }),
      ),
  ) => syncPollHandler({ ports, streams: { 'ebay.orders': stream }, logger });
  const inA = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: A }, fn);

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    db = createMainDb({ ...cluster.connection('ob_worker'), max: 4 });
    tenancy = new Tenancy(db.db);
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
      cursors: new SyncCursorRepository(db.db),
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
      now: () => new Date('2026-11-21T12:00:00.000Z'),
    };
    await tenancy.run({ workspaceId: A, companyIds: [] }, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Sync test' }),
    );
    const company = await inA((c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'Sync Ltd',
        tradingName: 'Sync',
        registeredAddress: address,
      }),
    );
    account = await inA((c) =>
      new ChannelAccountRepository(db.db).create(c, {
        companyId: company,
        provider: 'ebay',
        displayName: 'eBay main',
      }),
    );
    await inA((c) => credentials.replace(c, account, 'ebay', new Secret(refresh)));
  });

  afterAll(async () => {
    await mock.close();
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[INT-8] polls through the governor, parses, stores the cursor; a re-poll inside the overlap adds nothing', async () => {
    const first = await handler().prepare(job());
    expect(first).toEqual({ fetched: 3, fresh: 3, cursorAt: '2026-11-20T12:00:00.000Z' });
    expect(governed).toEqual([
      'ebay:identity.user_token',
      'ebay:sell.fulfillment',
      'ebay:sell.fulfillment',
    ]);
    const again = await handler().prepare(job());
    expect(again).toEqual({ fetched: 1, fresh: 0, cursorAt: '2026-11-20T12:00:00.000Z' });
    expect(received.map((o) => o.externalId)).toEqual(['MOCK-1001', 'MOCK-1002', 'MOCK-1003']);
    const detail = await inA((c) =>
      ports.accounts.get(c, account, new Date('2026-11-21T12:00:00.000Z')),
    );
    expect(detail).toMatchObject({ status: 'active' });
    // Usage per API, in eBay's own day (RL-5); no buyer field reached the sink or the logs.
    const usage = await root.query<{ api: string; calls: string }>(
      `SELECT api, calls FROM app.api_usage_daily WHERE channel_account_id = $1 ORDER BY api`,
      [account],
    );
    expect(usage.rows).toEqual([
      { api: 'identity.user_token', calls: '1' },
      { api: 'sell.fulfillment', calls: '3' },
    ]);
    // M10: buyer fields leave the parser only in the `buyer` block, which the order ingest gives
    // to pii-vault (and strips) before its transaction; nothing else in the order carries any.
    expect(JSON.stringify(received.map((o) => ({ ...o, buyer: null })))).not.toContain('PIIMARK');
    expect(received.every((o) => o.buyer?.channel_username?.startsWith('PIIMARK') === true)).toBe(
      true,
    );
    expect(lines.join('\n')).not.toMatch(/PIIMARK|TOKENMARK/);
  });

  it('[INT-5] a missing field raises one platform notice and fails the job once, with no retry', async () => {
    const broken = defineParser('ebay', 'orders', 9, z.object({ orderTotal: z.string() }));
    const stream = () =>
      Promise.resolve({
        ...ebayOrderStream(ebay(), { sink: () => Promise.resolve() }),
        fetchPage: async () => {
          broken.parse({ orders: [] });
          return Promise.resolve({ items: [], next: undefined });
        },
      });
    for (let i = 0; i < 2; i += 1) {
      const err = await handler(stream)
        .prepare(job())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentJobError);
      expect((err as PermanentJobError).code).toBe('provider.parser_failed');
    }
    const notices = await root.query<{ type: string; record_kind: string; record_id: string }>(
      `SELECT type, record_kind, record_id FROM app.platform_notifications
        WHERE type = 'platform.report_failure'`,
    );
    expect(notices.rows).toEqual([
      { type: 'platform.report_failure', record_kind: 'parser_ebay_orders', record_id: '9' },
    ]);
    expect(lines.join('\n')).toContain('"fieldPath":"orderTotal"');
  });

  it('[INT-8] a run that failed after storing a part is no success of its stream', async () => {
    const cursors = new SyncCursorRepository(db.db);
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 12, minute));
    const state = { cursorAt: null, overlap: [{ id: 'A', at: at(0).toISOString() }] };
    const row = async () =>
      (
        await root.query<{ last_run_at: Date; last_success_at: Date | null; overlap: unknown[] }>(
          `SELECT last_run_at, last_success_at, overlap FROM app.sync_cursors
            WHERE channel_account_id = $1 AND stream = 'website.orders'`,
          [account],
        )
      ).rows[0];
    const save = (minute: number, options?: { failed: true }) =>
      inA((c) => cursors.save(c, account, 'website.orders', state, at(minute), options));
    await save(1, { failed: true });
    expect(await row()).toEqual({
      last_run_at: at(1),
      last_success_at: null,
      overlap: state.overlap,
    });
    await save(2);
    await save(3, { failed: true });
    expect(await row()).toMatchObject({ last_run_at: at(3), last_success_at: at(2) });
  });

  it('[INT-4] a revoked eBay token marks the account and raises one critical notice; a success after re-auth resolves it', async () => {
    scenarios.set('ebay', refresh, 'revoked');
    ports.tokens.invalidate(account);
    // A refused token ends the job at once (no retries that spend eBay calls).
    for (let i = 0; i < 2; i += 1) {
      const err = await handler()
        .prepare(job())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentJobError);
      expect((err as PermanentJobError).code).toBe('provider.auth_failed');
    }
    const open = await root.query<{ severity: string; resolved_at: Date | null }>(
      `SELECT severity, resolved_at FROM app.notifications
        WHERE workspace_id = $1 AND type = 'channel.auth_lost'`,
      [A],
    );
    expect(open.rows).toEqual([{ severity: 'critical', resolved_at: null }]);
    expect(
      await inA((c) => ports.accounts.get(c, account, new Date('2026-11-21T12:00:00.000Z'))),
    ).toMatchObject({ status: 'needs_reauth' });

    scenarios.clear();
    await handler().prepare(job());
    const after = await root.query<{ resolved: boolean }>(
      `SELECT resolved_at IS NOT NULL AS resolved FROM app.notifications
        WHERE workspace_id = $1 AND type = 'channel.auth_lost'`,
      [A],
    );
    expect(after.rows).toEqual([{ resolved: true }]);
  });

  it('[INT-3] a call to a host off the allowlist ends the job without sending anything', async () => {
    const live = new ProviderHttp({ mode: 'mock', mocksUrl: 'http://provider-mocks:8080' });
    const stream = () =>
      Promise.resolve({
        ...ebayOrderStream(ebay(), { sink: () => Promise.resolve() }),
        fetchPage: () =>
          live
            .request('ebay', { url: 'https://api.ebay.com/sell/fulfillment/v1/order' })
            .then(() => ({ items: [], next: undefined })),
      });
    const err = await handler(stream)
      .prepare(job())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentJobError);
    expect((err as PermanentJobError).code).toBe('provider.egress_refused');
  });
  it('[INT-3] the marker scan finds no token in db-main, the job tables or the logs', async () => {
    expect(await scanDatabaseForMarkers(cluster, ['app', 'pgboss'], TOKEN_MARKER)).toEqual([]);
    expect(scanTextForMarkers(lines, TOKEN_MARKER)).toEqual([]);
  });
});
