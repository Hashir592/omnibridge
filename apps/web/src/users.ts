/**
 * Users, invites and the access review (T-0204: USR-1, USR-8, USR-9, PERM-1 to PERM-7, TEN-7).
 * Every route here is admin-only on the Users tab; the contract layer has already checked that
 * the caller is an admin of this workspace, in the request's own transaction.
 */
import { ApiError, type TenantContext, type TenantRunner } from '@omnibridge/core';
import type { userRoutes } from '@omnibridge/contract';
import {
  LastAdmin,
  type AccessReviewRepository,
  type AuditLog,
  type AuthStore,
  type Invite,
  type InviteRepository,
  type MemberAccessRepository,
  type WorkspaceRepository,
} from '@omnibridge/db';
import type { AuthService } from './auth/service.ts';
import type { AuthNotifier } from './auth/service.ts';
import type { Handlers } from './contract.ts';

export interface PeopleOptions {
  members: MemberAccessRepository;
  invites: InviteRepository;
  reviews: AccessReviewRepository;
  workspaces: Pick<WorkspaceRepository, 'get'>;
  store: Pick<AuthStore, 'memberAuthStatus' | 'revokeUserSessions'>;
  notifier: Pick<AuthNotifier, 'invite'>;
  audit: Pick<AuditLog, 'record'>;
  tenancy: TenantRunner;
  now?: () => Date;
}

const notFound = () => new ApiError({ status: 404, code: 'not_found' });
const unavailable = () =>
  Promise.reject(new ApiError({ status: 503, code: 'service_unavailable' }));
const toApiRole = (role: 'admin' | 'member'): 'admin' | 'child' =>
  role === 'admin' ? 'admin' : 'child';
const toDbRole = (role: 'admin' | 'child'): 'admin' | 'member' =>
  role === 'admin' ? 'admin' : 'member';

/**
 * Ticked companies must be companies of this workspace (the admin's scope holds them all). One
 * that is not is answered like any id of another workspace: not found (TEN-1).
 */
function checkCompanies(tenant: TenantContext, ids: readonly string[]): void {
  if (ids.some((id) => !tenant.companyIds.includes(id))) {
    throw new ApiError({ status: 404, code: 'not_found', detail: 'No such company here' });
  }
}

/** PERM-7 as an answer: the workspace must keep an admin. */
async function keepingAnAdmin<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LastAdmin) {
      throw new ApiError({
        status: 409,
        code: 'conflict',
        detail: 'A workspace needs at least one admin. Make someone else an admin first.',
      });
    }
    throw error;
  }
}

function invitedUser(invite: Invite) {
  return {
    id: invite.id,
    name: invite.email,
    email: invite.email,
    role: toApiRole(invite.role),
    tabs: invite.tabs,
    companyIds: invite.companyIds,
    mfa: false,
    state: 'invited' as const,
    lastSignInAt: null,
    inviteExpiresAt: invite.expiresAt.toISOString(),
  };
}

