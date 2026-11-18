import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  DeletionLog,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const A: TenantContext = { workspaceId: randomUUID(), companyIds: [] };
const B: TenantContext = { workspaceId: randomUUID(), companyIds: [] };
const ADMIN = randomUUID();
const CHILD = randomUUID();

/** Test-only sessions: the workspace and user come from headers. */
const fromHeader = (request: { headers: Record<string, unknown> }) => {
  const ws = request.headers['x-test-workspace'];
  const user = request.headers['x-test-user'];
  return typeof ws === 'string' && typeof user === 'string'
    ? { workspaceId: ws, userId: user, sessionId: 'test-session' }
    : undefined;
};

describe('GET /channel-accounts/:id/deletion-certificate [DEL-3]', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let accountA = '';
  let accountB = '';
  const runId = randomUUID();

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 3 });
    const tenancy = new Tenancy(main.db);
    for (const [ctx, name] of [
      [A, 'Certificate test'],
      [B, 'Certificate test B'],
    ] as const) {
      await tenancy.run(ctx, (c) => new WorkspaceRepository(main.db).create(c, { name }));
    }
    for (const [id, role] of [
      [ADMIN, 'admin'],
      [CHILD, 'member'],
    ] as const) {
      await tenancy.run({ ...A, userId: id }, async (c) => {
        await new UserRepository(main.db).create(c, { id, email: `${id}@example.test`, name: 'U' });
        await new MembershipRepository(main.db).add(c, { userId: id, role });
      });
    }
    // Company rows need the company in scope: runWorkspace scopes the transaction to all of them.
    const account = async (ctx: TenantContext) => {
      // A new company is in scope only from the next transaction.
      const companyId = await tenancy.runWorkspace({ workspaceId: ctx.workspaceId }, (c) =>
        new CompanyRepository(main.db).create(c, {
          legalName: 'Cert Ltd',
          tradingName: 'Cert',
          registeredAddress: { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' },
        }),
      );
      return tenancy.runWorkspace({ workspaceId: ctx.workspaceId }, (c) =>
        new ChannelAccountRepository(main.db).create(c, {
          companyId,
          provider: 'amazon',
          displayName: 'Amazon UK',
        }),
      );
    };
    accountA = await account(A);
    accountB = await account(B);
    await tenancy.run(A, (c) =>
      new DeletionLog(main.db).record(
        c,
        {
          id: runId,
          trigger: 'amazon_revocation',
          scopeType: 'channel_account',
          scope: { type: 'channel_account', channel_account_id: accountA },
          channelAccountId: accountA,
          startedAt: new Date('2026-11-17T09:00:00Z'),
          finishedAt: new Date('2026-11-17T09:00:05Z'),
        },
        [
          { piiRef: randomUUID(), channelAccountId: accountA },
          { piiRef: randomUUID(), channelAccountId: accountA },
        ],
      ),
    );
  }, 300_000);

  afterAll(async () => {
    await main.destroy();
    await cluster.container.stop();
  });

  const get = (id: string, user: string) => {
    const tenancy = new Tenancy(main.db);
    const app = buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      directory: {
        workspaces: new WorkspaceRepository(main.db),
        companies: new CompanyRepository(main.db),
      },
      deletion: { log: new DeletionLog(main.db), accounts: new ChannelAccountRepository(main.db) },
      resolveSession: fromHeader,
    });
    return app.inject({
      method: 'GET',
      url: `/api/channel-accounts/${id}/deletion-certificate`,
      headers: { 'x-test-workspace': A.workspaceId, 'x-test-user': user },
    });
  };

  it('[DEL-3] an admin downloads the certificate: counts, runs and IDs only', async () => {
    const res = await get(accountA, ADMIN);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain(`Channel account: ${accountA} (amazon)`);
    expect(res.body).toContain('Buyer records deleted for this account: 2');
    expect(res.body).toContain(`17/11/2026, 09:00  amazon_revocation  records: 2  run: ${runId}`);
  });

  it('[DEL-3] a child gets 403 and another workspace’s account is 404', async () => {
    expect((await get(accountA, CHILD)).statusCode).toBe(403);
    expect((await get(accountB, ADMIN)).statusCode).toBe(404);
  });
});
