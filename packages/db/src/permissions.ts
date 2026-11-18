import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import type { Kysely } from 'kysely';
import { mapTenancyErrors } from './errors.ts';
import type { MainDb, MembershipRole } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** An invite is valid for 72 hours (TEN-7). */
export const INVITE_LIFETIME_MS = 72 * 60 * 60_000;

/** A member as the Users screen shows them: role and ticks (PERM-1 to PERM-4). */
export interface Member {
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
  /** Ticked tabs; empty for an admin, who sees every tab. */
  tabs: string[];
  /** Ticked companies; empty for an admin, who sees every company. */
  companyIds: string[];
}

export interface Access {
  role: MembershipRole;
  tabs: readonly string[];
  companyIds: readonly string[];
}

/** Roles and ticks of a workspace's members (T-0204). */
export class MemberAccessRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Whether the context's workspace has an admin yet (TEN-7: the platform invites only the first). */
  async hasAdmin(ctx: TenantContext): Promise<boolean> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('app.memberships')
        .select('user_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('role', '=', 'admin')
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  /** Every member of the context's workspace with their ticks, by name. */
  async list(ctx: TenantContext): Promise<Member[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const members = await trx
        .selectFrom('app.memberships as m')
        .innerJoin('app.users as u', 'u.id', 'm.user_id')
        .select(['u.id as userId', 'u.email', 'u.name', 'm.role'])
        .where('m.workspace_id', '=', ctx.workspaceId)
        .orderBy('u.name')
        .orderBy('u.id')
        .execute();
      const tabs = await trx
        .selectFrom('app.membership_tabs')
        .select(['user_id', 'tab'])
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('tab')
        .execute();
      const companies = await trx
        .selectFrom('app.membership_companies')
        .select(['user_id', 'company_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('company_id')
        .execute();
      return members.map((m) => ({
        ...m,
        tabs: tabs.filter((t) => t.user_id === m.userId).map((t) => t.tab),
        companyIds: companies.filter((c) => c.user_id === m.userId).map((c) => c.company_id),
      }));
    });
  }

  /**
   * Replaces a member's role and ticks (PERM-2). An admin keeps no ticks: they see everything.
   * Throws LastAdmin when this would leave the workspace without an admin (PERM-7). Returns false
   * when the user is not a member.
   */
  async set(ctx: TenantContext, userId: string, access: Access): Promise<boolean> {
    return mapTenancyErrors(() =>
      withTenantTransaction(this.#db, ctx, async (trx) => {
        const updated = await trx
          .updateTable('app.memberships')
          .set({ role: access.role })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (updated.numUpdatedRows === 0n) return false;
        await trx
          .deleteFrom('app.membership_tabs')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('user_id', '=', userId)
          .execute();
        await trx
          .deleteFrom('app.membership_companies')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('user_id', '=', userId)
          .execute();
        if (access.role !== 'admin') {
          if (access.tabs.length > 0) {
            await trx
              .insertInto('app.membership_tabs')
              .values(
                access.tabs.map((tab) => ({ workspace_id: ctx.workspaceId, user_id: userId, tab })),
              )
              .execute();
          }
          if (access.companyIds.length > 0) {
            await trx
              .insertInto('app.membership_companies')
              .values(
                access.companyIds.map((companyId) => ({
                  workspace_id: ctx.workspaceId,
                  user_id: userId,
                  company_id: companyId,
                })),
              )
              .execute();
          }
        }
        return true;
      }),
    );
  }

  /**
   * Removes a member from the workspace, with their ticks (PERM-2). Throws LastAdmin for the last
   * admin (PERM-7). Returns false when the user is not a member.
   */
  async remove(ctx: TenantContext, userId: string): Promise<boolean> {
    return mapTenancyErrors(() =>
      withTenantTransaction(this.#db, ctx, async (trx) => {
        const deleted = await trx
          .deleteFrom('app.memberships')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        return deleted.numDeletedRows > 0n;
      }),
    );
  }
}

