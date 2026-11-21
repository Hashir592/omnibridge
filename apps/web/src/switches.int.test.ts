import { randomUUID } from 'node:crypto';
import { Notifier } from '@omnibridge/core';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  AccountCredentials,
  AuditLog,
  BulkConfirmationRepository,
  ChannelAccountRepository,
  CompanyRepository,
  ConnectionRepository,
  createMainDb,
  CredentialRepository,
  MemberAccessRepository,
  MembershipRepository,
  migrateMain,
  NotificationRepository,
  OAuthStateRepository,
  OutboundWriteRepository,
  PlatformConsole,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { OutboundQueue } from '@omnibridge/queue';
import {
  platformHeaders,
  sessionHeaders,
  startRoleCluster,
  stubAuth,
  type RoleCluster,
} from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const APP = 'https://app.omnibridge.test';

/**
 * The T-0702 routes: the kill switch (SAFE-2), bulk confirmation (SAFE-1), the maintenance switch
 * (SAFE-3) and live usage (RL-5), on real PostgreSQL with a stand-in queue that records each job.
 */
describe('kill switch, bulk confirmation, maintenance and live usage (T-0702)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  let clock = new Date('2026-11-21T12:00:00.000Z');
  const jobs: { type: string; writeId: string }[] = [];
  const operator = randomUUID();
  const A = {
    id: randomUUID(),
    admin: randomUUID(),
    child: randomUUID(),
    c1: '',
    c2: '',
    a1: '',
    a2: '',
  };
  const B = { id: randomUUID(), admin: randomUUID(), account: '' };

  const outbound = () =>
    new OutboundQueue({
      queue: {
        send: (def, input) => {
          jobs.push({ type: def.type, writeId: (input.payload as { write_id: string }).write_id });
          return Promise.resolve({ id: randomUUID(), created: true });
        },
      },
      writes: new OutboundWriteRepository(db.db),
      now: () => clock,
    });

  const app = () => {
    const queue = outbound();
    return buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      ...stubAuth(),
      connections: {
        connections: new ConnectionRepository(db.db),
        outbound: queue,
        audit: new AuditLog(db.db),
        bulk: {
          confirmations: new BulkConfirmationRepository(db.db),
          actions: {
            // A stand-in stock push: one write per account, through the outbound path.
            stock_push: {
              tab: 'stock-catalogue',
              params: z.object({}).strict(),
              run: async (ctx, input) => {
                for (const account of input.accounts) {
                  await queue.enqueue(ctx, {
                    channelAccountId: account.id,
                    provider: account.provider,
                    operation: 'ebay.stock_push',
                    urgent: false,
                    idempotencyKey: `bulk:${randomUUID()}`,
                    payload: { levels: [{ sku: 'MOCK-SKU-1', quantity: 1 }] },
                  });
                }
                return input.accounts.length;
              },
            },
          },
        },
        oauth: {
          flows: {
            consent: () => Promise.resolve(undefined),
            exchange: () => Promise.reject(new Error('none')),
          },
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
        now: () => clock,
      },
      platform: {
        console: new PlatformConsole(db.db),
        outbound: {
          maintenanceWorkspaces: () => new OutboundWriteRepository(db.db).maintenanceWorkspaces(),
          resume: (ctx) => queue.resumeMaintenance(ctx),
        },
        queue: { send: () => Promise.resolve({ id: randomUUID(), created: true }) },
        audit: new AuditLog(db.db),
        tenancy,
        checks,
        version: '0',
        logger,
        now: () => clock,
      },
    });
  };
  const as = (ws: string, user: string) => ({
    ...sessionHeaders({ workspaceId: ws, userId: user, sessionId: `s-${user}` }),
    origin: APP,
  });

  /** A write held by a switch, as the send path leaves it. */
  const heldWrite = async (ws: string, account: string, reason: 'kill_switch' | 'maintenance') => {
    const writes = new OutboundWriteRepository(db.db);
    return tenancy.runWorkspace({ workspaceId: ws }, async (ctx) => {
      const { id } = await writes.insert(
        ctx,
        {
          channelAccountId: account,
          provider: 'ebay',
          operation: 'ebay.stock_push',
          urgent: false,
          idempotencyKey: `held:${randomUUID()}`,
          payload: { levels: [{ sku: 'MOCK-SKU-1', quantity: 2 }] },
        },
        clock,
      );
      await writes.pause(ctx, id, reason, clock);
      return id;
    });
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    db = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    for (const [ws, admin] of [
      [A.id, A.admin],
      [B.id, B.admin],
    ] as const) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: admin }, async (ctx) => {
        await new WorkspaceRepository(db.db).create(ctx, { name: 'Switch test' });
        await new UserRepository(db.db).create(ctx, {
          id: admin,
          email: `${admin}@example.test`,
          name: 'Admin',
        });
        await new MembershipRepository(db.db).add(ctx, { userId: admin, role: 'admin' });
      });
    }
    await tenancy.run({ workspaceId: A.id, companyIds: [], userId: A.child }, async (ctx) => {
      await new UserRepository(db.db).create(ctx, {
        id: A.child,
        email: `${A.child}@example.test`,
        name: 'Child',
      });
      await new MembershipRepository(db.db).add(ctx, { userId: A.child, role: 'member' });
    });
    const companies = new CompanyRepository(db.db);
    const accounts = new ChannelAccountRepository(db.db);
    const inA = <T>(
      fn: (ctx: Parameters<Parameters<Tenancy['runWorkspace']>[1]>[0]) => Promise<T>,
    ) => tenancy.runWorkspace({ workspaceId: A.id }, fn);
    A.c1 = await inA((c) =>
      companies.create(c, { legalName: 'One Ltd', tradingName: 'One', registeredAddress: address }),
    );
    A.c2 = await inA((c) =>
      companies.create(c, { legalName: 'Two Ltd', tradingName: 'Two', registeredAddress: address }),
    );
    A.a1 = await inA((c) =>
      accounts.create(c, { companyId: A.c1, provider: 'ebay', displayName: 'eBay One' }),
    );
    A.a2 = await inA((c) =>
      accounts.create(c, { companyId: A.c2, provider: 'ebay', displayName: 'eBay Two' }),
    );
    const cb = await tenancy.runWorkspace({ workspaceId: B.id }, (c) =>
      companies.create(c, { legalName: 'B Ltd', tradingName: 'B', registeredAddress: address }),
    );
    B.account = await tenancy.runWorkspace({ workspaceId: B.id }, (c) =>
      accounts.create(c, { companyId: cb, provider: 'ebay', displayName: 'eBay B' }),
    );
    // The platform operator, with MFA, as the console's own checks read them.
    await root.query(
      `INSERT INTO app.users (id, email, name, platform_admin) VALUES ($1, $2, 'Operator', true)`,
      [operator, `${operator}@example.test`],
    );
    await root.query(
      `INSERT INTO app.user_auth (user_id, password_hash, password_set_at, totp_secret,
                                  totp_key_version, mfa_confirmed_at)
       VALUES ($1, '$argon2id$synthetic', now(), '\\x00', 1, now())`,
      [operator],
    );
  });

  afterAll(async () => {
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[SAFE-2] pausing an account is audited and shown; resuming sends its held writes at once', async () => {
    const server = app();
    const paused = await server.inject({
      method: 'PUT',
      url: `/api/connections/${A.a1}/kill-switch`,
      headers: as(A.id, A.admin),
      payload: { paused: true },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({
      id: A.a1,
      status: 'disconnected',
      kill_switch: { paused: true },
    });
    const held = await heldWrite(A.id, A.a1, 'kill_switch');
    jobs.length = 0;
    const resumed = await server.inject({
      method: 'PUT',
      url: `/api/connections/${A.a1}/kill-switch`,
      headers: as(A.id, A.admin),
      payload: { paused: false },
    });
    expect(resumed.json()).toMatchObject({ kill_switch: { paused: false, paused_at: null } });
    expect(jobs).toEqual([{ type: 'outbound.send', writeId: held }]);
    const audit = await root.query<{ action: string; after: unknown }>(
      `SELECT action, after FROM app.audit_events WHERE workspace_id = $1 AND entity_id = $2
        ORDER BY occurred_at`,
      [A.id, A.a1],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['kill_switch.changed', 'kill_switch.changed']);
    // Another workspace's account cannot be paused from here.
    const other = await server.inject({
      method: 'PUT',
      url: `/api/connections/${B.account}/kill-switch`,
      headers: as(A.id, A.admin),
      payload: { paused: true },
    });
    expect(other.statusCode).toBe(404);
    await server.close();
  });

  it('[SAFE-1] the preview names every account; the write runs only with a valid token, once, for the previewed accounts', async () => {
    const server = app();
    const preview = await server.inject({
      method: 'POST',
      url: '/api/bulk-writes/preview',
      headers: as(A.id, A.admin),
      payload: { action: 'stock_push', channel_account_ids: [A.a2, A.a1] },
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json<{
      token: string;
      accounts: { id: string; display_name: string }[];
    }>();
    expect(body.accounts.map((a) => a.display_name).sort()).toEqual(['eBay One', 'eBay Two']);
    const confirm = (token: string, headers = as(A.id, A.admin), extra: object = {}) =>
      server.inject({
        method: 'POST',
        url: '/api/bulk-writes/confirm',
        headers,
        payload: { token, ...extra },
      });

    // No valid token: unknown (404), another user's (409), a changed account list (400).
    expect((await confirm('x'.repeat(43))).statusCode).toBe(404);
    expect((await confirm(body.token, as(A.id, A.child))).statusCode).toBe(409);
    expect(
      (await confirm(body.token, as(A.id, A.admin), { channel_account_ids: [A.a1] })).statusCode,
    ).toBe(400);
    jobs.length = 0;
    const ok = await confirm(body.token);
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ action: 'stock_push', account_count: 2, queued: 2 });
    expect(jobs).toHaveLength(2);
    // Used once.
    expect((await confirm(body.token)).statusCode).toBe(409);
    // Expired after 10 minutes.
    const late = await server.inject({
      method: 'POST',
      url: '/api/bulk-writes/preview',
      headers: as(A.id, A.admin),
      payload: { action: 'stock_push', channel_account_ids: [A.a1, A.a2] },
    });
    clock = new Date(clock.getTime() + 10 * 60_000 + 1);
    expect((await confirm(late.json<{ token: string }>().token)).statusCode).toBe(409);
    // An action no module offers yet, and another workspace's account.
    const none = await server.inject({
      method: 'POST',
      url: '/api/bulk-writes/preview',
      headers: as(A.id, A.admin),
      payload: { action: 'ads_change', channel_account_ids: [A.a1, A.a2] },
    });
    expect(none.statusCode).toBe(409);
    const foreign = await server.inject({
      method: 'POST',
      url: '/api/bulk-writes/preview',
      headers: as(A.id, A.admin),
      payload: { action: 'stock_push', channel_account_ids: [A.a1, B.account] },
    });
    expect(foreign.statusCode).toBe(404);
    await server.close();
  });

  it('[SAFE-1] a child confirms only what is still in their scope', async () => {
    const server = app();
    const access = new MemberAccessRepository(db.db);
    const tick = (companyIds: string[]) =>
      tenancy.runWorkspace({ workspaceId: A.id, userId: A.admin }, (ctx) =>
        access.set(ctx, A.child, { role: 'member', tabs: ['stock-catalogue'], companyIds }),
      );
    await tick([A.c1, A.c2]);
    const preview = await server.inject({
      method: 'POST',
      url: '/api/bulk-writes/preview',
      headers: as(A.id, A.child),
      payload: { action: 'stock_push', channel_account_ids: [A.a1, A.a2] },
    });
    expect(preview.statusCode).toBe(200);
    await tick([A.c1]);
    const confirm = await server.inject({
      method: 'POST',
      url: '/api/bulk-writes/confirm',
      headers: as(A.id, A.child),
      payload: { token: preview.json<{ token: string }>().token },
    });
    expect(confirm.statusCode).toBe(409);
    await server.close();
  });

  it("[SAFE-3] maintenance is a platform switch, audited and shown to every workspace; turning it off sends each workspace's held writes", async () => {
    const server = app();
    const on = await server.inject({
      method: 'PUT',
      url: '/api/platform/maintenance',
      headers: { ...platformHeaders(operator), origin: APP },
      payload: { maintenance: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ maintenance: true });
    const list = await server.inject({
      method: 'GET',
      url: '/api/connections',
      headers: as(B.id, B.admin),
    });
    expect(list.json<{ maintenance: { on: boolean } }>().maintenance.on).toBe(true);
    const heldA = await heldWrite(A.id, A.a2, 'maintenance');
    const heldB = await heldWrite(B.id, B.account, 'maintenance');
    jobs.length = 0;
    const off = await server.inject({
      method: 'PUT',
      url: '/api/platform/maintenance',
      headers: { ...platformHeaders(operator), origin: APP },
      payload: { maintenance: false },
    });
    expect(off.json()).toMatchObject({ maintenance: false });
    expect(jobs.map((j) => j.writeId).sort()).toEqual([heldA, heldB].sort());
    const audit = await root.query<{ action: string; params: unknown }>(
      `SELECT action, params FROM app.platform_audit_events WHERE user_id = $1 ORDER BY occurred_at`,
      [operator],
    );
    expect(audit.rows).toEqual([
      { action: 'platform.maintenance_changed', params: { enabled: true } },
      { action: 'platform.maintenance_changed', params: { enabled: false } },
    ]);
    await server.close();
  });

  it("[RL-5] live usage shows today's calls per account and API with their update time, and the eBay budget with its stop points", async () => {
    const server = app();
    await root.query(
      `INSERT INTO app.api_usage_daily (workspace_id, channel_account_id, provider, api, day, calls,
                                        cap, updated_at)
       VALUES ($1, $2, 'ebay', 'sell.inventory', $3, 7, 100, $4)`,
      [A.id, A.a1, '2026-11-21', clock],
    );
    await root.query(
      `INSERT INTO app.ebay_budget_daily (api, day, calls, cap, updated_at)
       VALUES ('sell.inventory', '2026-11-21', 7, 100, $1)`,
      [clock],
    );
    const res = await server.inject({
      method: 'GET',
      url: '/api/platform/api-usage/live',
      headers: platformHeaders(operator),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ebay_budget: [
        {
          api: 'sell.inventory',
          day: '2026-11-21',
          calls: 7,
          cap: 100,
          non_urgent_limit: 80,
          hard_limit: 95,
        },
      ],
      items: [
        {
          workspace_id: A.id,
          channel_account_id: A.a1,
          provider: 'ebay',
          api: 'sell.inventory',
          day: '2026-11-21',
          calls: 7,
          cap: 100,
          updated_at: clock.toISOString(),
        },
      ],
    });
    await server.close();
  });
});
