import type { TenantContext } from '@omnibridge/core';
import { z } from 'zod';
import { defineJob, definePlatformJob } from './job.ts';
import type { JobQueue } from './runtime.ts';

/**
 * Sends one outbound write (T-0702). Keyed `outbound:<write>:<dispatch>`, so every dispatch of a
 * write (first send, after a pause, after a wait) is its own job and a repeat of one is ignored.
 * Its own retries only cover a crash; the write's attempts are counted on the write itself.
 */
export const outboundSendJob = defineJob({
  type: 'outbound.send',
  payload: z.object({ write_id: z.uuid() }).strict(),
  retry: { limit: 3, delaySeconds: 30, backoff: true, maxDelaySeconds: 600 },
  expireInSeconds: 600,
});

/** Sends again the writes a worker took but never finished, and those a switch held that is off. */
export const outboundRecoverJob = defineJob({
  type: 'outbound.recover',
  payload: z.object({}).strict(),
  retry: { limit: 3, delaySeconds: 60, backoff: true, maxDelaySeconds: 600 },
  expireInSeconds: 300,
});

/** Every ten minutes: one outbound.recover job per workspace (the safety net of the resume). */
export const outboundRecoverSweepJob = definePlatformJob({
  type: 'outbound.recover-sweep',
  cron: '*/10 * * * *',
  heavy: false,
});

/** A worker's claim older than this is taken to be dead. */
export const OUTBOUND_STALE_MS = 10 * 60_000;

type WriteRef = { id: string; channelAccountId: string };

/** db-main app.outbound_writes as the queue side needs it (packages/db OutboundWriteRepository). */
export interface OutboundWriteStore {
  insert(
    ctx: TenantContext,
    input: {
      channelAccountId: string;
      provider: 'amazon' | 'amazon_ads' | 'ebay' | 'website' | 'evri' | 'dpd';
      operation: string;
      urgent: boolean;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    },
    at: Date,
  ): Promise<{ id: string; created: boolean }>;
  pausedIds(
    ctx: TenantContext,
    filter: { channelAccountId?: string; reason: 'kill_switch' | 'maintenance' },
  ): Promise<WriteRef[]>;
  unpause(ctx: TenantContext, id: string, at: Date): Promise<number>;
  redispatch(ctx: TenantContext, id: string, at: Date): Promise<number>;
  recoverable(
    ctx: TenantContext,
    input: { staleBefore: Date; maintenance: boolean },
  ): Promise<WriteRef[]>;
}

/**
 * The one way a module queues a provider write (T-0702): the write row and its first send job in
 * the caller's transaction, so neither exists without the other (A-002). Also the resume after a
 * switch is turned off, and the recovery sweep.
 */
export class OutboundQueue {
  readonly #queue: Pick<JobQueue, 'send'>;
  readonly #writes: OutboundWriteStore;
  readonly #now: () => Date;

  constructor(options: {
    queue: Pick<JobQueue, 'send'>;
    writes: OutboundWriteStore;
    now?: () => Date;
  }) {
    this.#queue = options.queue;
    this.#writes = options.writes;
    this.#now = options.now ?? (() => new Date());
  }

  /** Once per idempotency key; payloads hold IDs and numbers only (invariant 7a). */
  async enqueue(
    ctx: TenantContext,
    input: Parameters<OutboundWriteStore['insert']>[1],
  ): Promise<{ id: string; created: boolean }> {
    const result = await this.#writes.insert(ctx, input, this.#now());
    if (result.created) {
      await this.dispatch(ctx, { id: result.id, channelAccountId: input.channelAccountId }, 0);
    }
    return result;
  }

  /** The outbound.send job of one dispatch of a write. */
  async dispatch(
    ctx: TenantContext,
    write: WriteRef,
    dispatchSeq: number,
    startAfter?: Date,
  ): Promise<void> {
    await this.#queue.send(outboundSendJob, {
      ctx,
      channelAccountId: write.channelAccountId,
      idempotencyKey: `outbound:${write.id}:${String(dispatchSeq)}`,
      payload: { write_id: write.id },
      ...(startAfter === undefined ? {} : { startAfter }),
    });
  }

  /** SAFE-2: the account's kill switch was turned off; its waiting writes go now. */
  resumeAccount(ctx: TenantContext, channelAccountId: string): Promise<number> {
    return this.#resume(ctx, { channelAccountId, reason: 'kill_switch' });
  }

  /** SAFE-3: maintenance was turned off; this workspace's waiting writes go now. */
  resumeMaintenance(ctx: TenantContext): Promise<number> {
    return this.#resume(ctx, { reason: 'maintenance' });
  }

  /** The safety net: stale claims and writes whose switch is off are sent again. */
  async recover(ctx: TenantContext, input: { maintenance: boolean }): Promise<number> {
    const now = this.#now();
    const refs = await this.#writes.recoverable(ctx, {
      staleBefore: new Date(now.getTime() - OUTBOUND_STALE_MS),
      maintenance: input.maintenance,
    });
    for (const ref of refs) {
      await this.dispatch(ctx, ref, await this.#writes.redispatch(ctx, ref.id, now));
    }
    return refs.length;
  }

  async #resume(
    ctx: TenantContext,
    filter: { channelAccountId?: string; reason: 'kill_switch' | 'maintenance' },
  ): Promise<number> {
    const refs = await this.#writes.pausedIds(ctx, filter);
    for (const ref of refs) {
      await this.dispatch(ctx, ref, await this.#writes.unpause(ctx, ref.id, this.#now()));
    }
    return refs.length;
  }
}
