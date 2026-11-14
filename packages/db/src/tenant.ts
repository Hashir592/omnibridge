import {
  isUuid,
  NotAMember,
  type MemberAccess,
  type TenantActor,
  type TenantContext,
  type TenantRunner,
} from '@omnibridge/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { MainDb } from './schema.ts';

/**
 * Contexts handed out by `Tenancy`, each bound to its open transaction. A repository called with
 * one joins that transaction, so a request or a job runs in exactly one (invariant 3), whichever
 * Kysely instance the repository holds.
 */
const bound = new WeakMap<TenantContext, Transaction<MainDb>>();

/**
 * Bound contexts whose transaction has ended. Using one is a bug (work that escaped its request
 * or job, such as an un-awaited write), so it throws instead of quietly opening a new transaction.
 */
const closed = new WeakSet<TenantContext>();

/** What is wrong with a context, or undefined when it may open a tenant transaction. */
function contextProblem(ctx: TenantContext): Error | undefined {
  if (closed.has(ctx)) {
    return new Error('This tenant context belongs to a transaction that has already ended');
  }
  const ids: [string, string][] = [
    ['workspaceId', ctx.workspaceId],
    ...ctx.companyIds.map((id): [string, string] => ['companyIds', id]),
    ...(ctx.userId === undefined ? [] : [['userId', ctx.userId] as [string, string]]),
  ];
  const bad = ids.find(([, value]) => !isUuid(value));
  return bad === undefined ? undefined : new Error(`${bad[0]} must be a lower-case UUID`);
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
    closed.add(scoped);
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
  const problem = contextProblem(ctx);
  if (problem !== undefined) return Promise.reject(problem);
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
    if (bound.has(ctx)) return fn(ctx);
    const problem = contextProblem(ctx);
    if (problem !== undefined) return Promise.reject(problem);
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
    const problem = contextProblem(first);
    if (problem !== undefined) return Promise.reject(problem);
    return this.#db.transaction().execute(async (trx) => {
      await setTenant(trx, first);
      // Every company of this workspace, read by a SECURITY DEFINER function and set as an
      // explicit list in the same statement: never a wildcard (S1, 20 Oct 2026).
      const { rows } = await sql<{ ids: string[] }>`
        SELECT ids, set_config('app.company_ids', ids::text, true)
          FROM (SELECT app.workspace_company_ids() AS ids) AS scope`.execute(trx);
      return runBound(trx, { ...first, companyIds: rows[0]?.ids ?? [] }, fn);
    });
  }

  runMember<T>(
    actor: { workspaceId: string; userId: string },
    fn: (ctx: TenantContext, access: MemberAccess) => Promise<T>,
  ): Promise<T> {
    const first: TenantContext = {
      workspaceId: actor.workspaceId,
      companyIds: [],
      userId: actor.userId,
    };
    const problem = contextProblem(first);
    if (problem !== undefined) return Promise.reject(problem);
    return this.#db.transaction().execute(async (trx) => {
      await setTenant(trx, first);
      // Role, ticks and app.company_ids in one definer call (0015): no row means not a member.
      const { rows } = await sql<{
        role: 'admin' | 'member';
        tabs: string[] | null;
        company_ids: string[];
      }>`SELECT role, tabs, company_ids FROM app.member_scope()`.execute(trx);
      const row = rows[0];
      if (row === undefined) throw new NotAMember();
      const access: MemberAccess = { role: row.role, tabs: row.tabs ?? 'all' };
      return runBound(trx, { ...first, companyIds: row.company_ids }, (ctx) => fn(ctx, access));
    });
  }
}
