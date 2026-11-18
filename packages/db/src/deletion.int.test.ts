import { randomUUID } from 'node:crypto';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthStore } from './auth.ts';
import { DeletionLog } from './deletion.ts';
import { migrateMain } from './migrate.ts';
import { MemberAccessRepository } from './permissions.ts';
import { createMainDb, type MainDbHandle } from './pool.ts';
import { Tenancy } from './tenant.ts';
import { MembershipRepository, UserRepository } from './users.ts';
import { WorkspaceRepository } from './workspaces.ts';

// T-0403, db-main half of the deletion service: the run log and tombstones are append-only, and
// a person's terms acceptances go with them (ADR-058 b).

describe('deletion log and personal data in db-main [DEL-2][DEL-3]', () => {
  let cluster: RoleCluster;
  let app: MainDbHandle;
  let worker: MainDbHandle;
  const ws = randomUUID();
  const staying = randomUUID();
  const leaving = randomUUID();
  const ctx = { workspaceId: ws, companyIds: [] };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_worker']);
    await migrateMain(cluster.connection('ob_owner'));
    app = createMainDb({ ...cluster.connection('ob_app'), max: 2 });
    worker = createMainDb({ ...cluster.connection('ob_worker'), max: 2 });
    const tenancy = new Tenancy(app.db);
    await tenancy.run(ctx, (c) =>
      new WorkspaceRepository(app.db).create(c, { name: 'Deletion log test' }),
    );
    // A user row is written in a transaction that names that user (users_self policy).
    for (const id of [staying, leaving]) {
      await tenancy.run({ ...ctx, userId: id }, async (c) => {
        await new UserRepository(app.db).create(c, { id, email: `${id}@example.test`, name: 'P' });
        await new MembershipRepository(app.db).add(c, { userId: id, role: 'admin' });
      });
    }
    const auth = new AuthStore(app.db);
    for (const id of [staying, leaving]) {
      await auth.acceptTerms(id, '2026-11-15', new Date('2026-11-16T10:00:00Z'), '192.0.2.1');
    }
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app.destroy(), worker.destroy()]);
    await cluster.container.stop();
  });

  it('[DEL-3] a run and its tombstones are recorded once; a retry adds nothing twice', async () => {
    const log = new DeletionLog(worker.db);
    const tenancy = new Tenancy(worker.db);
    const run = {
      id: randomUUID(),
      trigger: 'erasure',
      scopeType: 'refs',
      scope: { type: 'refs', pii_refs: ['x'] },
      channelAccountId: null,
      startedAt: new Date(),
      finishedAt: new Date(),
    };
    const refs = [randomUUID(), randomUUID()].map((piiRef) => ({ piiRef, channelAccountId: null }));
    await tenancy.run(ctx, (c) => log.record(c, run, refs.slice(0, 1)));
    await tenancy.run(ctx, (c) => log.record(c, run, refs));
    expect(await tenancy.run(ctx, (c) => log.tombstones(c))).toEqual(
      refs.map((r) => r.piiRef).sort(),
    );
    const runs = await tenancy.run(ctx, (c) => log.runs(c));
    expect(runs.filter((r) => r.id === run.id)).toHaveLength(1);
  });

  it('[DEL-2] the run log and tombstones cannot be changed or removed by the app', async () => {
    for (const statement of [
      'DELETE FROM app.pii_tombstones',
      'UPDATE app.deletion_runs SET result = $1',
    ]) {
      await expect(
        worker.pool.query(statement, statement.includes('$1') ? ['done'] : []),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('[DEL-2] a person who left every workspace has their terms acceptances deleted; no one else may', async () => {
    const log = new DeletionLog(worker.db);
    // Still a member: refused, nothing deleted.
    await expect(log.deleteUserTerms(leaving)).rejects.toThrow(/still belongs/);
    await new Tenancy(app.db).run({ ...ctx, userId: staying }, (c) =>
      new MemberAccessRepository(app.db).remove(c, leaving),
    );
    expect(await log.deleteUserTerms(leaving)).toBe(1);
    const auth = new AuthStore(app.db);
    expect(await auth.termsAccepted(leaving, '2026-11-15')).toBe(false);
    expect(await auth.termsAccepted(staying, '2026-11-15')).toBe(true);
    // The table stays append-only for everyone else, the owner included.
    const owner = createMainDb({ ...cluster.connection('ob_owner'), max: 1 });
    try {
      await expect(owner.pool.query('DELETE FROM app.terms_acceptances')).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await owner.destroy();
    }
    // web (ob_app) may not call the deletion at all.
    await expect(new DeletionLog(app.db).deleteUserTerms(staying)).rejects.toThrow(
      /permission denied/,
    );
  });
});
