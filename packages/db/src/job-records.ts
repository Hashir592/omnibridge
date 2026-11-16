import type { TenantContext } from '@omnibridge/core';
import type { JobRecordPatch, JobRecordStore, JobState } from '@omnibridge/queue';
import type { Kysely } from 'kysely';
import { fromKysely, type Db } from 'pg-boss';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export interface JobProgress {
  id: string;
  type: string;
  state: JobState;
  attempt: number;
  percent: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * app.job_records: idempotency keys and progress of workspace jobs (NFR-3, NFR-4). The queue
 * package uses it through JobRecordStore; the web app reads progress with `get`.
 */
export class JobRecordRepository implements JobRecordStore {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  createAndEnqueue(
    ctx: TenantContext,
    record: { id: string; type: string; idempotencyKey: string },
    enqueue: (db: Db) => Promise<void>,
  ): Promise<{ id: string; created: boolean }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const inserted = await trx
        .insertInto('app.job_records')
        .values({
          id: record.id,
          workspace_id: ctx.workspaceId,
          type: record.type,
          idempotency_key: record.idempotencyKey,
        })
        .onConflict((oc) => oc.constraint('job_records_idempotency').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted === undefined) {
        const existing = await trx
          .selectFrom('app.job_records')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('type', '=', record.type)
          .where('idempotency_key', '=', record.idempotencyKey)
          .executeTakeFirstOrThrow();
        return { id: existing.id, created: false };
      }
      // pg-boss sends through this transaction, so the record and the job commit together.
      await enqueue(fromKysely(trx));
      return { id: record.id, created: true };
    });
  }

  async update(
    ctx: TenantContext,
    key: { type: string; idempotencyKey: string },
    patch: JobRecordPatch,
  ): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.job_records')
        .set({
          state: patch.state,
          updated_at: new Date(),
          ...(patch.attempt === undefined ? {} : { attempt: patch.attempt }),
          ...(patch.percent === undefined ? {} : { percent: patch.percent }),
          ...(patch.result === undefined
            ? {}
            : { result: patch.result === null ? null : JSON.stringify(patch.result) }),
          ...(patch.errorCode === undefined ? {} : { error_code: patch.errorCode }),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('type', '=', key.type)
        .where('idempotency_key', '=', key.idempotencyKey)
        .execute(),
    );
  }

  /**
   * Retention (F-M01-end-05): deletes this workspace's finished records (completed or failed)
   * last updated before `olderThan`, and its leases that expired before it. Queued, active and
   * retrying records and live leases stay. After this, an old idempotency key may be used again.
   */
  purge(ctx: TenantContext, olderThan: Date): Promise<{ records: number; leases: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const records = await trx
        .deleteFrom('app.job_records')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('state', 'in', ['completed', 'failed'])
        .where('updated_at', '<', olderThan)
        .executeTakeFirst();
      const leases = await trx
        .deleteFrom('app.job_leases')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('expires_at', '<', olderThan)
        .executeTakeFirst();
      return {
        records: Number(records.numDeletedRows),
        leases: Number(leases.numDeletedRows),
      };
    });
  }

  /** One job's progress, or undefined when it does not exist in this workspace. */
  async get(ctx: TenantContext, id: string): Promise<JobProgress | undefined> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.job_records')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      type: row.type,
      state: row.state,
      attempt: Number(row.attempt),
      percent: Number(row.percent),
      result: (row.result ?? null) as Record<string, unknown> | null,
      errorCode: row.error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
