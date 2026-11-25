import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractRoutes } from '@omnibridge/contract';
import { checkRaise, Notifier, pence, type TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  AccessReviewRepository,
  CatalogueRepository,
  OrderIngest,
  OrderReads,
  StockEngine,
  AccountCredentials,
  AppSecretStore,
  ConnectionRepository,
  CredentialRepository,
  OAuthStateRepository,
  AuditLog,
  AuthStore,
  BulkConfirmationRepository,
  ChannelAccountRepository,
  DeletionLog,
  ErasureRequestRepository,
  CompanyRepository,
  NotificationRepository,
  createMainDb,
  FileRepository,
  InviteRepository,
  JobRecordRepository,
  MemberAccessRepository,
  MembershipRepository,
  migrateMain,
  PlatformConsole,
  PlatformKeys,
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
  walkPlatform,
  type RoleCluster,
} from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
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
    notification: '',
  };
  const a = { company: '', job: '', sku: randomUUID() };
  // M08: B's Master SKU and listing, seeded in beforeAll (T-0801).
  const catalogueB: { sku: string; listing: string } = { sku: randomUUID(), listing: randomUUID() };
  // M10: B's two orders of one buyer, in one same-buyer group (T-1002).
  const ordersB = { first: '', second: '', group: '' };
  const TODAY = '2026-11-21';

  /** A stock write in the walk would be a write to B: the queue refuses it. */
  const stockEngine = () =>
    new StockEngine(main.db, {
      pushes: { enqueue: () => Promise.reject(new Error('a stock write in the isolation walk')) },
      notifier: new Notifier({ store: new NotificationRepository(main.db) }),
    });
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
      return JSON.stringify(
        {
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
          notifications: await new NotificationRepository(main.db).list(
            ctx,
            { userId: userB, tabs: 'all' },
            {},
            { limit: 200 },
          ),
          // M08: the catalogue is workspace-shared, so all of it is B's.
          skus: await new CatalogueRepository(main.db).listSkus(
            ctx,
            { offset: 0, limit: 100 },
            TODAY,
            1000,
          ),
          sku: await new CatalogueRepository(main.db).getSku(ctx, catalogueB.sku, TODAY),
          listings: await new CatalogueRepository(main.db).listListings(
            ctx,
            { offset: 0, limit: 100 },
            1000,
          ),
          vatRates: await new CatalogueRepository(main.db).vatRates(ctx),
          // M09: B's stock, change log and buffers.
          stock: await stockEngine().listStock(ctx, { offset: 0, limit: 100 }, 1000),
          stockDetail: await stockEngine().getStock(ctx, catalogueB.sku),
          movements: await stockEngine().listMovements(ctx, { offset: 0, limit: 100 }, 1000),
          buffers: await stockEngine().buffers(ctx),
          // M10: B's orders (notes, status), returns and group.
          orders: await new OrderReads(main.db).list(ctx, {}, { offset: 0, limit: 100 }, 1000),
          order: await new OrderReads(main.db).detail(ctx, ordersB.first),
          group: await new OrderReads(main.db).group(ctx, ordersB.group),
        },
        // Pence are bigint; the snapshot only needs them as text.
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
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
    // T-0501: a notification of B, on a record of B's company.
    b.notification = await tenancy.runWorkspace({ workspaceId: B }, async (ctx) => {
      const id = randomUUID();
      await new NotificationRepository(main.db).raise(
        ctx,
        checkRaise({ type: 'reminders.due', record: { kind: 'reminder', id } }, 'workspace'),
        new Date(),
      );
      return (
        (
          await new NotificationRepository(main.db).list(
            ctx,
            { userId: userB, tabs: 'all' },
            {},
            { limit: 1 },
          )
        ).items[0]?.id ?? ''
      );
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
    // M08: B's Master SKU with a COGS, and a listing of B's account mapped to it.
    await tenancy.runWorkspace({ workspaceId: B }, async (ctx) => {
      const catalogue = new CatalogueRepository(main.db);
      await catalogue.createSku(
        ctx,
        {
          id: catalogueB.sku,
          sku: `${MARKER}-SKU`,
          title: `${MARKER} product`,
          shortDescription: MARKER,
          weightG: 100,
          manufacturer: `${MARKER} maker`,
          vatType: 'standard',
          firstCogs: { cogsPence: pence(123n), effectiveFrom: '2026-01-01' },
        },
        null,
        new Date(),
      );
      await catalogue.upsertDiscovered(
        ctx,
        b.account,
        'ebay',
        [
          {
            externalSku: `${MARKER}-SKU`,
            externalId: `${MARKER}-item`,
            title: MARKER,
            fulfilment: null,
            inventoryApi: true,
            quantity: 3,
          },
        ],
        new Date(),
      );
      const found = await catalogue.listListings(ctx, { offset: 0, limit: 1 }, 10);
      catalogueB.listing = found.items[0]?.id ?? catalogueB.listing;
    });
    // M10: two orders of one buyer on B's account, grouped (the vault's match is stood in for).
    await tenancy.runWorkspace({ workspaceId: B }, async (ctx) => {
      const ingest = new OrderIngest(main.db, {
        catalogue: new CatalogueRepository(main.db),
        ports: {
          cancelPii: () => Promise.resolve(),
          shortenPii: () => Promise.resolve(),
          totalMismatch: () => Promise.resolve(),
          lateMapped: () => Promise.resolve(),
          regroup: () => Promise.resolve(),
        },
      });
      const order = (ref: string, at: string) => ({
        externalId: ref,
        rawStatus: 'NOT_STARTED/PAID',
        state: 'awaiting_dispatch' as const,
        updatedAt: new Date(at),
        placedAt: new Date(at),
        paidAt: new Date(at),
        shipBy: null,
        dispatchedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        discount: pence(0n),
        shipping: pence(0n),
        channelTotal: null,
        shipToCountry: 'GB',
        fba: false,
        lines: [
          {
            lineId: 'L1',
            sku: `${MARKER}-SKU`,
            quantity: 1,
            title: MARKER,
            linePrice: pence(1000n),
          },
        ],
        refunds: [
          { refundId: `${MARKER}-R`, refundedAt: new Date(at), amount: pence(100n), lines: null },
        ],
        pii: { kind: 'stored' as const, piiRef: randomUUID() },
      });
      await ingest.apply(ctx, b.account, [
        order(`${MARKER}-ORD-1`, '2026-11-21T10:00:00Z'),
        order(`${MARKER}-ORD-2`, '2026-11-21T11:00:00Z'),
      ]);
      const reads = new OrderReads(main.db);
      const listed = await reads.list(ctx, {}, { offset: 0, limit: 10 }, 10);
      const subjects = listed.items.map((r) => `${b.account}:${r.orderRef}`);
      await reads.applyGroups(ctx, b.account, new Map(subjects.map((s) => [s, 'one-buyer'])));
      const grouped = await reads.list(ctx, {}, { offset: 0, limit: 10 }, 10);
      ordersB.first = grouped.items[0]?.id ?? '';
      ordersB.second = grouped.items[1]?.id ?? '';
      ordersB.group = grouped.items[0]?.group?.id ?? '';
    });
    await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      new CatalogueRepository(main.db).createSku(
        ctx,
        {
          id: a.sku,
          sku: 'A-OWN-1',
          title: 'Own product',
          shortDescription: 'Own',
          weightG: 1,
          vatType: 'reduced',
        },
        null,
        new Date(),
      ),
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
    // T-0504: the console's own checks read the admin flag and MFA from the database.
    const su = new pg.Client({ connectionString: cluster.container.getConnectionUri() });
    await su.connect();
    try {
      await su.query(
        `INSERT INTO app.users (id, email, name, platform_admin)
         VALUES ($1, $2, 'Platform admin', true)`,
        [admin, `${admin}@example.test`],
      );
      await su.query(
        `INSERT INTO app.user_auth (user_id, password_hash, password_set_at, totp_secret,
                                    totp_key_version, mfa_confirmed_at)
         VALUES ($1, '$argon2id$synthetic', now(), '\\x00', 1, now())`,
        [admin],
      );
      // PLAT-2: a usage row of B's account (M07 writes these): the console shows its ids only.
      await su.query(
        `INSERT INTO app.api_usage_daily (workspace_id, channel_account_id, provider, api, day,
                                          calls, cap, updated_at)
         VALUES ($1, $2, 'ebay', 'sell.fulfillment', current_date, 12, 5000, now())`,
        [B, b.account],
      );
    } finally {
      await su.end();
    }
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
      notifications: { notifications: new NotificationRepository(main.db) },
      // T-0701: Connections and the OAuth return, with a stand-in for the provider exchange.
      connections: {
        connections: new ConnectionRepository(main.db),
        oauth: {
          flows: {
            consent: () => Promise.resolve('http://provider-mocks:8080/ebay/oauth2/authorize'),
            exchange: () => Promise.reject(new Error('no provider in this test')),
          },
          states: new OAuthStateRepository(main.db),
          credentials: new AccountCredentials(
            main.db,
            new CredentialRepository({
              keyring: parseKeyring('secrets', generateKekLine(1)),
              logger,
            }),
          ),
          tenancy,
          audit: new AuditLog(main.db),
          notifier: new Notifier({ store: new NotificationRepository(main.db) }),
          appOrigin: 'https://app.omnibridge.test',
        },
        // T-0702: a registered bulk action, so the walk reaches the account-scope check (SAFE-1).
        bulk: {
          confirmations: new BulkConfirmationRepository(main.db),
          actions: {
            stock_push: {
              tab: 'stock-catalogue',
              params: z.object({}).strict(),
              run: () => Promise.reject(new Error('a bulk write ran in the isolation walk')),
            },
          },
        },
        logger,
      },
      // T-0801: the catalogue. A mapping change in the walk would be a write to B: it fails.
      catalogue: {
        catalogue: new CatalogueRepository(main.db),
        audit: new AuditLog(main.db),
        mappingChanged: () => Promise.reject(new Error('a mapping changed in the isolation walk')),
      },
      // T-0901: the stock engine.
      stock: {
        engine: stockEngine(),
        catalogue: new CatalogueRepository(main.db),
        audit: new AuditLog(main.db),
      },
      // T-1002: orders. The stand-in vault masks nothing and refuses a full read: reaching it
      // with B's order would be the leak this walk looks for.
      orders: {
        reads: new OrderReads(main.db),
        vault: {
          mask: () => Promise.resolve({ records: [] }),
          readFull: () => Promise.reject(new Error('a full read in the isolation walk')),
          search: () => Promise.resolve({ matches: [], truncated: false }),
        },
        audit: new AuditLog(main.db),
      },
      // T-0504: the console, with a stand-in queue that holds one dead job of B's.
      platform: {
        console: new PlatformConsole(main.db),
        secrets: new AppSecretStore(
          main.db,
          new PlatformKeys(new AuthStore(main.db), parseKeyring('secrets', generateKekLine(1))),
        ),
        jobs: {
          overview: () =>
            Promise.resolve([
              { type: 'orders.export', queued: 1, active: 0, failed: 1, deadLetter: 1 },
            ]),
          deadLetters: () =>
            Promise.resolve([
              {
                id: b.job,
                type: 'orders.export',
                workspaceId: B,
                idempotencyKey: `${MARKER}-export`,
                deadLetteredAt: new Date(),
              },
            ]),
          redrive: () => Promise.resolve({ outcome: 'ok' as const, workspaceId: B }),
          lastHeartbeat: () => Promise.resolve(new Date()),
        },
        queue: { send: () => Promise.resolve({ id: randomUUID(), created: true }) },
        audit: new AuditLog(main.db),
        tenancy,
        checks,
        version: '0',
        logger,
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
        // T-0410 (A-006): nor retried from A.
        retryErasureRequest: { params: { id: b.erasure } },
        exportSubjectAccess: {
          body: { identifiers: { email: 'walker@example.test' } },
          searchText: true,
        },
        // Notifications (T-0501): only A's own come back; B's cannot be marked from A.
        listNotifications: {},
        countUnreadNotifications: {},
        markNotificationRead: { params: { id: b.notification } },
        markAllNotificationsRead: {},
        // Platform notices: a workspace session is refused.
        listPlatformNotifications: {},
        countUnreadPlatformNotifications: {},
        markPlatformNotificationRead: { params: { id: b.notification } },
        markAllPlatformNotificationsRead: {},
        // T-0502: a user's own email choices only.
        getEmailPreferences: {},
        // The body is a type code, no id of B's, so it cannot aim at B (any status; the snapshot
        // of B and the leak check still apply).
        setEmailPreferences: {
          body: { items: [{ type: 'reminders.due', email: true }] },
          searchText: true,
        },
        // The platform console (T-0504): a workspace session is refused on every route.
        listConsoleWorkspaces: {},
        suspendWorkspace: { params: { workspaceId: B } },
        reactivateWorkspace: { params: { workspaceId: B } },
        archiveWorkspace: { params: { workspaceId: B } },
        setWorkspaceModules: { params: { workspaceId: B }, body: { website_connector: true } },
        getPlatformFlags: {},
        setPlatformFlags: { body: { public_signup: false } },
        getQueueOverview: {},
        listDeadLetters: {},
        redriveDeadLetter: { params: { type: 'orders.export', id: b.job } },
        listApiUsage: {},
        listCredentialExpiry: {},
        getPlatformHealth: {},
        getIncidentBanner: {},
        setIncidentBanner: { body: { message: 'Walker banner', severity: 'info' } },
        clearIncidentBanner: {},
        listAppSecrets: {},
        setAppSecret: {
          params: { name: 'ads.client_id', slot: 'current' },
          body: { value: 'walker-value' },
        },
        promoteAppSecret: { params: { name: 'ads.client_id' } },
        getMaintenance: {},
        setMaintenance: { body: { maintenance: false } },
        getLiveApiUsage: {},
        // Connections (M07): B's account cannot be read, paused or authorised from A.
        listConnections: {},
        getConnection: { params: { accountId: b.account } },
        setKillSwitch: { params: { accountId: b.account }, body: { paused: true } },
        startAuthorisation: { params: { accountId: b.account } },
        // Public: the state names nothing of B's; any status, the leak check still runs.
        oauthCallback: { params: { provider: 'ebay' }, query: { state: MARKER, code: MARKER } },
        // SAFE-1: a bulk write cannot name B's account, nor use a token A never got.
        previewBulkWrite: {
          body: { action: 'stock_push', channel_account_ids: [b.account, randomUUID()] },
        },
        confirmBulkWrite: { body: { token: `${MARKER}-not-a-real-bulk-token` } },
        // Catalogue (M08): workspace-shared, so A reads only its own; B's SKUs and listings are
        // neither read nor changed from A (T-0801 seeds B's rows; until then the routes are 404).
        listMasterSkus: {},
        getMasterSku: { params: { skuId: catalogueB.sku } },
        createMasterSku: {
          body: {
            sku: `${MARKER}-bundle`,
            title: 'Walker bundle',
            short_description: 'Walker bundle',
            weight_g: 100,
            bundle: { component_id: catalogueB.sku, pack_size: 2 },
          },
        },
        updateMasterSku: { params: { skuId: catalogueB.sku }, body: { title: MARKER } },
        listManufacturers: {},
        listVatRates: {},
        createVatRate: {
          body: { vat_type: 'standard', rate_bp: 2000, effective_from: '2030-01-01' },
          searchText: true,
        },
        listCogs: { params: { skuId: catalogueB.sku } },
        setCogs: {
          params: { skuId: catalogueB.sku },
          body: { cogs_pence: 100, effective_from: '2026-01-01' },
        },
        importCogs: {
          body: {
            csv: `sku,cogs,effective_from
${MARKER},1.00,2026-01-01`,
            dry_run: true,
          },
          searchText: true,
        },
        listListings: {},
        mapListing: {
          params: { listingId: catalogueB.listing },
          body: { master_sku_id: catalogueB.sku },
        },
        unmapListing: { params: { listingId: catalogueB.listing } },
        importMappings: {
          body: {
            csv: `listing_id,sku
${catalogueB.listing},${MARKER}`,
            dry_run: true,
          },
          searchText: true,
        },
        exportMappings: {},
        // Stock (M09): workspace-shared like the catalogue. B's SKU, listing and account are
        // neither read nor moved from A (T-0901 builds the routes; until then they are 404).
        listStock: {},
        getStock: { params: { skuId: catalogueB.sku } },
        listMovements: { query: { sku_id: catalogueB.sku } },
        exportMovements: { query: { sku_id: catalogueB.sku } },
        stockIn: {
          params: { skuId: catalogueB.sku },
          body: { quantity: 5, notes: MARKER, client_ref: randomUUID() },
        },
        adjustStock: {
          params: { skuId: catalogueB.sku },
          body: { delta: -1, reason: 'other', text: MARKER, client_ref: randomUUID() },
        },
        importStockTake: {
          body: {
            csv: `sku,on_hand
${MARKER}-SKU,99`,
            dry_run: true,
          },
          searchText: true,
        },
        listBuffers: {},
        setAccountBuffer: { params: { accountId: b.account }, body: { buffer: 3 } },
        setListingBuffer: { params: { listingId: catalogueB.listing }, body: { buffer: 2 } },
        saveAllocation: {
          params: { skuId: catalogueB.sku },
          body: {
            version: 0,
            listings: [{ listing_id: catalogueB.listing, mode: 'manual', manual_qty: 1 }],
          },
        },
        backToAuto: { params: { skuId: catalogueB.sku }, body: {} },
        // Orders (M10): company-scoped. B's account, orders and group are never read or changed
        // from A: a filter on B's account is a 404, never an empty list.
        listOrders: { query: { channel_account_id: b.account } },
        searchOrders: { query: { channel_account_id: b.account }, body: { buyer_name: MARKER } },
        exportOrders: { query: { channel_account_id: b.account } },
        getOrder: { params: { orderId: ordersB.first } },
        viewOrderCustomer: { params: { orderId: ordersB.first } },
        setOrderNotes: { params: { orderId: ordersB.first }, body: { notes: MARKER } },
        listReturns: { query: { channel_account_id: b.account } },
        dismissOrderGroup: { params: { groupId: ordersB.group }, body: { reason: MARKER } },
        removeOrderGroupMember: {
          params: { groupId: ordersB.group, orderId: ordersB.second },
          body: { reason: MARKER },
        },
        // eBay webhook (T-0602): unconfigured here, so it answers 503 or 401 and leaks nothing.
        ebayAccountDeletionChallenge: { query: { challenge_code: MARKER } },
        ebayAccountDeletion: {
          body: { metadata: { topic: MARKER }, notification: { userId: userB } },
        },
      },
      markers: [
        MARKER,
        B,
        b.company,
        b.job,
        b.file,
        b.invite,
        b.review,
        b.erasure,
        b.notification,
        userB,
        catalogueB.sku,
        catalogueB.listing,
      ],
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
    // T-0801: A's own Master SKU answers 200, and A's catalogue list holds only it.
    const sku = await server.inject({
      method: 'GET',
      url: `/api/catalogue/skus/${a.sku}`,
      headers: sessionA,
    });
    expect(sku.statusCode).toBe(200);
    const skus = await server.inject({
      method: 'GET',
      url: '/api/catalogue/skus',
      headers: sessionA,
    });
    expect(skus.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([a.sku]);

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
  // Last: it suspends and archives B through the console.
  it('[PLAT-3] no platform route returns tenant business data, even aimed at another workspace', async () => {
    const server = app();
    const outcomes = await walkPlatform({
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
      platform: platformHeaders(admin),
      calls: {
        createWorkspace: { body: { name: 'Walker workspace' } },
        createCompany: {
          params: { workspaceId: B },
          body: { legal_name: 'Walker Ltd', trading_name: 'Walker', registered_address: address },
        },
        inviteFirstAdmin: { params: { workspaceId: B }, body: { email: 'walker@example.test' } },
        listPlatformNotifications: {},
        countUnreadPlatformNotifications: {},
        markPlatformNotificationRead: { params: { id: b.notification } },
        markAllPlatformNotificationsRead: {},
        listConsoleWorkspaces: {},
        getPlatformFlags: {},
        setPlatformFlags: { body: { public_signup: false } },
        getQueueOverview: {},
        listDeadLetters: {},
        redriveDeadLetter: { params: { type: 'orders.export', id: b.job } },
        listApiUsage: {},
        listCredentialExpiry: {},
        getPlatformHealth: {},
        getIncidentBanner: {},
        setIncidentBanner: { body: { message: 'Walker banner', severity: 'info' } },
        clearIncidentBanner: {},
        setWorkspaceModules: { params: { workspaceId: B }, body: { website_connector: true } },
        listAppSecrets: {},
        setAppSecret: {
          params: { name: 'ads.client_id', slot: 'next' },
          body: { value: 'walker-value' },
        },
        promoteAppSecret: { params: { name: 'ads.client_id' } },
        getMaintenance: {},
        setMaintenance: { body: { maintenance: false } },
        getLiveApiUsage: {},
        suspendWorkspace: { params: { workspaceId: B } },
        reactivateWorkspace: { params: { workspaceId: B } },
        archiveWorkspace: { params: { workspaceId: B } },
      },
      // The calls meant to be refused (ADR-076); every other platform route must answer a 2xx.
      expected: {
        // B already has an admin: an operator cannot make themselves a member of a live tenant.
        inviteFirstAdmin: [409],
        // The id is B's own workspace notification, not a platform notice.
        markPlatformNotificationRead: [404],
        // The walk archives B before this route (contract order), and archive is final.
        setWorkspaceModules: [409],
      },
      // B's business data. Its workspace name and IDs may appear: the console lists workspaces,
      // and usage, expiry and dead-letter rows name accounts and jobs by ID (PLAT-2).
      businessMarkers: [
        `${MARKER} Ltd`,
        `${MARKER} ebay`,
        `${MARKER}-${userB}`,
        `${MARKER} reason`,
        `${MARKER}-export`,
        `${MARKER.toLowerCase()}@example.test`,
        `${userB}@example.test`,
        b.company,
        b.invite,
        b.review,
        b.erasure,
        b.file,
        userB,
      ],
    });
    expect(new Set(outcomes.map((o) => o.route))).toEqual(
      new Set(contractRoutes.filter((r) => r.auth === 'platform').map((r) => r.id)),
    );
    expect(outcomes.filter((o) => !o.ok)).toEqual([]);

    // Positive controls: the console did see B, as a name, ids and counts.
    const list = await server.inject({
      method: 'GET',
      url: '/api/platform/workspaces',
      headers: platformHeaders(admin),
    });
    const row = list
      .json<{ items: { id: string; counts: object; status: string }[] }>()
      .items.find((w) => w.id === B);
    expect(row).toMatchObject({
      status: 'archived',
      counts: { users: 1, channel_accounts: 1, orders_per_day: null },
    });
    const usage = await server.inject({
      method: 'GET',
      url: '/api/platform/api-usage',
      headers: platformHeaders(admin),
    });
    expect(usage.json()).toEqual({
      items: [
        expect.objectContaining({ workspace_id: B, channel_account_id: b.account, calls: 12 }),
      ],
    });
    const dead = await server.inject({
      method: 'GET',
      url: '/api/platform/jobs/dead-letters',
      headers: platformHeaders(admin),
    });
    const deadItems = dead.json<{ items: Record<string, unknown>[] }>().items;
    expect(deadItems).toHaveLength(1);
    expect(deadItems[0]).toMatchObject({
      id: b.job,
      type: 'orders.export',
      workspace_id: B,
      attempt: 0,
      error_code: null,
    });
    expect(Object.keys(deadItems[0] ?? {}).sort()).toEqual(
      ['attempt', 'dead_lettered_at', 'error_code', 'id', 'type', 'workspace_id'].sort(),
    );
    await server.close();
  });
});