export function peopleHandlers(
  people: PeopleOptions | undefined,
  auth: AuthService | undefined,
): Handlers<typeof userRoutes> {
  const now = () => (people?.now ?? (() => new Date()))();
  const record = (
    ctx: TenantContext,
    userId: string,
    action:
      | 'user.invited'
      | 'user.removed'
      | 'user.role_changed'
      | 'user.permissions_changed'
      | 'user.access_review_completed',
    entityId: string,
    ip: string,
    change: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {},
  ) =>
    people?.audit.record(ctx, {
      action,
      actor: { kind: 'user', userId },
      entityId,
      ...change,
      ip,
    });

  if (people === undefined) {
    return {
      listUsers: unavailable,
      inviteUser: unavailable,
      revokeInvite: unavailable,
      setUserAccess: unavailable,
      removeUser: unavailable,
      listAccessReviews: unavailable,
      completeAccessReview: unavailable,
      inviteFirstAdmin: unavailable,
      getInvite: unavailable,
      acceptInvite: unavailable,
    };
  }
  const p = people;

  return {
    listUsers: async ({ tenant }) => {
      const [members, status, pending] = await Promise.all([
        p.members.list(tenant),
        p.store.memberAuthStatus(tenant),
        p.invites.pending(tenant),
      ]);
      const memberEmails = new Set(members.map((m) => m.email));
      return {
        status: 200,
        body: [
          ...members.map((m) => ({
            id: m.userId,
            name: m.name,
            email: m.email,
            role: toApiRole(m.role),
            tabs: m.tabs,
            companyIds: m.companyIds,
            mfa: status.get(m.userId)?.mfa ?? false,
            state: 'active' as const,
            lastSignInAt: status.get(m.userId)?.lastSignInAt?.toISOString() ?? null,
            inviteExpiresAt: null,
          })),
          ...pending.filter((i) => !memberEmails.has(i.email)).map(invitedUser),
        ],
      };
    },

    inviteUser: async ({ tenant, session, body, request }) => {
      checkCompanies(tenant, body.companyIds);
      const email = body.email.trim().toLowerCase();
      if ((await p.members.list(tenant)).some((m) => m.email === email)) {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'This person is already a member of this workspace',
        });
      }
      const invite = await p.invites.create(
        tenant,
        {
          email: body.email,
          role: toDbRole(body.role),
          tabs: body.tabs,
          companyIds: body.companyIds,
        },
        now(),
      );
      await record(tenant, session.userId, 'user.invited', invite.id, request.ip, {
        after: {
          role: invite.role,
          tabs: invite.tabs,
          company_ids: invite.companyIds,
          expires_at: invite.expiresAt.toISOString(),
        },
      });
      await p.notifier.invite({ workspaceId: tenant.workspaceId, inviteId: invite.id });
      return { status: 201, body: invitedUser(invite) };
    },

    revokeInvite: async ({ tenant, params }) => {
      if (!(await p.invites.revoke(tenant, params.inviteId, now()))) throw notFound();
      return { status: 204, body: null };
    },

    setUserAccess: async ({ tenant, session, params, body, request }) => {
      const before = (await p.members.list(tenant)).find((m) => m.userId === params.userId);
      if (before === undefined) throw notFound();
      checkCompanies(tenant, body.companyIds);
      const role = toDbRole(body.role);
      const access = {
        role,
        tabs: role === 'admin' ? [] : body.tabs,
        companyIds: role === 'admin' ? [] : body.companyIds,
      };
      await keepingAnAdmin(() => p.members.set(tenant, params.userId, access));
      if (before.role !== role) {
        await record(tenant, session.userId, 'user.role_changed', params.userId, request.ip, {
          before: { role: before.role },
          after: { role },
        });
      }
      await record(tenant, session.userId, 'user.permissions_changed', params.userId, request.ip, {
        before: { tabs: before.tabs, company_ids: before.companyIds },
        after: { tabs: [...access.tabs], company_ids: [...access.companyIds] },
      });
      // Their open sessions end now, so nothing runs on the old permissions (USR-8).
      await p.store.revokeUserSessions(params.userId, now());
      return { status: 204, body: null };
    },

    removeUser: async ({ tenant, session, params, request }) => {
      const before = (await p.members.list(tenant)).find((m) => m.userId === params.userId);
      if (before === undefined) throw notFound();
      await keepingAnAdmin(() => p.members.remove(tenant, params.userId));
      await record(tenant, session.userId, 'user.removed', params.userId, request.ip, {
        before: { role: before.role },
      });
      await p.store.revokeUserSessions(params.userId, now());
      return { status: 204, body: null };
    },

    listAccessReviews: async ({ tenant }) => ({
      status: 200,
      body: (await p.reviews.list(tenant)).map((r) => ({
        id: r.id,
        dueAt: r.dueAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
      })),
    }),

    completeAccessReview: async ({ tenant, session, params, request }) => {
      if (!(await p.reviews.complete(tenant, params.reviewId, session.userId, now()))) {
        throw notFound();
      }
      await record(
        tenant,
        session.userId,
        'user.access_review_completed',
        params.reviewId,
        request.ip,
      );
      return { status: 204, body: null };
    },

    inviteFirstAdmin: async ({ platform, params, body, request }) => {
      const invite = await p.tenancy.run(
        { workspaceId: params.workspaceId, companyIds: [], userId: platform.userId },
        async (ctx) => {
          if ((await p.workspaces.get(ctx)) === undefined) return undefined;
          const created = await p.invites.create(
            ctx,
            { email: body.email, role: 'admin', tabs: [], companyIds: [] },
            now(),
          );
          await p.audit.record(ctx, {
            action: 'user.invited',
            actor: { kind: 'platform', userId: platform.userId },
            entityId: created.id,
            after: {
              role: created.role,
              tabs: [],
              company_ids: [],
              expires_at: created.expiresAt.toISOString(),
            },
            ip: request.ip,
          });
          return created;
        },
      );
      if (invite === undefined) throw notFound();
      await p.notifier.invite({ workspaceId: params.workspaceId, inviteId: invite.id });
      return { status: 201, body: { id: invite.id } };
    },

    getInvite: async ({ params }) => {
      if (auth === undefined) return unavailable();
      return {
        status: 200,
        body: await auth.inviteInfo(params.token),
        headers: { 'cache-control': 'no-store' },
      };
    },

    acceptInvite: async ({ body, request }) => {
      if (auth === undefined) return unavailable();
      const { body: result, cookies } = await auth.acceptInvite(body, request.ip);
      return {
        status: 200,
        body: result,
        headers: { 'cache-control': 'no-store', 'set-cookie': cookies },
      };
    },
  };
}
