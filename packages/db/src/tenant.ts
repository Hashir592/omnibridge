import type { TenantActor, TenantContext, TenantRunner } from '@omnibridge/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { MainDb } from './schema.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Contexts handed out by `Tenancy`, each bound to its open transaction. A repository called with
 * one joins that transaction, so a request or a job runs in exactly one (invariant 3), whichever
 * Kysely instance the repository holds. The entry is removed when the transaction ends; a context
 * kept after that opens a fresh transaction for the same tenant.
 */
const bound = new WeakMap<TenantContext, Transaction<MainDb>>();

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new Error(`${what} must be a lower-case UUID`);
}

function assertContext(ctx: TenantContext): void {
  assertUuid(ctx.workspaceId, 'workspaceId');
  for (const id of ctx.companyIds) assertUuid(id, 'companyIds');
  if (ctx.userId !== undefined) assertUuid(ctx.userId, 'userId');
}

/** `{uuid,uuid}`: the text form of a uuid[] that the company policies cast. */
function companyList(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

async function setTenant(trx: Transaction<MainDb>, ctx: TenantContext): Promise<void> {
  await sql`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true),
                   set_config('app.company_ids', ${companyList(ctx.companyIds)}, true),
                   set_config('app.user_id', ${ctx.userId ?? ''}, true)`.execute(trx);
}

function freeze(ctx: TenantContext): TenantContext {
  return Object.freeze({
    workspaceId: ctx.workspaceId,
    companyIds: Object.freeze([...ctx.companyIds]),
    ...(ctx.userId === undefined ? {} : { userId: ctx.userId }),
  });
}

async function runBound<T>(
  trx: Transaction<MainDb>,
  ctx: TenantContext,
  fn: (ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const scoped = freeze(ctx);
  bound.set(scoped, trx);
  try {
    return await fn(scoped);
  } finally {
    bound.delete(scoped);
  }
}

/**
 * Runs `fn` in a transaction that has run `SET LOCAL app.workspace_id`, `app.company_ids` and
 * `app.user_id` for `ctx` (invariant 3), so row-level security limits every statement to that
 * tenant. With a context from `Tenancy` it joins that context's transaction instead.
 */
export function withTenantTransaction<T>(
  db: Kysely<MainDb>,
  ctx: TenantContext,
  fn: (trx: Transaction<MainDb>) => Promise<T>,
): Promise<T> {
  const joined = bound.get(ctx);
  if (joined !== undefined) return fn(joined);
  assertContext(ctx);
  return db.transaction().execute(async (trx) => {
    await setTenant(trx, ctx);
    return fn(trx);
  });
}

/**
 * Opens the one transaction of a request or a job (TEN-1, invariant 3) and builds its context.
 * Used by the web request plugin, the job wrapper and the platform routes.
 */
export class Tenancy implements TenantRunner {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  run<T>(ctx: TenantContext, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
    const joined = bound.get(ctx);
    if (joined !== undefined) return fn(ctx);
    assertContext(ctx);
    return this.#db.transaction().execute(async (trx) => {
      await setTenant(trx, ctx);
      return runBound(trx, ctx, fn);
    });
  }

  runWorkspace<T>(actor: TenantActor, fn: (ctx: TenantContext) => Promise<T>): Promise<T> {
    const first: TenantContext = {
      workspaceId: actor.workspaceId,
      companyIds: [],
      ...(actor.userId === undefined ? {} : { userId: actor.userId }),
    };
    assertContext(first);
    return this.#db.transaction().execute(async (trx) => {
      await setTenant(trx, first);
      // Every company of this workspace, read by a SECURITY DEFINER function, then set as an
      // explicit list: never a wildcard (S1, 20 Oct 2026).
      const { rows } = await sql<{
        ids: string[];
      }>`SELECT app.workspace_company_ids() AS ids`.execute(trx);
      const ctx: TenantContext = { ...first, companyIds: rows[0]?.ids ?? [] };
      await setTenant(trx, ctx);
      return runBound(trx, ctx, fn);
    });
  }
}
