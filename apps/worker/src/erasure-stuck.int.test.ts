import { randomUUID } from 'node:crypto';
import {
  createMainDb,
  createQueues,
  DeletionLog,
  ErasureRequestRepository,
  JobRecordRepository,
  migrateMain,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { JobQueue, piiDeleteJob, requestDeletion } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import type { DeleteRequest, DeleteResponse } from '@omnibridge/vault-client';
import type { PgBoss } from 'pg-boss';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { piiDeleteHandler } from './deletion.ts';
import { createWorkerBoss } from './heartbeat.ts';

// ADR-070 (F-M04e-01): the worker died during the last attempt of an erasure's deletion job.
// pg-boss expires the job and records it failed, but no `failed` hook runs, so the request stays
// confirmed with nothing left to finish it. It is stuck, and an admin's retry completes it. Here
// the "dead worker" fetches the job and never answers; the job expires after one second.

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });

describe('a stuck erasure request after a worker crash (ADR-070)', () => {
  let main: RoleCluster;
  let db: MainDbHandle;
  let owner: pg.Pool;
  let tenancy: Tenancy;
  let erasures: ErasureRequestRepository;
  let boss: PgBoss;
  let queue: JobQueue;
  const ws = randomUUID();
  const system = { workspaceId: ws, companyIds: [] };

  const vault = {
    delete: (r: DeleteRequest): Promise<DeleteResponse> => {
      const refs = r.scope.type === 'refs' ? r.scope.pii_refs : [];
      return Promise.resolve({
        run_id: r.run_id,
        deleted: refs.map((ref) => ({ pii_ref: ref, channel_account_id: null })),
        more: false,
        counts: { records: refs.length, fields: 0, index: 0 },
      });
    },
  };

  const jobState = async (id: string) =>
    (
      await owner.query<{ state: string }>(
        'SELECT state::text AS state FROM pgboss.job WHERE id = $1',
        [id],
      )
    ).rows[0]?.state;
  const waitFor = async <T>(read: () => Promise<T>, want: (v: T) => boolean): Promise<T> => {
    for (let i = 0; i < 120; i += 1) {
      const v = await read();
      if (want(v)) return v;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('timed out');
  };

  beforeAll(async () => {
    main = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']);
    await migrateMain(main.connection('ob_owner'));
    await createQueues(main.connection('ob_owner'), [
      { ...piiDeleteJob, retry: { ...piiDeleteJob.retry, limit: 0 }, expireInSeconds: 1 },
    ]);
    owner = new pg.Pool({ ...main.connection('ob_owner'), max: 2 });
    db = createMainDb({ ...main.connection('ob_worker'), max: 4 });
    tenancy = new Tenancy(db.db);
    erasures = new ErasureRequestRepository(db.db);
    await tenancy.run(system, (c) => new WorkspaceRepository(db.db).create(c, { name: 'Stuck' }));
    boss = createWorkerBoss(main.connection('ob_worker'), {
      monitorIntervalSeconds: 1,
      superviseIntervalSeconds: 1,
    });
    boss.on('error', () => undefined);
    await boss.start();
    queue = new JobQueue({ boss, records: new JobRecordRepository(db.db), tenancy, logger });
  }, 300_000);

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await owner.end();
    await db.destroy();
    await main.container.stop();
  });

  it('[DEL-4] a job whose last attempt expired with no hook leaves the request stuck; an admin retry completes it', async () => {
    const id = randomUUID();
    await erasures.create(system, {
      id,
      requestedBy: randomUUID(),
      piiRefs: [randomUUID(), randomUUID()],
      at: new Date(),
    });
    const claimed = await erasures.claim(system, id, { by: randomUUID(), at: new Date() });
    if (claimed === undefined) throw new Error('not claimed');
    const firstJob = await tenancy.run(system, async (c) => {
      const job = await requestDeletion(queue, c, {
        trigger: 'erasure',
        scope: { type: 'refs', pii_refs: claimed.piiRefs },
        idempotencyKey: id,
      });
      await erasures.setJob(c, id, job.id);
      return job.id;
    });

    // Queued and not yet run: live, so not stuck.
    expect(await erasures.stuckIds(system, [id], new Date())).toEqual(new Set());

    // A worker takes the job and dies: pg-boss expires it and records it failed.
    const taken = await boss.fetch('pii.delete');
    expect(taken.map((j) => j.id)).toEqual([firstJob]);
    expect(
      await waitFor(
        () => jobState(firstJob),
        (s) => s === 'failed',
      ),
    ).toBe('failed');
    expect((await erasures.get(system, id))?.state).toBe('confirmed');
    expect(await erasures.stuckIds(system, [id], new Date())).toEqual(new Set([id]));

    // The retry route's steps: back to confirmed with no job, a new run, the job recorded.
    const retried = await tenancy.run(system, async (c) => {
      const r = await erasures.retry(c, id, new Date());
      if (r === undefined) throw new Error('not retried');
      const job = await requestDeletion(queue, c, {
        trigger: 'erasure',
        scope: { type: 'refs', pii_refs: r.piiRefs },
        idempotencyKey: `${r.id}:retry${String(r.retryCount)}`,
      });
      return erasures.setJob(c, id, job.id);
    });
    expect(retried?.retryCount).toBe(1);
    expect(retried?.jobId).not.toBe(firstJob);
    expect(await erasures.stuckIds(system, [id], new Date())).toEqual(new Set());
    // A second retry finds a live job: nothing to retry.
    expect(await tenancy.run(system, (c) => erasures.retry(c, id, new Date()))).toBeUndefined();

    // A live worker now runs the new job, and the request completes.
    await queue.work(
      piiDeleteJob,
      piiDeleteHandler({ vault, log: new DeletionLog(db.db), erasures, logger }),
      { pollingIntervalSeconds: 0.5 },
    );
    const done = await waitFor(
      () => erasures.get(system, id),
      (r) => r?.state === 'completed',
    );
    expect(done?.completedAt).toBeInstanceOf(Date);
    expect(await erasures.stuckIds(system, [id], new Date())).toEqual(new Set());
  });
});
