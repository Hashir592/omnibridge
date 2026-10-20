import type { TenantContext } from '@omnibridge/core';
import type { Kysely } from 'kysely';
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

  /** Throws WorkspaceLimitReached when max_users is set and reached (TEN-10). */
  async add(ctx: TenantContext, member: { userId: string; role: MembershipRole }): Promise<void> {
    await mapTenancyErrors(() =>
      withTenantTransaction(this.#db, ctx, (trx) =>
        trx
          .insertInto('app.memberships')
          .values({ workspace_id: ctx.workspaceId, user_id: member.userId, role: member.role })
          .execute(),
      ),
    );
  }
}
