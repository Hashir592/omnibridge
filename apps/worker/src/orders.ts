import { londonDate, type TenantContext, type TenantRunner } from '@omnibridge/core';
import { type Connection, type OrderIngest, type OrderReads } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import { PII_HARD_LIMIT_MS, piiExpiryDate } from '@omnibridge/order-ingest';
import {
  ordersOrphanSweepJob,
  ordersSyncAccountsJob,
  syncPollJob,
  type JobHandler,
  type JobQueue,
  type PhasedHandler,
  type SyncStreamName,
} from '@omnibridge/queue';
import { type VaultClient } from '@omnibridge/vault-client';
import { MATCH_MAX } from '@omnibridge/vault-client/schemas';

// The ingest step itself moved to packages/order-ingest (T-1101), shared with the website push.
export {
  orderIngestPorts,
  orderIngestStream,
  PII_HARD_LIMIT_MS,
  piiDeleteAfter,
  piiExpiryDate,
  toIncoming,
  type OrderStreamDeps,
} from '@omnibridge/order-ingest';

/*
 * M10 order ingest in the worker (T-1001: ORD-4, DEL-1, FA-10, FA-16). Vault first: buyer details
 * go to pii-vault with no transaction open, then the order goes to db-main in the sync job's
 * transaction, keyed by channel account and external order ID on both sides. If the db-main write
 * fails, the vault record is an orphan the nightly sweep expires; it already carries the 90-day
 * backstop (PRD 7.3), so it can never outlive that.
 */

const DAY_MS = 86_400_000;
/**
 * FA-10: a vault record younger than this may belong to an ingest still writing db-main, or to a
 * sync job still retrying (its retries end well inside a day). Older ones with no order go.
 */
const ORPHAN_GRACE_MS = DAY_MS;

/**
 * orders.group_recompute (ORD-9, C3.2). With no transaction open, the vault's `match` capability
 * says which of the account's awaiting orders share a buyer and delivery address (order subjects
 * only, never PII); then, in the job's transaction, db-main links them under an advisory lock.
 */
export function ordersGroupRecomputeHandler(deps: {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  reads: Pick<OrderReads, 'groupCandidates' | 'applyGroups'>;
  vault: Pick<VaultClient, 'match'>;
}): PhasedHandler<Record<string, never>, [string, string][]> {
  return {
    prepare: async (job) => {
      const workspaceId = job.envelope.workspace_id;
      const accountId = job.envelope.channel_account_id;
      if (accountId === undefined) return [];
      const candidates = await deps.tenancy.runWorkspace({ workspaceId }, (ctx) =>
        deps.reads.groupCandidates(ctx, accountId),
      );
      // Match keys are exact, so "shares a key with" is a class. One vault call for them all.
      const newest = candidates.slice(-MATCH_MAX);
      if (newest.length === 0) return [];
      const { groups } = await deps.vault.match({
        workspace_id: workspaceId,
        channel_account_id: accountId,
        pii_refs: newest.map((c) => c.piiRef),
      });
      return groups.flatMap((subjects) =>
        subjects.map((s): [string, string] => [s, subjects[0] ?? s]),
      );
    },
    commit: async (job, classes) => {
      const accountId = job.envelope.channel_account_id;
      if (accountId === undefined) return { groups: 0 };
      return deps.reads.applyGroups(job.ctx, accountId, new Map(classes));
    },
  };
}

/**
 * orders.pii_expiry (DEL-1, ADR-068): the buyer record of a dispatched or delivered order goes at
 * that date plus the PII window. The vault call runs with no transaction open; the vault journals
 * the change off-site. A date already past moves to now, so the next hourly run deletes it.
 */
export function ordersPiiExpiryHandler(deps: {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  ingest: Pick<OrderIngest, 'piiExpiryOf' | 'retentionDays'>;
  vault: Pick<VaultClient, 'setExpiry'>;
  now?: () => Date;
}): PhasedHandler<{ order_id: string; reason: 'dispatch' | 'delivery' }, { updated: number }> {
  const now = deps.now ?? (() => new Date());
  return {
    prepare: async (job) => {
      const actor = { workspaceId: job.envelope.workspace_id };
      const [target, days] = await deps.tenancy.runWorkspace(actor, async (ctx) => {
        const rows = await deps.ingest.piiExpiryOf(ctx, [job.payload.order_id]);
        return [rows[0], await deps.ingest.retentionDays(ctx)] as const;
      });
      if (target === undefined) return { updated: 0 };
      // The job is queued only once dispatch or delivery is known, so `shipped` is set.
      const due = piiExpiryDate({
        placedAt: target.placedAt,
        shippedAt: target.deliveredAt ?? target.dispatchedAt ?? now(),
        retentionDays: days,
        now: now(),
      });
      const at = Math.min(
        Math.max(due.getTime(), now().getTime()),
        now().getTime() + PII_HARD_LIMIT_MS,
      );
      return deps.vault.setExpiry({
        workspace_id: job.envelope.workspace_id,
        pii_refs: [target.piiRef],
        delete_after: new Date(at).toISOString(),
        reason: job.payload.reason,
      });
    },
    commit: (_job, result) => Promise.resolve(result),
  };
}

