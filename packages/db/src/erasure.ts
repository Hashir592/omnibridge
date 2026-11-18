import type { ErasureWithdrawReason, TenantContext } from '@omnibridge/core';
import type { Kysely, Selectable } from 'kysely';
import type { ErasureRequestsTable, MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

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
  state: 'open' | 'confirmed' | 'withdrawn';
  confirmedBy: string | null;
  confirmedAt: Date | null;
  jobId: string | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  withdrawReason: ErasureWithdrawReason | null;
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

  /** Marks an open request confirmed; undefined when it is not open (confirmed or withdrawn). */
  async confirm(
    ctx: TenantContext,
    id: string,
    input: { by: string; at: Date; jobId: string | null },
  ): Promise<ErasureRequest | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .updateTable('app.erasure_requests')
        .set({
          state: 'confirmed',
          confirmed_by: input.by,
          confirmed_at: input.at,
          job_id: input.jobId,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('state', '=', 'open')
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRequest(row);
    });
  }
}
