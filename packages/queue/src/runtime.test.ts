import type { TenantContext, TenantRunner } from '@omnibridge/core';
import { createLogger } from '@omnibridge/logger';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineJob } from './job.ts';
import { JobQueue, type ConcurrencyLimiter, type JobRecordStore } from './runtime.ts';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';

const capped = defineJob({
  type: 'test.capped',
  payload: z.object({}),
  perAccountCap: 1,
  heartbeatSeconds: 10,
});

function job(id: string): JobWithMetadata<unknown> {
  return {
    id,
    name: capped.type,
    data: {
      workspace_id: WORKSPACE,
      channel_account_id: ACCOUNT,
      idempotency_key: id,
      attempt: 0,
      type: capped.type,
      payload: {},
    },
    retryCount: 0,
    retryLimit: 3,
  } as unknown as JobWithMetadata<unknown>;
}

/** A tenancy that records each transaction it opens and the context it hands the handler. */
function spyTenancy() {
  const opened: { workspaceId: string }[] = [];
  const contexts: TenantContext[] = [];
  const tenancy: TenantRunner = {
    runWorkspace: (actor, fn) => {
      opened.push({ workspaceId: actor.workspaceId });
      const ctx: TenantContext = { workspaceId: actor.workspaceId, companyIds: ['company-1'] };
      contexts.push(ctx);
      return fn(ctx);
    },
    runMember: () => Promise.reject(new Error('jobs never run as a member')),
    run: (ctx, fn) => fn(ctx),
  };
  return { tenancy, opened, contexts };
}

/** An in-memory semaphore with the same contract as the PostgreSQL one, counting each call. */
function spyLimiter() {
  const holders = new Set<string>();
  const calls = { acquire: 0, renew: 0, release: 0 };
  const limiter: ConcurrencyLimiter = {
    acquire: (_ctx, _scope, cap, holder) => {
      calls.acquire += 1;
      if (holders.size >= cap) return Promise.resolve(false);
      holders.add(holder);
      return Promise.resolve(true);
    },
    renew: () => {
      calls.renew += 1;
      return Promise.resolve();
    },
    release: (_ctx, _scope, holder) => {
      calls.release += 1;
      holders.delete(holder);
      return Promise.resolve();
    },
  };
  return { limiter, calls, holders };
}

