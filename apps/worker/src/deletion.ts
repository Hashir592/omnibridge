import type { Notifier } from '@omnibridge/core';
import type { DeletionLog, ErasureRequestRepository } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { deletionRunId, piiExpiryJob, type JobQueue, type PhasedHandler } from '@omnibridge/queue';
import type {
  DeleteResponse,
  DeletionScope,
  DeletionTrigger,
  VaultClient,
} from '@omnibridge/vault-client';

/** The vault caps one call at a batch; a run loops until the scope is empty, at most this often. */
const MAX_BATCHES = 200;

export interface DeletionDeps {
  /** A client holding the deletion token (VAULT_DELETION_TOKEN), never the worker token. */
  vault: Pick<VaultClient, 'delete'>;
  log: Pick<DeletionLog, 'record'>;
  /** A-006 (ADR-069): an erasure's request takes its state from this job's outcome. */
  erasures: Pick<ErasureRequestRepository, 'complete' | 'fail'>;
  /**
   * SEC-12 (T-0503): a failed erasure raises a critical alert to the workspace's admins, in the
   * hook's own transaction; a completed one resolves it (NTF-1).
   */
  notifier?: Pick<Notifier, 'raise' | 'resolve'>;
  logger: Logger;
  now?: () => Date;
}

interface VaultRun {
  runId: string;
  startedAt: Date;
  deleted: DeleteResponse['deleted'];
  removed: number;
}

/**
 * One deletion run (DEL-1, DEL-2, DEL-3), in two phases (F-M04h-05, invariant 3): first the vault
 * hard-deletes the scope and writes its tombstones and journal, with no db-main transaction open
 * (each vault call journals, deletes and VACUUMs); then, in the job's short tenant transaction,
 * db-main keeps the run log and its own copy of every tombstone. The run id comes from the job's
 * key, so a retry is the same run: the vault reports what it already deleted and db-main adds
 * whatever it missed. Logs and results hold counts only.
 */
function deletionRun<T>(
  deps: DeletionDeps,
  what: (payload: T) => { trigger: DeletionTrigger; scope: DeletionScope },
): PhasedHandler<T, VaultRun> {
  const now = deps.now ?? (() => new Date());
  return {
    prepare: async (job) => {
      const { trigger, scope } = what(job.payload);
      const startedAt = now();
      const { workspace_id: workspaceId, type, idempotency_key: key } = job.envelope;
      const runId = deletionRunId(workspaceId, type, key);
      let last: DeleteResponse | undefined;
      let removed = 0;
      for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        last = await deps.vault.delete({
          workspace_id: workspaceId,
          run_id: runId,
          trigger,
          scope,
        });
        removed += last.counts.records;
        if (!last.more) break;
      }
      if (last?.more === true) throw new Error('deletion scope larger than one run: retrying');
      return { runId, startedAt, deleted: last?.deleted ?? [], removed };
    },
    commit: async (job, run) => {
      const { trigger, scope } = what(job.payload);
      await deps.log.record(
        job.ctx,
        {
          id: run.runId,
          trigger,
          scopeType: scope.type,
          scope,
          channelAccountId: scope.type === 'channel_account' ? scope.channel_account_id : null,
          startedAt: run.startedAt,
          finishedAt: now(),
        },
        run.deleted.map((d) => ({ piiRef: d.pii_ref, channelAccountId: d.channel_account_id })),
      );
      // A-006: in the same transaction as the run log, so the request says completed only when
      // the run is recorded.
      if (trigger === 'erasure') {
        const requestId = await deps.erasures.complete(job.ctx, job.jobId, now());
        if (requestId !== undefined) {
          await deps.notifier?.resolve(job.ctx, 'pii.erasure_failed', {
            kind: 'erasure_request',
            id: requestId,
          });
        }
      }
      deps.logger.info(
        {
          event: 'pii.deletion',
          workspaceId: job.envelope.workspace_id,
          trigger,
          runId: run.runId,
          count: run.deleted.length,
          removed: run.removed,
        },
        'deletion run done',
      );
      return { records: run.deleted.length };
    },
    failed: async (job) => {
      const { trigger } = what(job.payload);
      if (trigger !== 'erasure') return;
      const requestId = await deps.erasures.fail(job.ctx, job.jobId, now());
      if (requestId !== undefined) {
        // IDs only: the admin sees Failed and retries; the alert says so at once (SEC-12).
        await deps.notifier?.raise(job.ctx, {
          type: 'pii.erasure_failed',
          record: { kind: 'erasure_request', id: requestId },
        });
        deps.logger.warn(
          { event: 'pii.erasure_failed', workspaceId: job.envelope.workspace_id, jobId: job.jobId },
          'erasure deletion failed after its last attempt: an admin must retry',
        );
      }
    },
  };
}

/** pii.delete: every event-triggered deletion (DEL-1 triggers 2 to 7). */
export function piiDeleteHandler(
  deps: DeletionDeps,
): PhasedHandler<{ trigger: DeletionTrigger; scope: DeletionScope }, VaultRun> {
  return deletionRun(deps, (payload) => payload);
}

/** pii.expiry: this workspace's records past delete_after (DEL-1 trigger 1, AT-8). */
export function piiExpiryHandler(
  deps: DeletionDeps,
): PhasedHandler<Record<string, never>, VaultRun> {
  return deletionRun(deps, () => ({ trigger: 'expiry', scope: { type: 'expiry' } }));
}

/**
 * The hourly expiry sweep (ARCHITECTURE 6.2): one pii.expiry job per workspace, keyed by the UTC
 * hour, so a second sweep in the same hour sends none.
 */
export async function sweepPiiExpiry({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const hour = now.toISOString().slice(0, 13);
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(piiExpiryJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `pii.expiry:${hour}`,
      payload: {},
    });
  }
  return ids.length;
}
