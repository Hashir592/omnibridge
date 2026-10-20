import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import type { Logger } from '@omnibridge/logger';
import type { Db, JobWithMetadata, PgBoss, SendOptions, WorkOptions } from 'pg-boss';
import type { z } from 'zod';
import { deadLetterName, parseEnvelope, type JobDefinition, type JobEnvelope } from './job.ts';

export type JobState = 'queued' | 'active' | 'retrying' | 'completed' | 'failed';

export interface JobRecordPatch {
  state: JobState;
  attempt?: number;
  percent?: number;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
}

/**
 * Job records in db-main: idempotency and progress (NFR-3, NFR-4). Implemented in packages/db,
 * so this package stays free of database code. Every call runs in a tenant transaction.
 */
export interface JobRecordStore {
  /**
   * In one tenant transaction: insert the record unless (type, idempotency key) exists, and only
   * when it was new, call `enqueue` with a pg-boss connection bound to that same transaction.
   */
  createAndEnqueue(
    ctx: TenantContext,
    record: { id: string; type: string; idempotencyKey: string },
    enqueue: (db: Db) => Promise<void>,
  ): Promise<{ id: string; created: boolean }>;
  update(
    ctx: TenantContext,
    key: { type: string; idempotencyKey: string },
    patch: JobRecordPatch,
  ): Promise<void>;
}

/**
 * A PostgreSQL semaphore (OPS-10): at most `cap` holders per scope at once, across all workers.
 * Implemented in packages/db with expiring leases, so a dead worker frees its slot.
 */
export interface ConcurrencyLimiter {
  acquire(
    ctx: TenantContext,
    scopeKey: string,
    cap: number,
    holder: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  renew(ctx: TenantContext, scopeKey: string, holder: string, ttlSeconds: number): Promise<void>;
  release(ctx: TenantContext, scopeKey: string, holder: string): Promise<void>;
}

/**
 * In-process gate for the global worker concurrency cap: pg-boss caps each queue separately, so
 * this bounds the jobs one worker runs at once across every queue.
 */
class Gate {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  async enter(): Promise<void> {
    if (this.#running < this.#limit) {
      this.#running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  leave(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#running -= 1;
  }
}

/** How often a capped job retries for a free slot while all are taken. */
const SLOT_POLL_MS = 100;

export interface SendInput<T> {
  ctx: TenantContext;
  channelAccountId?: string;
  idempotencyKey: string;
  payload: T;
}

export interface RunningJob<T> {
  readonly envelope: JobEnvelope<T>;
  readonly payload: T;
  readonly ctx: TenantContext;
  /** 1 on the first run, 2 on the first retry, and so on. */
  readonly attempt: number;
  /** Records progress for GET /jobs/{id} (NFR-4). */
  progress(percent: number): Promise<void>;
}

/** A handler resolves with its result: a plain object is stored for GET /jobs/:id, anything else as null. */
export type JobHandler<T> = (job: RunningJob<T>) => Promise<unknown>;

/** Options a caller may tune per worker; the rest is fixed by the job definition. */
export type WorkTuning = Pick<WorkOptions, 'localConcurrency' | 'pollingIntervalSeconds'>;

/**
 * Sends and runs workspace jobs through pg-boss (ADR-009) with the envelope of invariant 19,
 * idempotency keys, per-account ordering or caps, progress records and dead-letter redrive.
 */
export class JobQueue {
  readonly #boss: PgBoss;
  readonly #records: JobRecordStore;
  readonly #limiter: ConcurrencyLimiter | undefined;
  readonly #gate: Gate | undefined;
  readonly #log: Logger;

