import type { DeletionLog } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import {
  deletionRunId,
  piiExpiryJob,
  type JobHandler,
  type JobQueue,
  type RunningJob,
} from '@omnibridge/queue';
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
  logger: Logger;
  now?: () => Date;
}

/**
 * One deletion run (DEL-1, DEL-2, DEL-3): the vault hard-deletes the scope and writes its
 * tombstones and journal; then db-main keeps the run log and its own copy of every tombstone.
 * The run id comes from the job's key, so a retry is the same run: the vault reports what it
 * already deleted and db-main adds whatever it missed. Logs and results hold counts only.
 */
async function runDeletion(
  deps: DeletionDeps,
  job: RunningJob<unknown>,
  trigger: DeletionTrigger,
  scope: DeletionScope,
): Promise<{ records: number }> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const { workspace_id: workspaceId, type, idempotency_key: key } = job.envelope;
  const runId = deletionRunId(workspaceId, type, key);
  let last: DeleteResponse | undefined;
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    last = await deps.vault.delete({ workspace_id: workspaceId, run_id: runId, trigger, scope });
    removed += last.counts.records;
    if (!last.more) break;
  }
  if (last?.more === true) throw new Error('deletion scope larger than one run: retrying');
  const deleted = last?.deleted ?? [];
  await deps.log.record(
    job.ctx,
    {
      id: runId,
      trigger,
      scopeType: scope.type,
      scope,
      channelAccountId: scope.type === 'channel_account' ? scope.channel_account_id : null,
      startedAt,
      finishedAt: now(),
    },
    deleted.map((d) => ({ piiRef: d.pii_ref, channelAccountId: d.channel_account_id })),
  );
  deps.logger.info(
    { event: 'pii.deletion', workspaceId, trigger, runId, count: deleted.length, removed },
    'deletion run done',
  );
  return { records: deleted.length };
}

/** pii.delete: every event-triggered deletion (DEL-1 triggers 2 to 7). */
export function piiDeleteHandler(
  deps: DeletionDeps,
): JobHandler<{ trigger: DeletionTrigger; scope: DeletionScope }> {
  return (job) => runDeletion(deps, job, job.payload.trigger, job.payload.scope);
}

/** pii.expiry: this workspace's records past delete_after (DEL-1 trigger 1, AT-8). */
export function piiExpiryHandler(deps: DeletionDeps): JobHandler<Record<string, never>> {
  return (job) => runDeletion(deps, job, 'expiry', { type: 'expiry' });
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
