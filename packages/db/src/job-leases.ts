import type { TenantContext } from '@omnibridge/core';
import type { ConcurrencyLimiter } from '@omnibridge/queue';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/**
 * The PostgreSQL semaphore behind per-account caps (OPS-10): a job runs only while it holds one of
 * `cap` lease slots for its scope. Each slot is one row; taking it is a single upsert that only
 * succeeds when the row is free or its lease has expired, so two workers can never hold one slot.
 */
export class JobLeaseRepository implements ConcurrencyLimiter {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  acquire(
    ctx: TenantContext,
    scopeKey: string,
    cap: number,
    holder: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      for (let slot = 0; slot < cap; slot += 1) {
        const taken = await trx
          .insertInto('app.job_leases')
          .values({
            workspace_id: ctx.workspaceId,
            scope_key: scopeKey,
            slot,
            holder,
            expires_at: sql<Date>`now() + make_interval(secs => ${ttlSeconds})`,
          })
          .onConflict((oc) =>
            oc
              .columns(['workspace_id', 'scope_key', 'slot'])
              .doUpdateSet((eb) => ({
                holder: eb.ref('excluded.holder'),
                expires_at: eb.ref('excluded.expires_at'),
              }))
              .where('app.job_leases.expires_at', '<', sql<Date>`now()`),
          )
          .returning('slot')
          .executeTakeFirst();
        if (taken !== undefined) return true;
      }
      return false;
    });
  }

  async renew(
    ctx: TenantContext,
    scopeKey: string,
    holder: string,
    ttlSeconds: number,
  ): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.job_leases')
        .set({ expires_at: sql<Date>`now() + make_interval(secs => ${ttlSeconds})` })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('scope_key', '=', scopeKey)
        .where('holder', '=', holder)
        .execute(),
    );
  }

  async release(ctx: TenantContext, scopeKey: string, holder: string): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .deleteFrom('app.job_leases')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('scope_key', '=', scopeKey)
        .where('holder', '=', holder)
        .execute(),
    );
  }
}
