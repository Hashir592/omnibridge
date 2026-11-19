import { createHash } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import {
  TRIGGER_SCOPES,
  type DeletionScope,
  type DeletionTrigger,
} from '@omnibridge/vault-client/schemas';
import { piiDeleteJob } from './registry.ts';
import type { JobQueue } from './runtime.ts';

/** One deletion to run (DEL-1): a trigger, a scope of IDs, and the key that makes it run once. */
export interface DeletionRequest {
  trigger: DeletionTrigger;
  scope: DeletionScope;
  /** For example `cancel:<order id>`, `ebay-deletion:<notification id>`, `closure:<workspace>`. */
  idempotencyKey: string;
}

/**
 * The one entry point of the deletion service (DEL-1) for every trigger and every module:
 * expiry (the hourly sweep), cancellation (M10), erasure (T-0404), the eBay deletion notice
 * (T-0404), Amazon revocation (M07), eBay termination (M08) and workspace closure (M05). It
 * refuses a scope that does not fit the trigger, and queues IDs only (invariant 7a).
 *
 * A-002 (ADR-069): `ctx` is passed to the queue as it is, so a caller's bound context (a request
 * or a job transaction) carries the job: it becomes visible only when that transaction commits.
 */
export async function requestDeletion(
  queue: Pick<JobQueue, 'send'>,
  ctx: TenantContext,
  request: DeletionRequest,
): Promise<{ id: string; created: boolean }> {
  if (!TRIGGER_SCOPES[request.trigger].includes(request.scope.type)) {
    throw new Error(`Deletion trigger ${request.trigger} cannot use a ${request.scope.type} scope`);
  }
  const channelAccountId =
    request.scope.type === 'channel_account' ? request.scope.channel_account_id : undefined;
  return queue.send(piiDeleteJob, {
    ctx,
    idempotencyKey: `${request.trigger}:${request.idempotencyKey}`,
    payload: { trigger: request.trigger, scope: request.scope },
    ...(channelAccountId === undefined ? {} : { channelAccountId }),
  });
}

/**
 * The run id of a deletion job: the same for every attempt of one job, so a retry is the same
 * run in the vault and in db-main (DEL-3), and different for every job.
 */
export function deletionRunId(workspaceId: string, type: string, idempotencyKey: string): string {
  const h = createHash('sha256').update(`${workspaceId}\0${type}\0${idempotencyKey}`).digest();
  h[6] = 0x80 | ((h[6] ?? 0) & 0x0f); // version 8 (custom)
  h[8] = 0x80 | ((h[8] ?? 0) & 0x3f);
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
