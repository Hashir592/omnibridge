import type { Logger } from '@omnibridge/logger';
import type { PgBoss } from 'pg-boss';
import { deadLetterName } from './job.ts';
import type { JobRecordStore } from './runtime.ts';

/** One job type's queue in the console (PLAT-2): counts only. */
export interface QueueOverview {
  type: string;
  /** Waiting to run, deferred and retrying included. */
  queued: number;
  active: number;
  /** Failed jobs still kept by pg-boss (a rolling count of recent failures). */
  failed: number;
  /** Waiting in the dead-letter queue, where redrive can pick them up. */
  deadLetter: number;
}

/** A dead-lettered job: IDs and dates only, never its payload (invariant 7a, PLAT-3). */
export interface DeadLetter {
  /** The id of the copy in the dead-letter queue: what redrive takes. */
  id: string;
  type: string;
  workspaceId: string | null;
  /** Internal: joins the job record for its error code; never sent to the console. */
  idempotencyKey: string | null;
  deadLetteredAt: Date;
}

export type RedriveOutcome =
  { outcome: 'ok'; workspaceId: string | null } | { outcome: 'not_found' };

/**
 * The console's view of the queue (T-0504, PLAT-2): depth per job type, the dead-letter list and
 * the redrive of one job. Uses the sender's pg-boss in web (no supervisor, no cron, ADR-032).
 */
export class JobAdmin {
  readonly #boss: PgBoss;
  readonly #types: readonly string[];
  readonly #records: Pick<JobRecordStore, 'update'>;
  readonly #log: Logger;
  readonly #heartbeat: { schema: string; queue: string };

  constructor(options: {
    boss: PgBoss;
    /** The pg-boss schema and the worker's minute heartbeat queue (system health). */
    heartbeat: { schema: string; queue: string };
    /** The workspace job types (JOBS): the only queues the console shows and redrives. */
    types: readonly string[];
    records: Pick<JobRecordStore, 'update'>;
    logger: Logger;
  }) {
    this.#boss = options.boss;
    this.#types = options.types;
    this.#records = options.records;
    this.#log = options.logger.child({ component: 'job-admin' });
    if (!/^[a-z_][a-z0-9_]*$/.test(options.heartbeat.schema)) {
      throw new Error('The queue schema must be a plain identifier');
    }
    this.#heartbeat = options.heartbeat;
  }

  /** When the worker last finished its minute heartbeat job, or null if it never has. */
  async lastHeartbeat(): Promise<Date | null> {
    const { rows } = await this.#boss.getDb().executeSql(
      `SELECT max(completed_on) AS at FROM ${this.#heartbeat.schema}.job
        WHERE name = $1 AND state = 'completed'`,
      [this.#heartbeat.queue],
    );
    const at = (rows[0] as { at?: Date | string | null } | undefined)?.at ?? null;
    return at === null ? null : new Date(at);
  }

  /** Counts per job type, from pg-boss's cached queue counts (no job rows are counted). */
  async overview(): Promise<QueueOverview[]> {
    const names = this.#types.flatMap((type) => [type, deadLetterName({ type })]);
    if (names.length === 0) return [];
    const queues = new Map((await this.#boss.getQueues(names)).map((q) => [q.name, q]));
    return this.#types.map((type) => {
      const q = queues.get(type);
      return {
        type,
        queued: q?.queuedCount ?? 0,
        active: q?.activeCount ?? 0,
        failed: q?.failedCount ?? 0,
        deadLetter: queues.get(deadLetterName({ type }))?.queuedCount ?? 0,
      };
    });
  }

  /** The newest dead-lettered jobs across every type, at most `limit`. */
  async deadLetters(limit: number): Promise<DeadLetter[]> {
    if (this.#types.length === 0) return [];
    const byQueue = new Map(this.#types.map((type) => [deadLetterName({ type }), type]));
    // One query, newest first across every dead-letter queue (findJobs reads oldest first, per
    // queue). Only the envelope's workspace and key are read out of the job data.
    const { rows } = await this.#boss.getDb().executeSql(
      `SELECT id, name, created_on, data ->> 'workspace_id' AS workspace_id,
              data ->> 'idempotency_key' AS idempotency_key
         FROM ${this.#heartbeat.schema}.job
        WHERE name = ANY($1::text[]) AND state = 'created'
        ORDER BY created_on DESC, id DESC
        LIMIT $2`,
      [[...byQueue.keys()], Math.max(1, Math.min(limit, 1_000))],
    );
    return (
      rows as {
        id: string;
        name: string;
        created_on: Date | string;
        workspace_id: string | null;
        idempotency_key: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      type: byQueue.get(r.name) ?? r.name,
      workspaceId: r.workspace_id,
      idempotencyKey: r.idempotency_key,
      deadLetteredAt: new Date(r.created_on),
    }));
  }

  /**
   * Moves one dead-lettered job back to its queue (NFR-3) and marks its record queued again, so
   * it shows as waiting until the worker picks it up. The others stay where they are.
   */
  async redrive(type: string, id: string): Promise<RedriveOutcome> {
    if (!this.#types.includes(type)) return { outcome: 'not_found' };
    const dlq = deadLetterName({ type });
    const [job] = await this.#boss.findJobs<unknown>(dlq, { id, queued: true, limit: 1 });
    if (job === undefined) return { outcome: 'not_found' };
    const moved = await this.#boss.redrive(dlq, { ids: [id], limit: 1 });
    if (moved === 0) return { outcome: 'not_found' };
    const { workspaceId, idempotencyKey } = envelopeIds(job.data);
    if (workspaceId !== null && idempotencyKey !== null) {
      await this.#records
        .update(
          { workspaceId, companyIds: [] },
          { type, idempotencyKey },
          {
            state: 'queued',
            errorCode: null,
          },
        )
        .catch((err: unknown) => {
          // The job runs again anyway; its handler's own record updates take over.
          this.#log.warn(
            { event: 'job.record_update_failed', jobName: type, err },
            'record not reset',
          );
        });
    }
    this.#log.info({ event: 'job.redriven', jobName: type, jobId: id, count: 1 }, 'job redriven');
    return { outcome: 'ok', workspaceId };
  }
}

/** The workspace and idempotency key from a job envelope (invariant 19); null when absent. */
function envelopeIds(data: unknown): { workspaceId: string | null; idempotencyKey: string | null } {
  if (typeof data !== 'object' || data === null) return { workspaceId: null, idempotencyKey: null };
  const { workspace_id: workspaceId, idempotency_key: idempotencyKey } = data as Record<
    string,
    unknown
  >;
  return {
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
    idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
  };
}