  constructor(options: {
    boss: PgBoss;
    records: JobRecordStore;
    /** Required to run job types with a perAccountCap. */
    limiter?: ConcurrencyLimiter;
    /** Most jobs this process runs at once, across all queues (WORKER_CONCURRENCY). */
    globalConcurrency?: number;
    logger: Logger;
  }) {
    if (
      options.globalConcurrency !== undefined &&
      (!Number.isInteger(options.globalConcurrency) || options.globalConcurrency < 1)
    ) {
      throw new Error('globalConcurrency must be a positive integer');
    }
    this.#gate =
      options.globalConcurrency === undefined ? undefined : new Gate(options.globalConcurrency);
    this.#boss = options.boss;
    this.#records = options.records;
    this.#limiter = options.limiter;
    this.#log = options.logger.child({ component: 'queue' });
  }

  /** Enqueues a job once per (workspace, type, idempotency key). A repeat returns the first id. */
  async send<P extends z.ZodType>(
    def: JobDefinition<P>,
    input: SendInput<z.infer<P>>,
  ): Promise<{ id: string; created: boolean }> {
    if ((def.serialPerAccount || def.perAccountCap !== undefined) && !input.channelAccountId) {
      throw new Error(`Job type ${def.type} needs a channel account`);
    }
    const envelope = parseEnvelope(def, {
      workspace_id: input.ctx.workspaceId,
      ...(input.channelAccountId ? { channel_account_id: input.channelAccountId } : {}),
      idempotency_key: input.idempotencyKey,
      attempt: 0,
      type: def.type,
      payload: input.payload,
    });
    const id = randomUUID();
    const result = await this.#records.createAndEnqueue(
      input.ctx,
      { id, type: def.type, idempotencyKey: input.idempotencyKey },
      async (db) => {
        const options: SendOptions = { id, db };
        if (def.serialPerAccount && input.channelAccountId) {
          options.singletonKey = input.channelAccountId;
        }
        if (def.perAccountCap !== undefined && input.channelAccountId) {
          options.group = { id: input.channelAccountId };
        }
        await this.#boss.send(def.type, envelope, options);
      },
    );
    this.#log.info(
      {
        event: result.created ? 'job.queued' : 'job.duplicate',
        workspaceId: input.ctx.workspaceId,
        jobId: result.id,
        jobName: def.type,
      },
      result.created ? 'job queued' : 'job already queued for this idempotency key',
    );
    return result;
  }

