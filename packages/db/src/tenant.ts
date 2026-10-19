import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { MainDb } from './schema.ts';

/**
 * Runs `fn` in one transaction that has run `SET LOCAL app.workspace_id` (invariant 3), so
 * row-level security limits every statement to that workspace. Minimal for T-0104's job records
 * and progress route; T-0201 adds app.company_ids and the request and job wrappers.
 */
export function withTenantTransaction<T>(
  db: Kysely<MainDb>,
  ctx: TenantContext,
  fn: (trx: Transaction<MainDb>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`.execute(trx);
    return fn(trx);
  });
}
