import type { ErasureState, ErasureWithdrawReason, TenantContext } from '@omnibridge/core';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { ErasureRequestsTable, MainDb } from './schema.ts';
import { withOwnTenantTransaction, withTenantTransaction } from './tenant.ts';

/** DEL-4: an erasure request is due one calendar month after it was made. */
export function erasureDueAt(requestedAt: Date): Date {
  const due = new Date(requestedAt);
  const day = due.getUTCDate();
  due.setUTCMonth(due.getUTCMonth() + 1);
  // 31 January + 1 month is the end of February, not 3 March.
  if (due.getUTCDate() !== day) due.setUTCDate(0);
  return due;
}

export interface ErasureRequest {
  id: string;
  requestedBy: string;
  requestedAt: Date;
  dueAt: Date;
  piiRefs: string[];
  state: ErasureState;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  jobId: string | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  withdrawReason: ErasureWithdrawReason | null;
  /** A-006 (ADR-069): when its deletion ran, or when its last attempt failed. */
  completedAt: Date | null;
  failedAt: Date | null;
  /** How often an admin has retried a failed deletion. */
  retryCount: number;
}

const toRequest = (r: Selectable<ErasureRequestsTable>): ErasureRequest => ({
  id: r.id,
  requestedBy: r.requested_by,
  requestedAt: r.requested_at,
  dueAt: r.due_at,
  piiRefs: r.pii_refs,
  state: r.state,
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
  jobId: r.job_id,
  withdrawnBy: r.withdrawn_by,
  withdrawnAt: r.withdrawn_at,
  withdrawReason: r.withdraw_reason,
  completedAt: r.completed_at,
  failedAt: r.failed_at,
  retryCount: Number(r.retry_count),
});

/**
 * Erasure requests (T-0404, DEL-4): IDs only. The identifiers an admin entered are never stored;
 * the vault's matching refs are. Admins only, enforced by the database too (migration 0025).
 */
export class ErasureRequestRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async create(
    ctx: TenantContext,
    input: { id: string; requestedBy: string; piiRefs: readonly string[]; at: Date },
  ): Promise<ErasureRequest> {
    return withTenantTransaction(this.#db, ctx, async (trx) =>
      toRequest(
        await trx
          .insertInto('app.erasure_requests')
          .values({
            workspace_id: ctx.workspaceId,
            id: input.id,
            requested_by: input.requestedBy,
            requested_at: input.at,
            due_at: erasureDueAt(input.at),
            pii_refs: [...input.piiRefs],
            state: 'open',
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      ),
    );
  }

  async get(ctx: TenantContext, id: string): Promise<ErasureRequest | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('app.erasure_requests')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toRequest(row);
    });
  }

  /** Newest first. */
  async list(ctx: TenantContext): Promise<ErasureRequest[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) =>
      (
        await trx
          .selectFrom('app.erasure_requests')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .orderBy('requested_at', 'desc')
          .orderBy('id')
          .limit(500)
          .execute()
      ).map(toRequest),
    );
  }

  /**
   * ADR-067: closes an open request without deleting anything; undefined when it is not open
   * (confirmed or already withdrawn).
   */
  async withdraw(
    ctx: TenantContext,
    id: string,
    input: { by: string; at: Date; reason: ErasureWithdrawReason },
  ): Promise<ErasureRequest | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .updateTable('app.erasure_requests')
        .set({
          state: 'withdrawn',
          withdrawn_by: input.by,
          withdrawn_at: input.at,
          withdraw_reason: input.reason,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('state', '=', 'open')
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRequest(row);
    });
  }

  /**
   * Claims an open request for deletion (S5-20261118-02): marks it confirmed, with no job yet, in
   * a transaction of its own that commits before the caller queues the deletion, even inside a
   * request's transaction. From then on a withdraw finds it not open, so a request with a queued
   * deletion can never end up withdrawn. Undefined when it is not open.
   */
  async claim(
    ctx: TenantContext,
    id: string,
    input: { by: string; at: Date },
  ): Promise<ErasureRequest | undefined> {
    return withOwnTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .updateTable('app.erasure_requests')
        .set({ state: 'confirmed', confirmed_by: input.by, confirmed_at: input.at, job_id: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('state', '=', 'open')
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRequest(row);
    });
  }

  /**
   * A-006 (ADR-069): the deletion job `jobId` has run; the request it belongs to is completed.
   * Called by the job in its own tenant transaction (no user named). Only the request's current
   * job counts, so a late outcome of a replaced job changes nothing. False when none matched.
   */
  async complete(ctx: TenantContext, jobId: string, at: Date): Promise<boolean> {
    return this.#outcome(ctx, jobId, { state: 'completed', completed_at: at });
  }

  /** A-006: the last attempt of the deletion job `jobId` failed; an admin must retry. */
  async fail(ctx: TenantContext, jobId: string, at: Date): Promise<boolean> {
    return this.#outcome(ctx, jobId, { state: 'failed', failed_at: at });
  }

  async #outcome(
    ctx: TenantContext,
    jobId: string,
    set: { state: 'completed'; completed_at: Date } | { state: 'failed'; failed_at: Date },
  ): Promise<boolean> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const res = await trx
        .updateTable('app.erasure_requests')
        .set(set)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('job_id', '=', jobId)
        .where('state', '=', 'confirmed')
        .executeTakeFirst();
      return res.numUpdatedRows > 0n;
    });
  }

  /**
   * A-006: a confirmed request with no matches has nothing to delete and no job: it is completed
   * at once, so it never shows as in progress or overdue. Undefined when it is not such a request.
   */
  async completeEmpty(
    ctx: TenantContext,
    id: string,
    at: Date,
  ): Promise<ErasureRequest | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .updateTable('app.erasure_requests')
        .set({ state: 'completed', completed_at: at })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('state', '=', 'confirmed')
        .where('job_id', 'is', null)
        .where(sql<boolean>`cardinality(pii_refs) = 0`)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRequest(row);
    });
  }

  /**
   * A-006: an admin retries a failed request. In the request's own transaction: it goes back to
   * confirmed with no job (the caller queues a new run of the same refs and records it with
   * `setJob`), and the retry is counted. The row lock makes a second retry wait, then find it no
   * longer failed. Undefined when it is not failed.
   */
  async retry(ctx: TenantContext, id: string): Promise<ErasureRequest | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .updateTable('app.erasure_requests')
        .set({
          state: 'confirmed',
          failed_at: null,
          job_id: null,
          retry_count: sql<number>`retry_count + 1`,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('state', '=', 'failed')
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRequest(row);
    });
  }

  /** Records the queued deletion of a claimed request; undefined when it already has one. */
  async setJob(ctx: TenantContext, id: string, jobId: string): Promise<ErasureRequest | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .updateTable('app.erasure_requests')
        .set({ job_id: jobId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('state', '=', 'confirmed')
        .where((eb) => eb.or([eb('job_id', 'is', null), eb('job_id', '=', jobId)]))
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRequest(row);
    });
  }
}