export interface Invite {
  id: string;
  email: string;
  role: MembershipRole;
  tabs: string[];
  companyIds: string[];
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

/** Invitations to a workspace (USR-1, TEN-7). */
export class InviteRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** A new invite, valid 72 hours. A new child invite may carry no ticks at all (PERM-6). */
  async create(
    ctx: TenantContext,
    invite: {
      email: string;
      role: MembershipRole;
      tabs: readonly string[];
      companyIds: readonly string[];
    },
    now: Date,
  ): Promise<Invite> {
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS);
    const admin = invite.role === 'admin';
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .insertInto('app.invites')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          email: invite.email.trim().toLowerCase(),
          role: invite.role,
          tabs: admin ? [] : [...invite.tabs],
          company_ids: admin ? [] : [...invite.companyIds],
          invited_by: ctx.userId ?? null,
          token_hash: null,
          created_at: now,
          expires_at: expiresAt,
          revoked_at: null,
        })
        .execute(),
    );
    const created = await this.get(ctx, id);
    if (created === undefined) throw new Error('invite vanished after insert');
    return created;
  }

  async get(ctx: TenantContext, id: string): Promise<Invite | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('app.invites')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toInvite(row);
    });
  }

  /** Invites not yet accepted or revoked, newest first (expired ones included, marked by date). */
  async pending(ctx: TenantContext): Promise<Invite[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) =>
      (
        await trx
          .selectFrom('app.invites')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('accepted_at', 'is', null)
          .where('revoked_at', 'is', null)
          .orderBy('created_at', 'desc')
          .execute()
      ).map(toInvite),
    );
  }

  /** Revokes an open invite; false when it is unknown, accepted or already revoked. */
  async revoke(ctx: TenantContext, id: string, now: Date): Promise<boolean> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const r = await trx
        .updateTable('app.invites')
        .set({ revoked_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    });
  }

  /** The worker stores the hash of the token it is about to mail; a retry replaces it. */
  async setToken(ctx: TenantContext, id: string, tokenHash: Buffer): Promise<boolean> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const r = await trx
        .updateTable('app.invites')
        .set({ token_hash: tokenHash })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    });
  }
}

function toInvite(row: {
  id: string;
  email: string;
  role: MembershipRole;
  tabs: string[];
  company_ids: string[];
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}): Invite {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    tabs: row.tabs,
    companyIds: row.company_ids,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

/** An access review is due every 90 days per workspace (USR-9). */
export const ACCESS_REVIEW_INTERVAL_MS = 90 * 24 * 60 * 60_000;

export interface AccessReview {
  id: string;
  dueAt: Date;
  createdAt: Date;
  completedAt: Date | null;
  completedBy: string | null;
}

/** The quarterly access review (USR-9). */
export class AccessReviewRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /**
   * Creates the next review when the newest one is 90 days old or there is none yet; returns it,
   * or undefined when one is not due. Safe to run every day.
   */
  async ensureDue(ctx: TenantContext, now: Date): Promise<AccessReview | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const newest = await trx
        .selectFrom('app.access_reviews')
        .select('created_at')
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (
        newest !== undefined &&
        now.getTime() - newest.created_at.getTime() < ACCESS_REVIEW_INTERVAL_MS
      ) {
        return undefined;
      }
      const review = {
        workspace_id: ctx.workspaceId,
        id: randomUUID(),
        due_at: new Date(now.getTime() + 14 * 24 * 60 * 60_000),
        created_at: now,
        completed_at: null,
        completed_by: null,
      };
      await trx.insertInto('app.access_reviews').values(review).execute();
      return toReview(review);
    });
  }

  async list(ctx: TenantContext): Promise<AccessReview[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) =>
      (
        await trx
          .selectFrom('app.access_reviews')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .orderBy('created_at', 'desc')
          .execute()
      ).map(toReview),
    );
  }

  /** Completes an open review; false when it is unknown or already done. */
  async complete(ctx: TenantContext, id: string, userId: string, now: Date): Promise<boolean> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const r = await trx
        .updateTable('app.access_reviews')
        .set({ completed_at: now, completed_by: userId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('completed_at', 'is', null)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    });
  }
}

function toReview(row: {
  id: string;
  due_at: Date;
  created_at: Date;
  completed_at: Date | null;
  completed_by: string | null;
}): AccessReview {
  return {
    id: row.id,
    dueAt: row.due_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
  };
}
