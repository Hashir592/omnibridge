import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractRoutes } from '@omnibridge/contract';
import type { TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  AccessReviewRepository,
  AuditLog,
  AuthStore,
  ChannelAccountRepository,
  DeletionLog,
  ErasureRequestRepository,
  CompanyRepository,
  createMainDb,
  FileRepository,
  InviteRepository,
  JobRecordRepository,
  MemberAccessRepository,
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
  const childA = randomUUID();
  const admin = randomUUID();
  const b = {
    company: '',
    job: '',
    file: '',
    invite: '',
    review: '',
    account: '',
    erasure: '',
  };
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
        members: await new MemberAccessRepository(main.db).list(ctx),
        invites: await new InviteRepository(main.db).pending(ctx),
        reviews: await new AccessReviewRepository(main.db).list(ctx),
        erasures: await new ErasureRequestRepository(main.db).list(ctx),
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
          // Only B's rows carry the marker, so anything of A may show up freely.
          name: ws === B ? `${MARKER}-${user}` : 'User of A',
        });
        await r.memberships.add(ctx, { userId: user, role: 'admin' });
      });
    }
    // A child of A with nothing ticked (PERM-6): the second walk runs as them.
    await tenancy.run({ workspaceId: A, companyIds: [], userId: childA }, async (ctx) => {
      await r.users.create(ctx, { id: childA, email: `${childA}@example.test`, name: 'Child A' });
      await r.memberships.add(ctx, { userId: childA, role: 'member' });
    });
    await tenancy.runWorkspace({ workspaceId: B, userId: userB }, async (ctx) => {
      b.invite = (
        await new InviteRepository(main.db).create(
          ctx,
          {
            email: `${MARKER.toLowerCase()}@example.test`,
            role: 'member',
            tabs: [],
            companyIds: [],
          },
          new Date(),
        )
      ).id;
      b.review = (await new AccessReviewRepository(main.db).ensureDue(ctx, new Date()))?.id ?? '';
      b.erasure = (
        await new ErasureRequestRepository(main.db).create(ctx, {
          id: randomUUID(),
          requestedBy: userB,
          piiRefs: [randomUUID()],
          at: new Date(),
        })
      ).id;
    });
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
    b.account = await tenancy.runWorkspace({ workspaceId: B }, (ctx) =>
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
      deletion: { log: new DeletionLog(main.db), accounts: new ChannelAccountRepository(main.db) },
      jobs: r.jobs,
      files: { store, linkKey },
      ...stubAuth(),
      people: {
        members: new MemberAccessRepository(main.db),
        invites: new InviteRepository(main.db),
        reviews: new AccessReviewRepository(main.db),
        workspaces: r.workspaces,
        store: new AuthStore(main.db),
        notifier: { invite: () => Promise.resolve() },
        audit: new AuditLog(main.db),
        tenancy,
      },
      // T-0404: a stand-in vault that echoes the workspace it was asked about, so a request that
      // reached B's PII would show B's id in its answer.
      privacy: {
        vault: {
          search: (req) =>
            Promise.resolve({
              matches: [
                {
                  pii_ref: randomUUID(),
                  kind: 'buyer_contact' as const,
                  subject_type: 'order',
                  subject_id: req.workspaceId,
                  channel_account_id: null,
                },
              ],
              truncated: false,
            }),
          mask: () => Promise.resolve({ records: [] }),
          readFull: (req) =>
            Promise.resolve({
              pii_ref: req.piiRef,
              kind: 'buyer_contact' as const,
              subject_type: 'order',
              subject_id: req.workspaceId,
              fields: {},
            }),
        },
        erasures: new ErasureRequestRepository(main.db),
        queue: { send: () => Promise.resolve({ id: randomUUID(), created: true }) },
        audit: new AuditLog(main.db),
      },
    });
  };

  /** Walks every route as `caller` (a session of workspace A) against workspace B (AT-1, AT-2). */
  async function walkAgainstB(server: ReturnType<typeof app>, caller: Record<string, string>) {
    // A valid link for B's file, signed for A's own session: only the tenant check can stop it.
    const link = signFileLink({ fileId: b.file, sessionId: 'session-a' }, linkKey);
    return walkIsolation({
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
      workspaceA: caller,
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
        getDeletionCertificate: { params: { id: b.account } },
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
        getSession: {},
        listMyWorkspaces: {},
        chooseWorkspace: { body: { workspaceId: B } },
        enterPlatform: {},
        getTerms: {},
        acceptTerms: { body: { version: '2026-11-15' } },
        changePassword: { body: { currentPassword: MARKER, password: 'a long enough password 1' } },
        signOut: {},
        signOutEverywhere: {},
        // Users (T-0204): B's members, invites and reviews, and a platform route.
        listUsers: {},
        inviteUser: {
          body: { email: 'walker@example.test', role: 'child', tabs: [], companyIds: [b.company] },
        },
        revokeInvite: { params: { inviteId: b.invite } },
        setUserAccess: {
          params: { userId: userB },
          body: { role: 'child', tabs: ['orders'], companyIds: [b.company] },
        },
        removeUser: { params: { userId: userB } },
        listAccessReviews: {},
        completeAccessReview: { params: { reviewId: b.review } },
        inviteFirstAdmin: { params: { workspaceId: B }, body: { email: 'walker@example.test' } },
        getInvite: { params: { token: `${MARKER}-not-a-real-token` } },
        acceptInvite: {
          body: {
            token: `${MARKER}-not-a-real-token`,
            name: MARKER,
            password: 'a long enough password 1',
          },
        },
        // Erasure and access requests (T-0404): B's request cannot be confirmed from A.
        createErasureRequest: {
          body: { identifiers: { email: 'walker@example.test' } },
          searchText: true,
        },
        listErasureRequests: {},
        confirmErasureRequest: { params: { id: b.erasure } },
        // T-0408: nor withdrawn from A.
        withdrawErasureRequest: { params: { id: b.erasure }, body: { reason: 'other' } },
        exportSubjectAccess: {
          body: { identifiers: { email: 'walker@example.test' } },
          searchText: true,
        },
        // eBay webhook (T-0602): unconfigured here, so it answers 503 or 401 and leaks nothing.
        ebayAccountDeletionChallenge: { query: { challenge_code: MARKER } },
        ebayAccountDeletion: {
          body: { metadata: { topic: MARKER }, notification: { userId: userB } },
        },
      },
      markers: [MARKER, B, b.company, b.job, b.file, b.invite, b.review, b.erasure, userB],
    });
  }

  it('[TEN-1][AT-1] route walker: no cross-workspace read or write on any route', async () => {
    const server = app();
    const sessionA = sessionHeaders({ workspaceId: A, userId: userA, sessionId: 'session-a' });
    const workspacesBefore = (await platformPool.query('SELECT id FROM app.workspaces')).rowCount;
    const before = await snapshotB();

    const outcomes = await walkAgainstB(server, sessionA);

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

  it('[TEN-1][AT-2] route walker re-run as a child with no ticks: nothing of B, nothing written', async () => {
    const server = app();
    const child = sessionHeaders({ workspaceId: A, userId: childA, sessionId: 'session-child' });
    const before = await snapshotB();
    const outcomes = await walkAgainstB(server, child);
    expect(new Set(outcomes.map((o) => o.route))).toEqual(new Set(contractRoutes.map((r) => r.id)));
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);
    expect(await snapshotB()).toBe(before);
    // And of A, a child with nothing ticked sees no company at all (PERM-6, invariant 4).
    const companies = await server.inject({ method: 'GET', url: '/api/companies', headers: child });
    expect(companies.json()).toEqual({ items: [] });
    await server.close();
  });

  it('[TEN-1] the walked routes work for their own workspace and for a platform admin', async () => {
    // Positive controls, so the walker cannot pass because every call fails.
    const server = app();
    const sessionA = sessionHeaders({ workspaceId: A, userId: userA, sessionId: 'session-a' });
    const own = await server.inject({
      method: 'GET',
      url: `/api/jobs/${a.job}`,
      headers: sessionA,
    });
    expect(own.statusCode).toBe(200);
    const list = await server.inject({ method: 'GET', url: '/api/companies', headers: sessionA });
    expect(list.json()).toEqual({ items: [expect.objectContaining({ id: a.company })] });

    const created = await server.inject({
      method: 'POST',
      url: '/api/platform/workspaces',
      headers: platformHeaders(admin),
      payload: { name: 'Created by platform' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    const company = await server.inject({
      method: 'POST',
      url: `/api/platform/workspaces/${id}/companies`,
      headers: platformHeaders(admin),
      payload: { legal_name: 'New Ltd', trading_name: 'New', registered_address: address },
    });
    expect(company.statusCode).toBe(201);
    const missing = await server.inject({
      method: 'POST',
      url: `/api/platform/workspaces/${randomUUID()}/companies`,
      headers: platformHeaders(admin),
      payload: { legal_name: 'Nowhere Ltd', trading_name: 'Nowhere', registered_address: address },
    });
    expect(missing.statusCode).toBe(404);
    // The platform answer carries ids only, never the workspace's business data (PLAT-3).
    expect(Object.keys(company.json<object>())).toEqual(['id']);
    await server.close();
  });
});
