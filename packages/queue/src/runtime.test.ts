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
      const queue = new JobQueue({ boss, records, limiter, logger });
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
