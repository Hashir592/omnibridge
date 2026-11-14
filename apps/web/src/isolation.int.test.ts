import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractRoutes } from '@omnibridge/contract';
import type { TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  AuditLog,
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  FileRepository,
  JobRecordRepository,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { EncryptedLocalFileStore, FileKeyStore, signFileLink } from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';
import {
  platformHeaders,
  sessionHeaders,
  startRoleCluster,
  stubAuth,
  walkIsolation,
  type RoleCluster,
} from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const MARKER = 'WSB-MARKER';
const PDF = Buffer.from('%PDF-1.7\n% synthetic marker file\n%%EOF\n');
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };

describe('cross-workspace isolation on every route (TEN-1, AT-1, SEC-3)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let platformPool: pg.Pool;
  let tenancy: Tenancy;
  let store: EncryptedLocalFileStore;
  const linkKey = randomBytes(32);
  const A = randomUUID();
  const B = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const admin = randomUUID();
  const b = { company: '', job: '', file: '' };
  const a = { company: '', job: '' };

  const repos = () => ({
    workspaces: new WorkspaceRepository(main.db),
    companies: new CompanyRepository(main.db),
    jobs: new JobRecordRepository(main.db),
    users: new UserRepository(main.db),
    memberships: new MembershipRepository(main.db),
  });

  /** Everything workspace B holds, read inside B's own tenant transaction. */
  const snapshotB = () =>
    tenancy.runWorkspace({ workspaceId: B }, async (ctx: TenantContext) => {
      const r = repos();
      return JSON.stringify({
        workspace: await r.workspaces.get(ctx),
        companies: await r.companies.list(ctx),
        job: await r.jobs.get(ctx, b.job),
        file: await new FileRepository(main.db).get(ctx, b.file),
        accounts: await new ChannelAccountRepository(main.db).list(ctx),
        users: await r.users.list(ctx),
        audit: await new AuditLog(main.db).list(ctx, {}, { limit: 200 }),
      });
    });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    platformPool = new pg.Pool({ ...cluster.connection('ob_platform'), max: 1 });
    tenancy = new Tenancy(main.db);
    const r = repos();
    const root = mkdtempSync(join(tmpdir(), 'ob-isolation-'));
    store = new EncryptedLocalFileStore({
      root,
      keys: new FileKeyStore(root, parseKeyring('secrets', generateKekLine(1))),
      metadata: new FileRepository(main.db),
      linkKey,
    });

    for (const [ws, name, user] of [
      [A, 'Workspace A', userA],
      [B, `${MARKER} workspace`, userB],
    ] as const) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: user }, async (ctx) => {
        await r.workspaces.create(ctx, { name });
        await r.users.create(ctx, {
          id: user,
          email: `${user}@example.test`,
          name: `${MARKER}-${user}`,
        });
        await r.memberships.add(ctx, { userId: user, role: 'admin' });
      });
    }
    a.company = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      r.companies.create(ctx, { legalName: 'A Ltd', tradingName: 'A', registeredAddress: address }),
    );
    b.company = await tenancy.runWorkspace({ workspaceId: B }, (ctx) =>
      r.companies.create(ctx, {
        legalName: `${MARKER} Ltd`,
        tradingName: MARKER,
        registeredAddress: address,
      }),
    );
    await tenancy.runWorkspace({ workspaceId: B }, (ctx) =>
      new ChannelAccountRepository(main.db).create(ctx, {
        companyId: b.company,
        provider: 'ebay',
        displayName: `${MARKER} ebay`,
      }),
    );
    const job = (ws: string) =>
      tenancy.runWorkspace(
        { workspaceId: ws },
        async (ctx) =>
          (
            await r.jobs.createAndEnqueue(
              ctx,
              {
                id: randomUUID(),
                type: 'orders.export',
                idempotencyKey: ws === B ? `${MARKER}-export` : 'export-a',
              },
              () => Promise.resolve(),
            )
          ).id,
      );
    a.job = await job(A);
    b.job = await job(B);
    // An audit event in B that names B's own rows (AUD-4 routes are walked too).
    await tenancy.runWorkspace({ workspaceId: B, userId: userB }, (ctx) =>
      new AuditLog(main.db).record(ctx, {
        action: 'connection.added',
        actor: { kind: 'user', userId: userB },
        entityId: b.company,
        after: { provider: 'ebay', display_name: `${MARKER} ebay`, company_id: b.company },
        reason: `${MARKER} reason`,
      }),
    );
    b.file = await tenancy.runWorkspace({ workspaceId: B }, async (ctx) => {
      const id = await store.put(ctx, {
        body: PDF,
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
      });
      await store.setState(ctx, id, 'clean');
      return id;
    });
  });

  afterAll(async () => {
    await platformPool.end();
    await main.destroy();
    await cluster.container.stop();
  });

  const app = () => {
    const r = repos();
    return buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      directory: { workspaces: r.workspaces, companies: r.companies },
      audit: new AuditLog(main.db),
      jobs: r.jobs,
      files: { store, linkKey },
      ...stubAuth(),
    });
  };

  it('[TEN-1][AT-1] route walker: no cross-workspace read or write on any route', async () => {
    const server = app();
    const sessionA = sessionHeaders({ workspaceId: A, userId: userA, sessionId: 'session-a' });
    // A valid link for B's file, signed for A's own session: only the tenant check can stop it.
    const link = signFileLink({ fileId: b.file, sessionId: 'session-a' }, linkKey);
    const workspacesBefore = (await platformPool.query('SELECT id FROM app.workspaces')).rowCount;
    const before = await snapshotB();

    const outcomes = await walkIsolation({
      routes: contractRoutes,
      inject: async (req) => {
        const res = await server.inject({
          method: req.method as 'GET',
          url: req.url,
          headers: req.headers,
          ...(req.payload === undefined ? {} : { payload: req.payload as object }),
        });
        return { statusCode: res.statusCode, body: res.body };
      },
      anonymous: {},
      workspaceA: sessionA,
      againstB: {
        getHealth: {},
        getJob: { params: { id: b.job } },
        getFile: { params: { id: b.file }, query: { exp: link.exp, sig: link.sig } },
        listCompanies: {},
        createWorkspace: { body: { name: `${MARKER} new` } },
        createCompany: {
          params: { workspaceId: B },
          body: { legal_name: `${MARKER} 2 Ltd`, trading_name: 'x', registered_address: address },
        },
        // Plain lists as A's admin: only A's events may come back, never B's.
        listAuditEvents: {},
        exportAuditEvents: {},
        // Sign-in routes (T-0203): public ones may answer anything but must leak nothing of B;
        // the pre-MFA and signed-in ones refuse a workspace session.
        getCsrf: {},
        signIn: { body: { email: `${userB}@example.test`, password: MARKER } },
        verifyMfa: { body: { code: '123456' } },
        useRecoveryCode: { body: { code: MARKER } },
        startMfaEnrolment: {},
        confirmMfaEnrolment: { body: { code: '123456' } },
        forgotPassword: { body: { email: `${userB}@example.test` } },
        getPasswordReset: { params: { token: MARKER } },
        resetPassword: { body: { token: MARKER, password: 'a long enough password 1' } },
        listMyWorkspaces: {},
        chooseWorkspace: { body: { workspaceId: B } },
        enterPlatform: {},
        getTerms: {},
        acceptTerms: { body: { version: '2026-11-15' } },
        changePassword: { body: { currentPassword: MARKER, password: 'a long enough password 1' } },
        signOut: {},
        signOutEverywhere: {},
        // eBay webhook (T-0602): unconfigured here, so it answers 503 or 401 and leaks nothing.
        ebayAccountDeletionChallenge: { query: { challenge_code: MARKER } },
        ebayAccountDeletion: {
          body: { metadata: { topic: MARKER }, notification: { userId: userB } },
        },
      },
      markers: [MARKER, B, b.company, b.job, b.file, userB],
    });

    console.info(
      `route walker: ${String(outcomes.length / 2)} routes walked, ${String(outcomes.length)} calls`,
    );
    expect(new Set(outcomes.map((o) => o.route))).toEqual(new Set(contractRoutes.map((r) => r.id)));
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    expect(await snapshotB()).toBe(before);
    expect((await platformPool.query('SELECT id FROM app.workspaces')).rowCount).toBe(
      workspacesBefore,
    );
    await server.close();
  });

  it('[TEN-1] the walked routes work for their own workspace and for a platform admin', async () => {
    // Positive controls, so the walker cannot pass because every call fails.
    const server = app();
    const sessionA = sessionHeaders({ workspaceId: A, userId: userA, sessionId: 'session-a' });
    const own = await server.inject({ method: 'GET', url: `/jobs/${a.job}`, headers: sessionA });
    expect(own.statusCode).toBe(200);
    const list = await server.inject({ method: 'GET', url: '/companies', headers: sessionA });
    expect(list.json()).toEqual({ items: [expect.objectContaining({ id: a.company })] });

    const created = await server.inject({
      method: 'POST',
      url: '/platform/workspaces',
      headers: platformHeaders(admin),
      payload: { name: 'Created by platform' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    const company = await server.inject({
      method: 'POST',
      url: `/platform/workspaces/${id}/companies`,
      headers: platformHeaders(admin),
      payload: { legal_name: 'New Ltd', trading_name: 'New', registered_address: address },
    });
    expect(company.statusCode).toBe(201);
    const missing = await server.inject({
      method: 'POST',
      url: `/platform/workspaces/${randomUUID()}/companies`,
      headers: platformHeaders(admin),
      payload: { legal_name: 'Nowhere Ltd', trading_name: 'Nowhere', registered_address: address },
    });
    expect(missing.statusCode).toBe(404);
    // The platform answer carries ids only, never the workspace's business data (PLAT-3).
    expect(Object.keys(company.json<object>())).toEqual(['id']);
    await server.close();
  });
});