/**
 * orders.orphan_sweep (FA-10): vault order records older than a day that no order points at
 * are expired now, so the next hourly run deletes them through the one deletion service.
 * IDs only; one short read per page, no transaction across a vault call.
 */
export function ordersOrphanSweepHandler(deps: {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  ingest: Pick<OrderIngest, 'knownPiiRefs'>;
  vault: Pick<VaultClient, 'subjects' | 'setExpiry'>;
  logger: Logger;
  now?: () => Date;
  /** How old a vault record must be before it can be an orphan (default a day). */
  graceMs?: number;
}): PhasedHandler<Record<string, never>, { orphans: number }> {
  const now = deps.now ?? (() => new Date());
  const grace = deps.graceMs ?? ORPHAN_GRACE_MS;
  return {
    prepare: async (job) => {
      const workspaceId = job.envelope.workspace_id;
      const before = new Date(now().getTime() - grace).toISOString();
      let after: string | undefined;
      let orphans = 0;
      for (let page = 0; page < 1000; page += 1) {
        const res = await deps.vault.subjects({
          workspace_id: workspaceId,
          subject_type: 'order',
          created_before: before,
          limit: 500,
          ...(after === undefined ? {} : { after }),
        });
        const refs = res.records.map((r) => r.pii_ref);
        const known = await deps.tenancy.runWorkspace({ workspaceId }, (ctx) =>
          deps.ingest.knownPiiRefs(ctx, refs),
        );
        const lost = refs.filter((r) => !known.has(r));
        if (lost.length > 0) {
          await deps.vault.setExpiry({
            workspace_id: workspaceId,
            pii_refs: lost,
            delete_after: now().toISOString(),
            reason: 'orphan',
          });
          orphans += lost.length;
        }
        if (res.next === null) break;
        after = res.next;
      }
      if (orphans > 0) {
        deps.logger.warn(
          { event: 'orders.orphans_expired', workspaceId, count: orphans },
          'vault order records with no order expired',
        );
      }
      return { orphans };
    },
    commit: (_job, result) => Promise.resolve(result),
  };
}

/** The order stream of each sales channel (Amazon's arrives with its seller ID in M18). */
const ORDER_STREAMS: Partial<Record<Connection['provider'], SyncStreamName>> = {
  ebay: 'ebay.orders',
  website: 'website.orders',
};

/** The 5-minute slot of a time, for the poll keys (CAP-6: new orders within 5 minutes). */
export function pollSlot(at: Date): string {
  const slot = Math.floor(at.getTime() / (5 * 60_000)) * 5 * 60_000;
  return new Date(slot).toISOString().slice(0, 16);
}

/** orders.sync_accounts: one sync.poll per connected eBay and website account, per slot. */
export function ordersSyncAccountsHandler(deps: {
  connections: { list(ctx: TenantContext, now: Date): Promise<readonly Connection[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: () => Date;
}): JobHandler<Record<string, never>> {
  const now = deps.now ?? (() => new Date());
  return async ({ ctx }) => {
    const slot = pollSlot(now());
    let sent = 0;
    for (const account of await deps.connections.list(ctx, now())) {
      const stream = ORDER_STREAMS[account.provider];
      if (stream === undefined || account.status === 'disconnected') continue;
      await deps.queue.send(syncPollJob, {
        ctx,
        channelAccountId: account.id,
        idempotencyKey: `sync.poll:${stream}:${account.id}:${slot}`,
        payload: { stream },
      });
      sent += 1;
    }
    return { sent };
  };
}

/** Every 5 minutes: one orders.sync_accounts job per workspace. */
export async function sweepOrdersSync({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(ordersSyncAccountsJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `orders.sync_accounts:${pollSlot(now)}`,
      payload: {},
    });
  }
  return ids.length;
}

/** Nightly: one orders.orphan_sweep job per workspace (FA-10). */
export async function sweepOrderOrphans({
  directory,
  queue,
  now = new Date(),
}: {
  directory: { listIds(): Promise<string[]> };
  queue: Pick<JobQueue, 'send'>;
  now?: Date;
}): Promise<number> {
  const ids = await directory.listIds();
  for (const workspaceId of ids) {
    await queue.send(ordersOrphanSweepJob, {
      ctx: { workspaceId, companyIds: [] },
      idempotencyKey: `orders.orphan_sweep:${londonDate(now)}`,
      payload: {},
    });
  }
  return ids.length;
}
