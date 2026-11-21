import { randomUUID } from 'node:crypto';
import { Notifier } from '@omnibridge/core';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  AccountCredentials,
  AuditLog,
  ChannelAccountRepository,
  CompanyRepository,
  ConnectionRepository,
  createMainDb,
  CredentialRepository,
  MembershipRepository,
  migrateMain,
  NotificationRepository,
  OAuthStateRepository,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { buildMockServer } from '@omnibridge/provider-mocks';
import { sessionHeaders, startRoleCluster, stubAuth, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';
import { createOAuthFlows } from './oauth-exchange.ts';

const lines: string[] = [];
const logger = createLogger({
  service: 'test',
  version: '0',
  destination: { write: (line: string) => lines.push(line) },
});
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const APP = 'https://app.omnibridge.test';

/**
 * Connections (INT-4) and the OAuth connect flow (INT-2, INT-3): the page's data, and a seller
 * going to the provider's consent page and back, with the token stored encrypted and the state
 * good for one use.
 */
describe('Connections and the OAuth connect flow (T-0701)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  const mock = buildMockServer(createLogger({ service: 'mock', version: '0', level: 'silent' }));
  let mockUrl = '';
  const A = randomUUID();
  const admin = randomUUID();
  const child = randomUUID();
  let ebay = '';
  let evri = '';

  const app = () =>
    buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      ...stubAuth(),
      connections: {
        connections: new ConnectionRepository(db.db),
        oauth: {
          flows: createOAuthFlows({
            mode: 'mock',
            mocksUrl: mockUrl,
            mocksPublicUrl: mockUrl,
            secrets: (name) => Promise.resolve(new Secret(`synthetic-${name}`)),
          }),
          states: new OAuthStateRepository(db.db),
          credentials: new AccountCredentials(
            db.db,
            new CredentialRepository({
              keyring: parseKeyring('secrets', generateKekLine(1)),
              logger,
            }),
          ),
          tenancy,
          audit: new AuditLog(db.db),
          notifier: new Notifier({ store: new NotificationRepository(db.db) }),
          appOrigin: APP,
        },
        logger,
        now: () => new Date('2026-11-21T12:00:00.000Z'),
      },
    });
  const asAdmin = sessionHeaders({ workspaceId: A, userId: admin, sessionId: 'session-admin' });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    db = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    mockUrl = await mock.listen({ host: '127.0.0.1', port: 0 });
    for (const [user, role] of [
      [admin, 'admin'],
      [child, 'member'],
    ] as const) {
      await tenancy.run({ workspaceId: A, companyIds: [], userId: user }, async (ctx) => {
        if (role === 'admin')
          await new WorkspaceRepository(db.db).create(ctx, { name: 'Connect test' });
        await new UserRepository(db.db).create(ctx, {
          id: user,
          email: `${user}@example.test`,
          name: role,
        });
        await new MembershipRepository(db.db).add(ctx, { userId: user, role });
      });
    }
    const company = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      new CompanyRepository(db.db).create(ctx, {
        legalName: 'Connect Ltd',
        tradingName: 'Connect',
        registeredAddress: address,
      }),
    );
    const accounts = new ChannelAccountRepository(db.db);
    ebay = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      accounts.create(ctx, { companyId: company, provider: 'ebay', displayName: 'eBay main' }),
    );
    evri = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      accounts.create(ctx, { companyId: company, provider: 'evri', displayName: 'Evri' }),
    );
  });

  afterAll(async () => {
    await mock.close();
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[INT-4] the list shows every account with each Connections field; a child without the tab gets 403', async () => {
    const server = app();
    const res = await server.inject({ method: 'GET', url: '/api/connections', headers: asAdmin });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Record<string, unknown>[]; maintenance: unknown }>();
    expect(body.maintenance).toEqual({ on: false, since: null });
    expect(body.items.map((i) => [i.id, i.provider, i.status])).toEqual([
      [ebay, 'ebay', 'disconnected'],
      [evri, 'evri', 'disconnected'],
    ]);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      'company_id',
      'consecutive_auth_failures',
      'display_name',
      'id',
      'kill_switch',
      'last_success_at',
      'last_token_refresh_at',
      'provider',
      'status',
      'usage_today',
    ]);
    const childRes = await server.inject({
      method: 'GET',
      url: '/api/connections',
      headers: sessionHeaders({ workspaceId: A, userId: child, sessionId: 'session-child' }),
    });
    expect(childRes.statusCode).toBe(403);
    await server.close();
  });

  it('[INT-2][INT-3] connecting: consent, the code exchange against the mock, the token stored encrypted, the state used once', async () => {
    const server = app();
    const start = await server.inject({
      method: 'POST',
      url: `/api/connections/${ebay}/authorise`,
      headers: { ...asAdmin, origin: APP },
    });
    expect(start.statusCode).toBe(200);
    const consent = new URL(start.json<{ redirect_url: string }>().redirect_url);
    expect(consent.origin).toBe(new URL(mockUrl).origin);
    expect(consent.searchParams.get('redirect_uri')).toBe(`${APP}/api/oauth/ebay/callback`);

    // The seller agrees on the mock consent page, which sends the browser back with a code.
    const agreed = await fetch(consent, { redirect: 'manual' });
    const back = new URL(agreed.headers.get('location') ?? '');
    expect(back.pathname).toBe('/api/oauth/ebay/callback');
    const callback = `${back.pathname}${back.search}`;

    const done = await server.inject({ method: 'GET', url: callback });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe(`${APP}/connections?connected=${ebay}`);

    const detail = await server.inject({
      method: 'GET',
      url: `/api/connections/${ebay}`,
      headers: asAdmin,
    });
    expect(detail.json()).toMatchObject({
      status: 'active',
      last_token_refresh_at: '2026-11-21T12:00:00.000Z',
      credentials: [{ kind: 'ebay.refresh_token', slot: 'current' }],
    });
    // The refresh token (the mock code) rests as ciphertext only, and was never logged.
    const code = back.searchParams.get('code') ?? 'x';
    const stored = await root.query<{ v: Buffer }>(
      `SELECT encrypted_value AS v FROM app.credentials WHERE channel_account_id = $1`,
      [ebay],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.v.includes(Buffer.from(code))).toBe(false);
    expect(lines.join('\n')).not.toContain(code);
    const audit = await root.query<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE workspace_id = $1 AND entity_id = $2`,
      [A, ebay],
    );
    expect(audit.rows).toEqual([{ action: 'connection.reauthorised' }]);

    // The same return again: the state is spent.
    const replay = await server.inject({ method: 'GET', url: callback });
    expect(replay.headers.location).toBe(`${APP}/connections?error=state_invalid`);
    // A made-up state goes nowhere.
    const forged = await server.inject({
      method: 'GET',
      url: `/api/oauth/ebay/callback?state=${A}.${'x'.repeat(43)}&code=abc`,
    });
    expect(forged.headers.location).toBe(`${APP}/connections?error=state_invalid`);
    // The seller declines on the provider page: access_denied, and nothing is stored.
    const again = await server.inject({
      method: 'POST',
      url: `/api/connections/${ebay}/authorise`,
      headers: { ...asAdmin, origin: APP },
    });
    const state = new URL(again.json<{ redirect_url: string }>().redirect_url).searchParams.get(
      'state',
    );
    const declined = await server.inject({
      method: 'GET',
      url: `/api/oauth/ebay/callback?state=${state ?? ''}&error=access_denied`,
    });
    expect(declined.headers.location).toBe(`${APP}/connections?error=access_denied`);
    expect(
      (await root.query(`SELECT 1 FROM app.credentials WHERE channel_account_id = $1`, [ebay]))
        .rows,
    ).toHaveLength(1);
    await server.close();
  });

  it('[INT-4] an API-key account is not connected through a provider sign-in', async () => {
    const server = app();
    const res = await server.inject({
      method: 'POST',
      url: `/api/connections/${evri}/authorise`,
      headers: { ...asAdmin, origin: APP },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
  it('[INT-2] a return for an admin who left the workspace meanwhile stores nothing and says so', async () => {
    const server = app();
    const leaver = randomUUID();
    await tenancy.run({ workspaceId: A, companyIds: [], userId: leaver }, async (ctx) => {
      await new UserRepository(db.db).create(ctx, {
        id: leaver,
        email: `${leaver}@example.test`,
        name: 'Leaver',
      });
      await new MembershipRepository(db.db).add(ctx, { userId: leaver, role: 'admin' });
    });
    const start = await server.inject({
      method: 'POST',
      url: `/api/connections/${ebay}/authorise`,
      headers: {
        ...sessionHeaders({ workspaceId: A, userId: leaver, sessionId: 'session-leaver' }),
        origin: APP,
      },
    });
    const consent = start.json<{ redirect_url: string }>().redirect_url;
    const back = new URL(
      (await fetch(consent, { redirect: 'manual' })).headers.get('location') ?? '',
    );
    await root.query('DELETE FROM app.memberships WHERE workspace_id = $1 AND user_id = $2', [
      A,
      leaver,
    ]);
    const count = 'SELECT count(*)::int AS n FROM app.credentials';
    const before = (await root.query(count)).rows;
    const done = await server.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe(`${APP}/connections?error=forbidden`);
    expect((await root.query(count)).rows).toEqual(before);
    await server.close();
  });
});