describe('JobQueue per-account lease', () => {
  it('[OPS-10] [NFR-3] a failed "active" record update releases the lease and stops its renewal', async () => {
    vi.useFakeTimers();
    try {
      const { limiter, calls, holders } = spyLimiter();
      let failNext = true;
      const records: JobRecordStore = {
        createAndEnqueue: () => Promise.reject(new Error('unused')),
        update: (_ctx, _key, patch) => {
          if (patch.state === 'active' && failNext) {
            failNext = false;
            return Promise.reject(new Error('db down'));
          }
          return Promise.resolve();
        },
      };
      let run: ((jobs: JobWithMetadata<unknown>[]) => Promise<void>) | undefined;
      const boss = {
        work: (_name: string, _opts: unknown, cb: typeof run) => {
          run = cb;
          return Promise.resolve('worker-1');
        },
      } as unknown as PgBoss;
      const logger = createLogger({
        service: 'test',
        version: '0',
        destination: { write: () => 0 },
      });
      const { tenancy } = spyTenancy();
      const queue = new JobQueue({ boss, records, limiter, tenancy, logger });
      const handled: string[] = [];
      await queue.work(capped, ({ envelope }) => {
        handled.push(envelope.idempotency_key);
        return Promise.resolve({});
      });

      await expect(run?.([job('job-1')])).rejects.toThrow('db down');
      expect(calls.release).toBe(1);
      expect(holders.size).toBe(0);

      const renewsAfterFailure = calls.renew;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls.renew).toBe(renewsAfterFailure);

      await run?.([job('job-2')]);
      expect(handled).toEqual(['job-2']);
      expect(calls.release).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JobQueue tenant transactions (TEN-1)', () => {
  const plain = defineJob({ type: 'test.plain', payload: z.object({}) });
  const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });

  function harness() {
    const spy = spyTenancy();
    const updates: TenantContext[] = [];
    const sent: string[] = [];
    let run: ((jobs: JobWithMetadata<unknown>[]) => Promise<void>) | undefined;
    const boss = {
      work: (_name: string, _opts: unknown, cb: typeof run) => {
        run = cb;
        return Promise.resolve('worker-1');
      },
      send: (name: string) => {
        sent.push(name);
        return Promise.resolve('dlq-id');
      },
    } as unknown as PgBoss;
    const records: JobRecordStore = {
      createAndEnqueue: () => Promise.reject(new Error('unused')),
      update: (ctx) => {
        updates.push(ctx);
        return Promise.resolve();
      },
    };
    const queue = new JobQueue({ boss, records, tenancy: spy.tenancy, logger });
    return { ...spy, updates, sent, queue, run: (jobs: JobWithMetadata<unknown>[]) => run?.(jobs) };
  }

  const data = (extra: Record<string, unknown> = {}) =>
    ({
      id: 'job-1',
      name: plain.type,
      data: { idempotency_key: 'k-1', attempt: 0, type: plain.type, payload: {}, ...extra },
      retryCount: 0,
      retryLimit: 3,
    }) as unknown as JobWithMetadata<unknown>;

  it('[TEN-1] job without workspace in envelope is rejected', async () => {
    const h = harness();
    const handled: unknown[] = [];
    await h.queue.work(plain, (job) => {
      handled.push(job);
      return Promise.resolve();
    });
    await h.run([data()]);
    await h.run([data({ workspace_id: 'not-a-uuid' })]);
    expect(handled).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.sent).toEqual(['test.plain.dlq', 'test.plain.dlq']);
  });

  it('[TEN-1] a handler runs in one tenant transaction opened from its envelope; bookkeeping stays outside it', async () => {
    const h = harness();
    const seen: TenantContext[] = [];
    await h.queue.work(plain, async (job) => {
      seen.push(job.ctx);
      await job.progress(50);
      return {};
    });
    await h.run([data({ workspace_id: WORKSPACE })]);
    expect(h.opened).toEqual([{ workspaceId: WORKSPACE }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(h.contexts[0]);
    expect(seen[0]?.companyIds).toEqual(['company-1']);
    // Progress and state updates commit on their own (PS-017): never the handler's context.
    expect(h.updates.length).toBeGreaterThanOrEqual(3);
    for (const ctx of h.updates) {
      expect(ctx).not.toBe(seen[0]);
      expect(ctx.workspaceId).toBe(WORKSPACE);
    }
  });

  it('[TEN-1] a phased handler prepares outside any tenant transaction, then commits in one (F-M04h-05)', async () => {
    const h = harness();
    const order: string[] = [];
    const committed: unknown[] = [];
    await h.queue.work(plain, {
      prepare: (job) => {
        // Network work (the vault) runs here: no transaction is open yet, and no ctx is given.
        order.push(`prepare:${String(h.opened.length)}`);
        expect('ctx' in job).toBe(false);
        return Promise.resolve({ removed: 3 });
      },
      commit: (job, prepared) => {
        order.push(`commit:${String(h.opened.length)}`);
        expect(job.ctx).toBe(h.contexts[0]);
        committed.push(prepared);
        return Promise.resolve({ records: prepared.removed });
      },
    });
    await h.run([data({ workspace_id: WORKSPACE })]);
    expect(order).toEqual(['prepare:0', 'commit:1']);
    expect(committed).toEqual([{ removed: 3 }]);
    expect(h.opened).toHaveLength(1);
  });

  it('[TEN-1] a failing prepare opens no transaction and fails the job for a retry', async () => {
    const h = harness();
    await h.queue.work(plain, {
      prepare: () => Promise.reject(new Error('vault down')),
      commit: () => Promise.resolve({}),
    });
    await expect(h.run([data({ workspace_id: WORKSPACE })])).rejects.toThrow(/vault down/);
    expect(h.opened).toEqual([]);
  });
});
