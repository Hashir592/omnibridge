import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import { mapTenancyErrors } from './errors.ts';
import type { MainDb, MembershipRole } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export interface User {
  id: string;
  email: string;
  name: string;
}

/**
 * app.users: one login per person across workspaces (USR-1, USR-2). A context sees only its own
 * user and the members of its workspace; passwords and MFA arrive with T-0203.
 */
export class UserRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Creates the user `ctx.userId`; the RLS check allows no other id. */
  async create(ctx: TenantContext, user: User): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .insertInto('app.users')
        .values({ id: user.id, email: user.email.toLowerCase(), name: user.name })
        .execute(),
    );
  }

  /** One user this context may see (itself or a member of its workspace), or undefined. */
  async get(ctx: TenantContext, id: string): Promise<User | undefined> {
    return withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.users')
        .select(['id', 'email', 'name'])
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** Every user this context may see: itself and the workspace's members. */
  async list(ctx: TenantContext): Promise<User[]> {
    return withTenantTransaction(this.#db, ctx, (trx) =>
      trx.selectFrom('app.users').select(['id', 'email', 'name']).orderBy('id').execute(),
    );
  }
}

/** app.memberships: which users belong to the workspace. Roles and ticks grow in T-0204. */
export class MembershipRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /**
   * A system write (the dev seed, platform tooling, tests): it never acts as `ctx.userId`, so the
   * database's admin-only rule for member writes (F-M02e-01, migration 0021) treats it like the
   * worker. No web route calls it: people join only through an invite (app.invite_accept).
   * Throws WorkspaceLimitReached when max_users is set and reached (TEN-10).
   */
  async add(ctx: TenantContext, member: { userId: string; role: MembershipRole }): Promise<void> {
    await mapTenancyErrors(() =>
      withTenantTransaction(this.#db, ctx, async (trx) => {
        // Not as ctx.userId: the user setting is cleared for this one insert, then put back, so the
        // rest of a surrounding transaction still runs as its user.
        const { rows } = await sql<{ user_id: string }>`
          SELECT current_setting('app.user_id', true) AS user_id`.execute(trx);
        await sql`SELECT set_config('app.user_id', '', true)`.execute(trx);
        await trx
          .insertInto('app.memberships')
          .values({ workspace_id: ctx.workspaceId, user_id: member.userId, role: member.role })
          .execute();
        await sql`SELECT set_config('app.user_id', ${rows[0]?.user_id ?? ''}, true)`.execute(trx);
      }),
    );
  }

  /** The admins of the context's workspace, with what an email to them needs (USR-5 notices). */
  async admins(ctx: TenantContext): Promise<User[]> {
    return withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.memberships as m')
        .innerJoin('app.users as u', 'u.id', 'm.user_id')
        .select(['u.id', 'u.email', 'u.name'])
        .where('m.workspace_id', '=', ctx.workspaceId)
        .where('m.role', '=', 'admin')
        .orderBy('u.id')
        .execute(),
    );
  }

  /** The role of `ctx.userId` in the context's workspace, or undefined when not a member. */
  async roleOf(ctx: TenantContext): Promise<MembershipRole | undefined> {
    const userId = ctx.userId;
    if (userId === undefined) return undefined;
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('app.memberships')
        .select('role')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row?.role;
    });
  }
}
