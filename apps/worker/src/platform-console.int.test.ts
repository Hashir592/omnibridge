import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  createMainDb,
  MembershipRepository,
  migrateMain,
  PlatformHousekeeping,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import type { Email } from '@omnibridge/mail';
import type { JobQueue } from '@omnibridge/queue';
import {
  PII_MARKER,
  scanTextForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  notifyRetentionHandler,
  sendPlatformDigest,
  workspaceCloseHandler,
} from './platform-console.ts';

// T-0504: the console's worker jobs, as ob_worker: notification retention (ADR-071 4a), workspace
// closure (PLAT-2, DEL-1) and the daily health digest (OPS-6).

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const APP = 'https://app.omnibridge.test';
const DAY = 86_400_000;
const NOW = new Date('2026-11-20T07:00:00Z');

describe('platform console jobs (PLAT-2, OPS-6)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  let housekeeping: PlatformHousekeeping;
  const W = randomUUID();

  /** Runs a workspace job handler the way JobQueue does: in the workspace's one transaction. */
  const runJob = <R>(
    workspaceId: string,
    handler: (job: { ctx: TenantContext }) => Promise<R>,
  ): Promise<R> => tenancy.runWorkspace({ workspaceId }, (ctx) => handler({ ctx }));

  async function workspace(id: string, name: string) {
    await tenancy.run({ workspaceId: id, companyIds: [] }, (ctx) =>
      new WorkspaceRepository(main.db).create(ctx, { name }),
    );
  }

  /** A user who is an admin of `workspaces`, with accepted terms. */
  async function person(workspaces: readonly string[], name = 'Robin Tester') {
    const id = randomUUID();
    for (const [i, ws] of workspaces.entries()) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: id }, async (ctx) => {
        if (i === 0) {
          await new UserRepository(main.db).create(ctx, {
            id,
            email: `u${id.slice(0, 8)}@example.test`,
            name,
          });
        }
        await new MembershipRepository(main.db).add(ctx, { userId: id, role: 'admin' });
      });
    }
    await root.query(
      `INSERT INTO app.terms_acceptances (user_id, version, accepted_at) VALUES ($1, '2026-11-15', now())`,
      [id],
    );
    return id;
  }

  const count = async (text: string, values: unknown[]) =>
    Number((await root.query<{ n: string }>(text, values)).rows[0]?.n ?? '0');

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    main = createMainDb({ ...cluster.connection('ob_worker'), max: 4 });
    tenancy = new Tenancy(main.db);
    housekeeping = new PlatformHousekeeping(main.db);
    await workspace(W, `${PII_MARKER}workspace name`);
  });

  afterAll(async () => {
    await root.end();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[PLAT-2] retention hard-deletes notifications resolved over 90 days ago, with their read and email rows', async () => {
    const user = await person([W]);
    const notice = async (resolvedDaysAgo: number | null) => {
      const id = randomUUID();
      const resolved =
        resolvedDaysAgo === null ? null : new Date(NOW.getTime() - resolvedDaysAgo * DAY);
      await root.query(
        `INSERT INTO app.notifications (workspace_id, id, type, severity, tab, record_kind,
                                        record_id, created_at, updated_at, resolved_at)
         VALUES ($1, $2::uuid, 'reminders.due', 'info', 'reminders', 'reminder', $2::text, $3, $3, $4)`,
        [W, id, new Date(NOW.getTime() - 200 * DAY), resolved],
      );
      await root.query(
        `INSERT INTO app.notification_reads (workspace_id, notification_id, user_id, version, read_at)
         VALUES ($1, $2, $3, 1, now())`,
        [W, id, user],
      );
      await root.query(
        `INSERT INTO app.notification_emails (workspace_id, notification_id, user_id, version, sent_at)
         VALUES ($1, $2, $3, 1, now())`,
        [W, id, user],
      );
      return id;
    };
    const old = await notice(91);
    const recent = await notice(89);
    const open = await notice(null);

    const result = await runJob(
      W,
      notifyRetentionHandler({ housekeeping, logger, now: () => NOW }) as unknown as (job: {
        ctx: TenantContext;
      }) => Promise<unknown>,
    );
    expect(result).toEqual({ deleted: 1 });
    const left = (
      await root.query<{ id: string }>('SELECT id FROM app.notifications WHERE workspace_id = $1', [
        W,
      ])
    ).rows.map((r) => r.id);
    expect(left.sort()).toEqual([recent, open].sort());
    for (const table of ['notification_reads', 'notification_emails']) {
      expect(
        await count(`SELECT count(*) AS n FROM app.${table} WHERE notification_id = $1`, [old]),
      ).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM app.${table} WHERE notification_id = $1`, [recent]),
      ).toBe(1);
    }

    // Platform notices (no workspace) the same way.
    const platform = async (resolvedDaysAgo: number | null) => {
      const id = randomUUID();
      await root.query(
        `INSERT INTO app.platform_notifications (id, type, severity, record_kind, record_id,
                                                 created_at, updated_at, resolved_at)
         VALUES ($1::uuid, 'security.canary_read', 'critical', 'workspace', $1::text, $2, $2, $3)`,
        [
          id,
          new Date(NOW.getTime() - 200 * DAY),
          resolvedDaysAgo === null ? null : new Date(NOW.getTime() - resolvedDaysAgo * DAY),
        ],
      );
      return id;
    };
    const oldPlatform = await platform(91);
    await platform(89);
    await platform(null);
    expect(await housekeeping.purgePlatformNotices(new Date(NOW.getTime() - 90 * DAY))).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM app.platform_notifications WHERE id = $1', [
        oldPlatform,
      ]),
    ).toBe(0);
  });

  it('[PLAT-2][DEL-1] closing an archived workspace queues the closure deletion, removes members and deletes the terms of people left with none', async () => {
    const closing = randomUUID();
    await workspace(closing, 'Closing');
    const onlyHere = await person([closing]);
    const alsoElsewhere = await person([closing, W]);
    const sent: { type: string; key: string; payload: unknown; workspaceId: string }[] = [];
    const queue: Pick<JobQueue, 'send'> = {
      send: (def, input) => {
        sent.push({
          type: def.type,
          key: input.idempotencyKey,
          payload: input.payload,
          workspaceId: input.ctx.workspaceId,
        });
        return Promise.resolve({ id: randomUUID(), created: true });
      },
    };
    const handler = workspaceCloseHandler({ queue, housekeeping, logger }) as unknown as (job: {
      ctx: TenantContext;
    }) => Promise<unknown>;

    // Only an archived workspace is closed: a live one keeps its members (and its last admin).
    await expect(runJob(closing, handler)).rejects.toThrow(/archived/);
    expect(
      await count('SELECT count(*) AS n FROM app.memberships WHERE workspace_id = $1', [closing]),
    ).toBe(2);

    // PERM-7 still holds for a live workspace, even with the closing setting on.
    const client = await root.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.closing_workspace', $1, true)`, [closing]);
      await expect(
        client.query('DELETE FROM app.memberships WHERE workspace_id = $1', [closing]),
      ).rejects.toThrow(/last admin/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    await root.query(`UPDATE app.workspaces SET status = 'archived' WHERE id = $1`, [closing]);
    sent.length = 0;
    expect(await runJob(closing, handler)).toEqual({ members_removed: 2, terms_deleted: 1 });
    expect(sent).toEqual([
      {
        type: 'pii.delete',
        key: `workspace_closure:closure:${closing}`,
        payload: { trigger: 'workspace_closure', scope: { type: 'workspace' } },
        workspaceId: closing,
      },
    ]);
    expect(
      await count('SELECT count(*) AS n FROM app.memberships WHERE workspace_id = $1', [closing]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM app.terms_acceptances WHERE user_id = $1', [onlyHere]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM app.terms_acceptances WHERE user_id = $1', [
        alsoElsewhere,
      ]),
    ).toBe(1);
    expect(
      await count('SELECT count(*) AS n FROM app.memberships WHERE user_id = $1', [alsoElsewhere]),
    ).toBe(1);

    // A retry repeats nothing: nobody is left to remove.
    expect(await runJob(closing, handler)).toEqual({ members_removed: 0, terms_deleted: 0 });
  });

  it('[OPS-6] the daily digest goes once a day to each platform admin, with counts only', async () => {
    const op1 = await person([W]);
    const op2 = await person([W]);
    await root.query('UPDATE app.users SET platform_admin = true WHERE id = ANY($1)', [[op1, op2]]);
    // Something to count: a failed job of W, a deletion run, an expiring credential is absent.
    await root.query(
      `INSERT INTO app.job_records (id, workspace_id, type, idempotency_key, state, error_code,
                                    updated_at)
       VALUES ($1, $2, 'orders.export', $3, 'failed', 'handler_failed', $4)`,
      [randomUUID(), W, `${PII_MARKER}key`, new Date(NOW.getTime() - 3_600_000)],
    );
    await root.query(
      `INSERT INTO app.deletion_runs (workspace_id, id, trigger, scope_type, scope, records_deleted,
                                      result, started_at, finished_at)
       VALUES ($1, $2, 'expiry', 'expiry', '{}', 7, 'done', $3, $3)`,
      [W, randomUUID(), new Date(NOW.getTime() - 3_600_000)],
    );
    const mails: { to: string; email: Email }[] = [];
    const mailer = {
      send: (to: string, email: Email) => {
        mails.push({ to, email });
        return Promise.resolve('id');
      },
    };
    const deps = { housekeeping, mailer, appOrigin: APP, logger, now: () => NOW };
    expect(await sendPlatformDigest(deps)).toBe(2);
    expect(mails.map((m) => m.to).sort()).toEqual(
      [`u${op1.slice(0, 8)}@example.test`, `u${op2.slice(0, 8)}@example.test`].sort(),
    );
    const text = mails[0]?.email.text ?? '';
    expect(text).toContain('Jobs failed (last 24 hours): 1');
    expect(text).toContain('Deletion runs (last 24 hours): 1 (7 records deleted)');
    expect(text).toContain('Credentials expiring in 30 days: 0');
    expect(text).toContain('API calls today: 0 (no limits recorded)');
    expect(text).toContain(`${APP}/platform`);
    // Counts only: no workspace name, job key or other record reaches the mail.
    const everything = mails.flatMap((m) => [m.email.subject, m.email.text, m.email.html]);
    expect(scanTextForMarkers(everything.flatMap((t) => t.split('\n')))).toEqual([]);
    expect(everything.join('\n')).not.toContain('workspace name');
    // Once per admin and London day.
    expect(await sendPlatformDigest(deps)).toBe(0);
    expect(mails).toHaveLength(2);
  });
});