  /** Runs jobs of one type. The handler's return value is stored as the job's result. */
  async work<P extends z.ZodType>(
    def: JobDefinition<P>,
    handler: JobHandler<z.infer<P>>,
    tuning: WorkTuning = {},
  ): Promise<string> {
    if (def.perAccountCap !== undefined && this.#limiter === undefined) {
      throw new Error(`Job type ${def.type} has a perAccountCap, so the queue needs a limiter`);
    }
    const options: WorkOptions & { includeMetadata: true } = {
      ...tuning,
      batchSize: 1,
      includeMetadata: true,
      ...(def.perAccountCap === undefined ? {} : { groupConcurrency: def.perAccountCap }),
    };
    return this.#boss.work<unknown, unknown, typeof options>(
      def.type,
      options,
      async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) {
          await this.#gate?.enter();
          try {
            await this.#run(def, handler, job);
          } finally {
            this.#gate?.leave();
          }
        }
      },
    );
  }

  async #run<P extends z.ZodType>(
    def: JobDefinition<P>,
    handler: JobHandler<z.infer<P>>,
    job: JobWithMetadata<unknown>,
  ): Promise<void> {
    let envelope: JobEnvelope<z.infer<P>>;
    try {
      envelope = parseEnvelope(def, job.data);
    } catch (err) {
      // An envelope or payload that does not validate will never pass on a retry: send it straight
      // to the dead-letter queue (where it can be fixed and redriven) and mark its record failed.
      await this.#boss.send(deadLetterName(def), isPlainObject(job.data) ? job.data : {});
      await this.#failInvalid(def, job.data);
      this.#log.error(
        { event: 'job.invalid_envelope', jobId: job.id, jobName: def.type, err },
        'job data failed validation; moved to the dead-letter queue without retries',
      );
      return;
    }
    const ctx: TenantContext = { workspaceId: envelope.workspace_id };
    const key = { type: def.type, idempotencyKey: envelope.idempotency_key };
    const attempt = job.retryCount + 1;
    const fields = { workspaceId: ctx.workspaceId, jobId: job.id, jobName: def.type, attempt };
    const release = await this.#takeSlot(def, envelope, ctx, job);
    try {
      // Inside the try, so a failed update still releases the slot (F-M01-end-01).
      await this.#records.update(ctx, key, { state: 'active', attempt, errorCode: null });
      const result = await handler({
        envelope: { ...envelope, attempt },
        payload: envelope.payload,
        ctx,
        attempt,
        progress: (percent) =>
          this.#records.update(ctx, key, {
            state: 'active',
            percent: Math.max(0, Math.min(100, Math.round(percent))),
          }),
      });
      await this.#records.update(ctx, key, {
        state: 'completed',
        percent: 100,
        result: isPlainObject(result) ? result : null,
      });
      this.#log.info({ event: 'job.completed', ...fields }, 'job completed');
    } catch (err) {
      const last = job.retryCount >= job.retryLimit;
      await this.#records.update(ctx, key, {
        state: last ? 'failed' : 'retrying',
        errorCode: 'handler_failed',
      });
      this.#log.warn(
        { event: last ? 'job.dead_lettered' : 'job.retrying', ...fields, err },
        last ? 'job failed; moved to the dead-letter queue' : 'job failed; will retry',
      );
      throw err; // pg-boss retries, or moves the job to <type>.dlq after the last attempt
    } finally {
      await release();
    }
  }

  /** Marks the record of an invalid job failed, when the data still names its workspace and key. */
  async #failInvalid(def: JobDefinition, data: unknown): Promise<void> {
    if (!isPlainObject(data)) return;
    const { workspace_id: workspaceId, idempotency_key: idempotencyKey } = data;
    if (typeof workspaceId !== 'string' || typeof idempotencyKey !== 'string') return;
    await this.#records
      .update(
        { workspaceId },
        { type: def.type, idempotencyKey },
        {
          state: 'failed',
          errorCode: 'invalid_envelope',
        },
      )
      .catch(() => undefined);
  }

  /**
   * For capped job types, waits for one of the account's slots (OPS-10) and keeps its lease alive
   * while the job runs. pg-boss groupConcurrency already avoids most waits; this is the hard limit.
   * Returns the release function.
   */
  async #takeSlot(
    def: JobDefinition,
    envelope: { channel_account_id?: string | undefined },
    ctx: TenantContext,
    job: JobWithMetadata<unknown>,
  ): Promise<() => Promise<void>> {
    const limiter = this.#limiter;
    const cap = def.perAccountCap;
    if (cap === undefined || limiter === undefined) return () => Promise.resolve();
    const scope = `${def.type}:${envelope.channel_account_id ?? 'none'}`;
    const ttl = def.heartbeatSeconds * 2;
    const deadline = Date.now() + def.expireInSeconds * 1_000;
    while (!(await limiter.acquire(ctx, scope, cap, job.id, ttl))) {
      if (Date.now() > deadline)
        throw new Error(`No free slot for ${scope} before the job expired`);
      await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_MS));
    }
    const timer = setInterval(
      () => {
        limiter.renew(ctx, scope, job.id, ttl).catch((err: unknown) => {
          this.#log.warn(
            { event: 'job.lease_renew_failed', jobId: job.id, err },
            'lease renew failed',
          );
        });
      },
      (ttl * 1_000) / 2,
    );
    return async () => {
      clearInterval(timer);
      await limiter.release(ctx, scope, job.id);
    };
  }

  /** Moves every dead-lettered job of a type back to its queue (the redrive API, NFR-3). */
  async redrive(def: JobDefinition): Promise<number> {
    const count = await this.#boss.redrive(deadLetterName(def));
    this.#log.info(
      { event: 'job.redriven', jobName: def.type, count },
      'dead-lettered jobs redriven',
    );
    return count;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
