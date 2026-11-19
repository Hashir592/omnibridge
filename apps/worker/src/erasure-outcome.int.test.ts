import { randomUUID } from 'node:crypto';
import {
  createMainDb,
  createQueues,
  DeletionLog,
  ErasureRequestRepository,
  JobRecordRepository,
  migrateMain,
  NotificationRepository,
  Tenancy,
  WorkspaceRepository,
  type ErasureRequest,
  type MainDbHandle,
} from '@omnibridge/db';
import { Notifier } from '@omnibridge/core';
import { createLogger } from '@omnibridge/logger';
import { JobQueue, piiDeleteJob, requestDeletion } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import type { DeleteRequest, DeleteResponse } from '@omnibridge/vault-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { piiDeleteHandler } from './deletion.ts';
import { createWorkerBoss } from './heartbeat.ts';

// A-006 (ADR-069): the auditor confirmed an erasure, the deletion job failed, and the request
// still read "confirmed", so the screen looked done and the one-month clock stopped counting it.
// The request now takes its state from the job: completed when it ran, failed when its last
// attempt failed. The queue here gives pii.delete no retries, so the first failure is the last.

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });

describe('erasure request state from the deletion job (A-006)', () => {
  let main: RoleCluster;
  let db: MainDbHandle;
  let tenancy: Tenancy;
  let erasures: ErasureRequestRepository;
  let stopBoss: () => Promise<void>;
  let queue: JobQueue;
  let vaultDown = false;
  const ws = randomUUID();
  const system = { workspaceId: ws, companyIds: [] };

  const fakeVault = {
    delete: (r: DeleteRequest): Promise<DeleteResponse> => {
      if (vaultDown) return Promise.reject(new Error('vault unreachable'));
      const refs = r.scope.type === 'refs' ? r.scope.pii_refs : [];
      return Promise.resolve({
        run_id: r.run_id,
        deleted: refs.map((ref) => ({ pii_ref: ref, channel_account_id: null })),
        more: false,
        counts: { records: refs.length, fields: 0, index: 0 },
      });
    },
  };

  /** A confirmed request with its deletion queued, as the confirm route leaves it. */
  const confirmed = async (): Promise<ErasureRequest> => {
    const id = randomUUID();
    await erasures.create(system, {
      id,
      requestedBy: randomUUID(),
      piiRefs: [randomUUID(), randomUUID()],
      at: new Date(),
    });
    const claimed = await erasures.claim(system, id, { by: randomUUID(), at: new Date() });
    if (claimed === undefined) throw new Error('not claimed');
    return tenancy.run(system, async (c) => {
      const job = await requestDeletion(queue, c, {
        trigger: 'erasure',
        scope: { type: 'refs', pii_refs: claimed.piiRefs },
        idempotencyKey: id,
      });
      const withJob = await erasures.setJob(c, id, job.id);
      if (withJob === undefined) throw new Error('no job recorded');
      return withJob;
    });
  };
  const settled = async (id: string) => {
    for (let i = 0; i < 120; i += 1) {
      const r = await erasures.get(system, id);
      if (r !== undefined && r.state !== 'confirmed') return r;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('request stayed confirmed');
  };

  beforeAll(async () => {
    main = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']);
    await migrateMain(main.connection('ob_owner'));
    await createQueues(main.connection('ob_owner'), [
      { ...piiDeleteJob, retry: { ...piiDeleteJob.retry, limit: 0 } },
    ]);
    db = createMainDb({ ...main.connection('ob_worker'), max: 4 });
    tenancy = new Tenancy(db.db);
    erasures = new ErasureRequestRepository(db.db);
    await tenancy.run(system, (c) => new WorkspaceRepository(db.db).create(c, { name: 'A-006' }));
    const boss = createWorkerBoss(main.connection('ob_worker'), { monitorIntervalSeconds: 1 });
    boss.on('error', () => undefined);
    await boss.start();
    stopBoss = () => boss.stop({ graceful: false, close: true });
    queue = new JobQueue({ boss, records: new JobRecordRepository(db.db), tenancy, logger });
    await queue.work(
      piiDeleteJob,
      piiDeleteHandler({
        vault: fakeVault,
        log: new DeletionLog(db.db),
        erasures,
        notifier: new Notifier({ store: new NotificationRepository(db.db) }),
        logger,
      }),
      { pollingIntervalSeconds: 0.5 },
    );
  }, 300_000);

  afterAll(async () => {
    await stopBoss();
    await db.destroy();
    await main.container.stop();
  });

  it('[DEL-4] a deletion that ran leaves its erasure request completed', async () => {
    vaultDown = false;
    const request = await confirmed();
    const done = await settled(request.id);
    expect(done.state).toBe('completed');
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.failedAt).toBeNull();
  });

  it('[DEL-4] a deletion whose last attempt failed leaves its erasure request failed, not confirmed', async () => {
    vaultDown = true;
    const request = await confirmed();
    const failed = await settled(request.id);
    expect(failed.state).toBe('failed');
    expect(failed.failedAt).toBeInstanceOf(Date);
    expect(failed.completedAt).toBeNull();
    expect(failed.jobId).toBe(request.jobId);
  });

  it('[SEC-12][DEL-4] a failed erasure raises a critical alert to admins at once; its completion after a retry resolves it', async () => {
    vaultDown = true;
    const request = await confirmed();
    await settled(request.id);
    const alerts = () =>
      tenancy.runWorkspace({ workspaceId: ws }, async (ctx) =>
        (
          await new NotificationRepository(db.db).list(
            ctx,
            { userId: randomUUID(), tabs: 'all' },
            {},
            { limit: 50 },
          )
        ).items.filter((n) => n.type === 'pii.erasure_failed' && n.record.id === request.id),
      );
    expect(await alerts()).toEqual([
      expect.objectContaining({ severity: 'critical', tab: 'users', state: 'unread' }),
    ]);

    // An admin retries (the route's steps) and the new run completes: the alert resolves.
    vaultDown = false;
    await tenancy.run(system, async (c) => {
      const r = await erasures.retry(c, request.id, new Date());
      if (r === undefined) throw new Error('not retried');
      const job = await requestDeletion(queue, c, {
        trigger: 'erasure',
        scope: { type: 'refs', pii_refs: r.piiRefs },
        idempotencyKey: `${r.id}:retry${String(r.retryCount)}`,
      });
      await erasures.setJob(c, r.id, job.id);
    });
    await settled(request.id);
    expect((await alerts()).map((n) => n.state)).toEqual(['resolved']);
  });
});
