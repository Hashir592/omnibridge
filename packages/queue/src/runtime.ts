import { randomUUID } from 'node:crypto';
import type { TenantContext, TenantRunner } from '@omnibridge/core';
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
    record: { id: string; type: string; idempotencyKey: string; companyId?: string | undefined },
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
  /**
   * The workspace of the job. A context bound to an open transaction (a request's `tenant`)
   * makes the job record and the pg-boss job part of that transaction (A-002, ADR-069): the
   * worker sees the job only once the request commits, and never if it rolls back.
   */
  ctx: TenantContext;
  channelAccountId?: string;
  /** The one company the job belongs to, if any: web shows it only with that company in scope. */
  companyId?: string;
  idempotencyKey: string;
  payload: T;
}

export interface RunningJob<T> {
  /** The job's id: its job record's and pg-boss's, the one `send` returned. */
  readonly jobId: string;
  readonly envelope: JobEnvelope<T>;
  readonly payload: T;
  /**
   * The job's tenant context, bound to the one transaction the handler runs in (invariant 3):
   * every repository call made with it joins that transaction, which commits when the handler
   * resolves and rolls back when it throws.
   */
  readonly ctx: TenantContext;
  /** 1 on the first run, 2 on the first retry, and so on. */
  readonly attempt: number;
  /** Records progress for GET /jobs/{id} (NFR-4); commits at once, outside the job's transaction. */
  progress(percent: number): Promise<void>;
}

/** A handler resolves with its result: a plain object is stored for GET /jobs/:id, anything else as null. */
export type JobHandler<T> = (job: RunningJob<T>) => Promise<unknown>;

/** A job before its tenant transaction opens: no `ctx`, so no repository call can be made. */
export type PreparingJob<T> = Omit<RunningJob<T>, 'ctx'>;

/**
 * A job that calls out over the network (the vault, SMTP) before it writes to db-main (invariant
 * 3, F-M04h-05): `prepare` runs with no db-main transaction open, then `commit` runs in the
 * job's one tenant transaction with what `prepare` returned. Either may throw for a retry, so
 * both must be idempotent (invariant 19).
 */
export interface PhasedHandler<T, O> {
  prepare(job: PreparingJob<T>): Promise<O>;
  commit(job: RunningJob<T>, prepared: O): Promise<unknown>;
  /**
   * A-006 (ADR-069): called once, after the job's last attempt failed (it then goes to the
   * dead-letter queue), in a short tenant transaction of its own, so the work the job stands for
   * can record that it failed. Its own failure is logged and never replaces the job's error.
   */
  failed?(job: RunningJob<T>, err: unknown): Promise<void>;
}

/** Options a caller may tune per worker; the rest is fixed by the job definition. */
export type WorkTuning = Pick<WorkOptions, 'localConcurrency' | 'pollingIntervalSeconds'>;

/**
 * Sends and runs workspace jobs through pg-boss (ADR-009) with the envelope of invariant 19,
 * idempotency keys, per-account ordering or caps, progress records and dead-letter redrive.
 *
 * Each handler runs in one tenant transaction opened from its envelope (TEN-1, invariant 3).
 * The job record and lease bookkeeping run in their own short tenant transactions instead, so
 * progress and slots are visible while the job runs (PS-017). Give them a pool of their own, so
 * they never wait behind handler connections.
 */
export class JobQueue {
  readonly #boss: PgBoss;
  readonly #records: JobRecordStore;
  readonly #tenancy: TenantRunner;
  readonly #limiter: ConcurrencyLimiter | undefined;
  readonly #gate: Gate | undefined;
  readonly #log: Logger;

