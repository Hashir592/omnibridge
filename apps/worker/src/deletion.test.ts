import { randomUUID } from 'node:crypto';
import { createLogger } from '@omnibridge/logger';
import type { PreparingJob } from '@omnibridge/queue';
import type { DeleteRequest, DeleteResponse } from '@omnibridge/vault-client';
import { describe, expect, it } from 'vitest';
import { piiDeleteHandler, type DeletionDeps } from './deletion.ts';

// F-M04h-05 (invariant 3): the vault loop is the prepare phase, which the queue runs before the
// job's db-main transaction opens; only the run log is written in the commit phase.

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
type Payload = { trigger: DeleteRequest['trigger']; scope: DeleteRequest['scope'] };

describe('deletion job phases', () => {
  it('[DEL-2] the vault is called in prepare, in batches; db-main is written only in commit', async () => {
    const workspaceId = randomUUID();
    const ref = randomUUID();
    const calls: string[] = [];
    let batch = 0;
    const deps: DeletionDeps = {
      vault: {
        delete: (req) => {
          calls.push(`vault:${req.run_id}`);
          batch += 1;
          const answer: DeleteResponse = {
            run_id: req.run_id,
            counts: { records: 1, fields: 3, index: 2 },
            deleted: batch === 2 ? [{ pii_ref: ref, channel_account_id: null }] : [],
            more: batch < 2,
          };
          return Promise.resolve(answer);
        },
      },
      log: {
        record: (_ctx, run, tombstones) => {
          calls.push(`log:${run.id}:${String(tombstones.length)}`);
          return Promise.resolve();
        },
      },
      erasures: {
        complete: (_ctx, jobId) => {
          calls.push(`completed:${jobId}`);
          return Promise.resolve(true);
        },
        fail: () => Promise.resolve(true),
      },
      logger,
    };
    const handler = piiDeleteHandler(deps);
    const job: PreparingJob<Payload> = {
      jobId: 'job-1',
      envelope: {
        workspace_id: workspaceId,
        idempotency_key: 'erasure:1',
        attempt: 1,
        type: 'pii.delete',
        payload: { trigger: 'erasure', scope: { type: 'refs', pii_refs: [ref] } },
      },
      payload: { trigger: 'erasure', scope: { type: 'refs', pii_refs: [ref] } },
      attempt: 1,
      progress: () => Promise.resolve(),
    };
    const prepared = await handler.prepare(job);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith('vault:'))).toBe(true);
    const result = await handler.commit({ ...job, ctx: { workspaceId, companyIds: [] } }, prepared);
    expect(calls[2]).toBe(`log:${prepared.runId}:1`);
    // A-006: an erasure's request is completed in the same transaction as the run log.
    expect(calls[3]).toBe('completed:job-1');
    expect(result).toEqual({ records: 1 });
  });
});
