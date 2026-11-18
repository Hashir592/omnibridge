import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** One deletion run as db-main keeps it (DEL-3): never a value. */
export interface DeletionRun {
  id: string;
  trigger: string;
  scopeType: string;
  /** The scope's IDs as the job carried them (subject ids, a channel account). */
  scope: unknown;
  channelAccountId: string | null;
  recordsDeleted: number;
  startedAt: Date;
  finishedAt: Date;
}

/** What a deletion certificate shows for one channel account (DEL-3). */
export interface DeletionCertificate {
  channelAccountId: string;
  /** Records of this account deleted by any run, expiry included. */
  recordsDeleted: number;
  /** Runs aimed at this account (revocation, termination, eBay account deletion). */
  runs: DeletionRun[];
}

/**
 * The db-main half of the deletion service (T-0403): the run log and the db-main copy of every
 * tombstone (invariant 10). Both are append-only for the app and hold IDs and counts only.
 */
export class DeletionLog {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /**
   * Records a run and its tombstones in one transaction. A retried job writes the same run id
   * again: nothing is duplicated, and tombstones the earlier attempt missed are added.
   */
  async record(
    ctx: TenantContext,
    run: Omit<DeletionRun, 'recordsDeleted'>,
    tombstones: readonly { piiRef: string; channelAccountId: string | null }[],
  ): Promise<void> {
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await trx
        .insertInto('app.deletion_runs')
        .values({
          workspace_id: ctx.workspaceId,
          id: run.id,
          trigger: run.trigger,
          scope_type: run.scopeType,
          scope: JSON.stringify(run.scope),
          channel_account_id: run.channelAccountId,
          records_deleted: tombstones.length,
          result: 'done',
          started_at: run.startedAt,
          finished_at: run.finishedAt,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      if (tombstones.length === 0) return;
      await trx
        .insertInto('app.pii_tombstones')
        .values(
          tombstones.map((t) => ({
            workspace_id: ctx.workspaceId,
            pii_ref: t.piiRef,
            run_id: run.id,
            channel_account_id: t.channelAccountId,
            deleted_at: run.finishedAt,
          })),
        )
        .onConflict((oc) => oc.columns(['workspace_id', 'pii_ref']).doNothing())
        .execute();
    });
  }

  /** Every tombstoned ref of the workspace (the restore runbook re-applies them, T-0405). */
  async tombstones(ctx: TenantContext): Promise<string[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) =>
      (
        await trx.selectFrom('app.pii_tombstones').select('pii_ref').orderBy('pii_ref').execute()
      ).map((r) => r.pii_ref),
    );
  }

  async runs(ctx: TenantContext): Promise<DeletionRun[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) =>
      (await trx.selectFrom('app.deletion_runs').selectAll().orderBy('finished_at').execute()).map(
        toRun,
      ),
    );
  }

  /** DEL-3: the deletion certificate of one channel account: counts and run IDs, never a value. */
  async certificate(ctx: TenantContext, channelAccountId: string): Promise<DeletionCertificate> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const count = await trx
        .selectFrom('app.pii_tombstones')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('channel_account_id', '=', channelAccountId)
        .executeTakeFirstOrThrow();
      const runs = await trx
        .selectFrom('app.deletion_runs')
        .selectAll()
        .where('channel_account_id', '=', channelAccountId)
        .orderBy('finished_at')
        .execute();
      return { channelAccountId, recordsDeleted: Number(count.n), runs: runs.map(toRun) };
    });
  }

  /**
   * ADR-058(b): a person's terms acceptances go with them. Refused while they still belong to a
   * workspace. As ob_worker (the deletion jobs).
   */
  async deleteUserTerms(userId: string): Promise<number> {
    const { rows } = await sql<{
      n: string;
    }>`SELECT app.user_terms_delete(${userId}::uuid) AS n`.execute(this.#db);
    return Number(rows[0]?.n ?? '0');
  }
}

function toRun(r: {
  id: string;
  trigger: string;
  scope_type: string;
  scope: unknown;
  channel_account_id: string | null;
  records_deleted: string;
  started_at: Date;
  finished_at: Date;
}): DeletionRun {
  return {
    id: r.id,
    trigger: r.trigger,
    scopeType: r.scope_type,
    scope: r.scope,
    channelAccountId: r.channel_account_id,
    recordsDeleted: Number(r.records_deleted),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}
