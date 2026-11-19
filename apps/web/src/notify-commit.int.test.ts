import { randomUUID } from 'node:crypto';
import {
  createQueues,
  InviteRepository,
  JobRecordRepository,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDb,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import {
  authInviteJob,
  createQueueClient,
  JobQueue,
  piiDeleteJob,
  requestDeletion,
} from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueNotifier } from './auth/notifier.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });

// A-002 (ADR-069): the auditor's proof was an invite job that the worker ran before the invite
// row committed: the handler found no invite and sent 0 mails, and a rolled-back request still
// left its job. A job sent from a request must go through the request's own transaction, so it
// becomes visible exactly when the request commits, and never if it rolls back.
describe('jobs sent from a request commit with it (A-002)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let tenancy: Tenancy;
  let boss: ReturnType<typeof createQueueClient>;
  let queue: JobQueue;
  let owner: pg.Pool;
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const member = () => ({ workspaceId, companyIds: [], userId });

  /** What another connection (the worker) can see: committed jobs only. */
  const visibleJobs = async (name: string, key: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM pgboss.job WHERE name = $1 AND data->>'idempotency_key' = $2`,
          [name, key],
        )
      ).rows[0]?.n,
    );
  const visibleInvite = async (id: string) =>
    (await owner.query('SELECT 1 FROM app.invites WHERE id = $1', [id])).rowCount === 1;

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    await createQueues(cluster.connection('ob_owner'), [authInviteJob, piiDeleteJob]);
    owner = new pg.Pool({ ...cluster.connection('ob_owner'), max: 1 });
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 4 }),
      }),
    });
    tenancy = new Tenancy(db);
    await tenancy.run(member(), async (c) => {
      await new WorkspaceRepository(db).create(c, { name: 'Commit boundary test' });
      await new UserRepository(db).create(c, {
        id: userId,
        email: `${userId}@example.test`,
        name: 'U',
      });
      await new MembershipRepository(db).add(c, { userId, role: 'admin' });
    });
    boss = createQueueClient(cluster.connection('ob_app'));
    boss.on('error', () => undefined);
    await boss.start();
    queue = new JobQueue({ boss, records: new JobRecordRepository(db), tenancy, logger });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await db.destroy();
    await owner.end();
    await cluster.container.stop();
  });

  it('[TEN-7] an invite job is invisible until the invite commits, and the invite is there when it is', async () => {
    const invites = new InviteRepository(db);
    let inviteId = '';
    let insideTx = -1;
    await tenancy.run(member(), async (tenant) => {
      const invite = await invites.create(
        tenant,
        { email: `${randomUUID()}@example.test`, role: 'member', tabs: [], companyIds: [] },
        new Date(),
      );
      inviteId = invite.id;
      await queueNotifier(queue).invite({ workspaceId, inviteId, within: tenant });
      // The worker polls another connection: before the commit it must find nothing.
      insideTx = await visibleJobs(authInviteJob.type, `invite:${inviteId}`);
    });
    expect(insideTx).toBe(0);
    expect(await visibleJobs(authInviteJob.type, `invite:${inviteId}`)).toBe(1);
    // When the worker can see the job, it can see the invite: the handler has someone to mail.
    expect(await visibleInvite(inviteId)).toBe(true);
  });

  it('[TEN-7] a request that rolls back leaves no invite job', async () => {
    const invites = new InviteRepository(db);
    let inviteId = '';
    await expect(
      tenancy.run(member(), async (tenant) => {
        const invite = await invites.create(
          tenant,
          { email: `${randomUUID()}@example.test`, role: 'member', tabs: [], companyIds: [] },
          new Date(),
        );
        inviteId = invite.id;
        await queueNotifier(queue).invite({ workspaceId, inviteId, within: tenant });
        throw new Error('the request failed after the notify call');
      }),
    ).rejects.toThrow('the request failed');
    expect(await visibleJobs(authInviteJob.type, `invite:${inviteId}`)).toBe(0);
    expect(await visibleInvite(inviteId)).toBe(false);
  });

  it('[DEL-4] a deletion queued from a request is invisible until that request commits', async () => {
    const key = randomUUID();
    let insideTx = -1;
    await tenancy.run(member(), async (tenant) => {
      await requestDeletion(queue, tenant, {
        trigger: 'erasure',
        scope: { type: 'refs', pii_refs: [randomUUID()] },
        idempotencyKey: key,
      });
      insideTx = await visibleJobs(piiDeleteJob.type, `erasure:${key}`);
    });
    expect(insideTx).toBe(0);
    expect(await visibleJobs(piiDeleteJob.type, `erasure:${key}`)).toBe(1);
  });
});
