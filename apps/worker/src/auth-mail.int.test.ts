import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  AuthStore,
  createMainDb,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import type { Email } from '@omnibridge/mail';
import type { RunningJob } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockNoticeHandler, passwordResetHandler } from './auth-mail.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const APP = 'https://app.omnibridge.test';

describe('auth mail jobs (USR-5, USR-7, ADR-050)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let web: MainDbHandle;
  let tenancy: Tenancy;
  const ws = randomUUID();
  const people = { admin: randomUUID(), other: randomUUID(), member: randomUUID() };
  const sent: { to: string; email: Email }[] = [];
  const mailer = {
    send: (to: string, email: Email) => {
      sent.push({ to, email });
      return Promise.resolve(`msg-${String(sent.length)}`);
    },
  };

  /** Runs a handler as the queue does: in the job workspace's tenant transaction. */
  const run = <T>(handler: (job: RunningJob<T>) => Promise<unknown>, payload: T) =>
    tenancy.run({ workspaceId: ws, companyIds: [] }, (ctx: TenantContext) =>
      handler({
        ctx,
        payload,
        attempt: 1,
        envelope: {
          workspace_id: ws,
          idempotency_key: 'k',
          attempt: 0,
          type: 'test',
          payload,
        },
        progress: () => Promise.resolve(),
      }),
    );

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    // The worker's own role (ADR-049).
    main = createMainDb({ ...cluster.connection('ob_worker'), max: 4 });
    // Web (ob_app) is what reads the link back; the worker may only create it (ADR-051).
    web = createMainDb({ ...cluster.connection('ob_app'), max: 1 });
    tenancy = new Tenancy(main.db);
    await tenancy.run({ workspaceId: ws, companyIds: [] }, (ctx) =>
      new WorkspaceRepository(main.db).create(ctx, { name: 'Mail test' }),
    );
    for (const [key, id] of Object.entries(people)) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: id }, async (ctx) => {
        await new UserRepository(main.db).create(ctx, {
          id,
          email: `${key}@example.test`,
          name: `${key[0]?.toUpperCase() ?? ''}${key.slice(1)} Person`,
        });
        await new MembershipRepository(main.db).add(ctx, {
          userId: id,
          role: key === 'member' ? 'member' : 'admin',
        });
      });
    }
  });

  afterAll(async () => {
    await web.destroy();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[USR-5] the lock notice goes to the locked user and to each admin of the workspace, once', async () => {
    sent.length = 0;
    const handler = lockNoticeHandler({
      users: new UserRepository(main.db),
      members: new MembershipRepository(main.db),
      mailer,
      logger,
    });
    // An admin is locked: they hear about it once, as the user, and the other admin is told.
    const result = await run(handler, {
      user_id: people.admin,
      locked_until: '2026-10-21T09:15:00.000Z',
    });
    expect(result).toEqual({ sent: 2 });
    expect(sent.map((s) => s.to).sort()).toEqual(['admin@example.test', 'other@example.test']);
    const own = sent.find((s) => s.to === 'admin@example.test');
    expect(own?.email.subject).toBe('Sign in to your OmniBridge account is locked');
    // London time (BST on 21 October): 10:15.
    expect(own?.email.text).toContain('21/10/2026 10:15');
    const told = sent.find((s) => s.to === 'other@example.test');
    expect(told?.email.subject).toBe('Sign in locked for Admin Person on OmniBridge');
    // A member is locked: the member and both admins.
    sent.length = 0;
    await run(handler, { user_id: people.member, locked_until: '2026-10-21T09:15:00.000Z' });
    expect(sent.map((s) => s.to).sort()).toEqual([
      'admin@example.test',
      'member@example.test',
      'other@example.test',
    ]);
  });

  it('[USR-7] the reset email carries a working 30-minute link; only its hash is stored', async () => {
    sent.length = 0;
    const store = new AuthStore(main.db);
    const now = new Date('2026-10-21T09:00:00.000Z');
    const handler = passwordResetHandler({
      store,
      users: new UserRepository(main.db),
      mailer,
      appOrigin: APP,
      logger,
      now: () => now,
    });
    expect(await run(handler, { user_id: people.member })).toEqual({ sent: 1 });
    const mail = sent[0];
    expect(mail?.to).toBe('member@example.test');
    const link = /https:\/\/app\.omnibridge\.test\/reset-password\?token=([A-Za-z0-9_-]{43})/.exec(
      mail?.email.text ?? '',
    );
    const token = link?.[1] ?? '';
    expect(token).not.toBe('');
    const hash = createHash('sha256').update(token).digest();
    const reader = new AuthStore(web.db);
    expect(await reader.findReset(hash, new Date(now.getTime() + 29 * 60_000))).toMatchObject({
      userId: people.member,
    });
    expect(await reader.findReset(hash, new Date(now.getTime() + 30 * 60_000))).toBeUndefined();
    // The token itself is in no row.
    const owner = new pg.Pool({ ...cluster.connection('ob_owner'), max: 1 });
    try {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.password_resets r
          WHERE r::text LIKE $1 OR encode(r.token_hash, 'escape') LIKE $1`,
        [`%${token}%`],
      );
      expect(rows[0]?.n).toBe('0');
    } finally {
      await owner.end();
    }
  });
});