  constructor(options: {
    boss: PgBoss;
    records: JobRecordStore;
    /** Opens the one tenant transaction each handler runs in. */
    tenancy: TenantRunner;
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
    this.#tenancy = options.tenancy;
    this.#limiter = options.limiter;
    this.#log = options.logger.child({ component: 'queue' });
  }

  /** Enqueues a job once per (workspace, type, idempotency key). A repeat returns the first id. */
  async send<P extends z.ZodType>(
    def: JobDefinition<P>,
    input: SendInput<z.infer<P>>,
  ): Promise<{ id: string; created: boolean }> {
    // A request can tie a job only to a company in its own scope (F-M02e-03); web could not show it.
    if (
      input.companyId !== undefined &&
      input.ctx.userId !== undefined &&
      !input.ctx.companyIds.includes(input.companyId)
    ) {
      throw new Error(`Job type ${def.type}: company is outside the caller's scope`);
    }
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
      { id, type: def.type, idempotencyKey: input.idempotencyKey, companyId: input.companyId },
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

  /**
   * Runs jobs of one type. The handler's return value (a phased handler's `commit` value) is
   * stored as the job's result.
   */
  async work<P extends z.ZodType, O = never>(
    def: JobDefinition<P>,
    handler: JobHandler<z.infer<P>> | PhasedHandler<z.infer<P>, O>,
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

  async #run<P extends z.ZodType, O>(
    def: JobDefinition<P>,
    handler: JobHandler<z.infer<P>> | PhasedHandler<z.infer<P>, O>,
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
    // For the bookkeeping only: job records and leases carry no company data.
    const ctx: TenantContext = { workspaceId: envelope.workspace_id, companyIds: [] };
    const key = { type: def.type, idempotencyKey: envelope.idempotency_key };
    const attempt = job.retryCount + 1;
    const fields = { workspaceId: ctx.workspaceId, jobId: job.id, jobName: def.type, attempt };
    const release = await this.#takeSlot(def, envelope, ctx, job);
    try {
      // Inside the try, so a failed update still releases the slot (F-M01-end-01).
      await this.#records.update(ctx, key, { state: 'active', attempt, errorCode: null });
      const base: PreparingJob<z.infer<P>> = {
        jobId: job.id,
        envelope: { ...envelope, attempt },
        payload: envelope.payload,
        attempt,
        progress: (percent) =>
          this.#records.update(ctx, key, {
            state: 'active',
            percent: Math.max(0, Math.min(100, Math.round(percent))),
          }),
      };
      let result: unknown;
      if (typeof handler === 'function') {
        result = await this.#tenancy.runWorkspace(
          { workspaceId: envelope.workspace_id },
          (tenant) => handler({ ...base, ctx: tenant }),
        );
      } else {
        // F-M04h-05: the network half first, with no db-main transaction open.
        const prepared = await handler.prepare(base);
        result = await this.#tenancy.runWorkspace(
          { workspaceId: envelope.workspace_id },
          (tenant) => handler.commit({ ...base, ctx: tenant }, prepared),
        );
      }
      await this.#records.update(ctx, key, {
        state: 'completed',
        percent: 100,
        result: isPlainObject(result) ? result : null,
      });
      this.#log.info({ event: 'job.completed', ...fields }, 'job completed');
    } catch (err) {
      const last = job.retryCount >= job.retryLimit;
      // Log first and never let a failed record update replace the handler's error.
      this.#log.warn(
        { event: last ? 'job.dead_lettered' : 'job.retrying', ...fields, err },
        last ? 'job failed; moved to the dead-letter queue' : 'job failed; will retry',
      );
      await this.#records
        .update(ctx, key, { state: last ? 'failed' : 'retrying', errorCode: 'handler_failed' })
        .catch((updateErr: unknown) => {
          this.#log.warn(
            { event: 'job.record_update_failed', ...fields, err: updateErr },
            'job record update failed',
          );
        });
      if (last && typeof handler !== 'function' && handler.failed !== undefined) {
        const failed = handler.failed.bind(handler);
        await this.#tenancy
          .runWorkspace({ workspaceId: envelope.workspace_id }, (tenant) =>
            failed(
              {
                jobId: job.id,
                envelope: { ...envelope, attempt },
                payload: envelope.payload,
                attempt,
                ctx: tenant,
                progress: () => Promise.resolve(),
              },
              err,
            ),
          )
          .catch((hookErr: unknown) => {
            this.#log.error(
              { event: 'job.failed_hook_failed', ...fields, err: hookErr },
              'job failure could not be recorded',
            );
          });
      }
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
        { workspaceId, companyIds: [] },
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
