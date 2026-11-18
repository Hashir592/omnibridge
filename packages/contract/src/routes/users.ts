import { z } from 'zod';
import { TICKABLE_TABS } from '../metadata.ts';
import { defineRoute } from '../route.ts';

/*
 * Users, invites and the access review (T-0204: USR-1, USR-8, USR-9, PERM-1 to PERM-7, TEN-7).
 * The shapes follow S2's proposed ones (PS-020): a member is `admin` or `child`. Errors:
 * - 409 conflict: the last admin cannot be removed or demoted (PERM-7)
 * - 409 conflict: the platform invites only a workspace's first admin (TEN-7, PLAT-3)
 * - 404 not_found: no such member, invite or review in this workspace
 */

const users = { tab: 'users', adminOnly: true, companyScoped: false } as const;
const Role = z.enum(['admin', 'child']);
const Tabs = z.array(z.enum(TICKABLE_TABS)).max(TICKABLE_TABS.length);
const CompanyIds = z.array(z.uuid()).max(100);
const NoBody = z.null();

export const WorkspaceUserSchema = z
  .object({
    /** The user id, or the invite id for someone invited who has not joined yet. */
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: Role,
    /** Ticked tabs and companies; empty for an admin, who sees everything (PERM-2). */
    tabs: z.array(z.string()),
    companyIds: z.array(z.uuid()),
    mfa: z.boolean(),
    state: z.enum(['active', 'invited']),
    lastSignInAt: z.iso.datetime().nullable(),
    inviteExpiresAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'WorkspaceUser' });

export const AccessSchema = z
  .object({ role: Role, tabs: Tabs, companyIds: CompanyIds })
  .meta({ id: 'UserAccess' });

export const AccessReviewSchema = z
  .object({
    id: z.uuid(),
    dueAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AccessReview' });

/** Members and open invites of the workspace (PERM-2). */
export const listUsers = defineRoute({
  id: 'listUsers',
  method: 'GET',
  path: '/users',
  summary: 'List the users of this workspace',
  responses: { 200: z.array(WorkspaceUserSchema) },
  auth: 'session',
  ...users,
});

/** Invites a named person; a new child may start with nothing ticked (USR-1, PERM-6). */
export const inviteUser = defineRoute({
  id: 'inviteUser',
  method: 'POST',
  path: '/users/invites',
  summary: 'Invite a user',
  body: z.object({ email: z.email().max(254) }).extend(AccessSchema.shape),
  responses: { 201: WorkspaceUserSchema },
  auth: 'session',
  ...users,
});

export const revokeInvite = defineRoute({
  id: 'revokeInvite',
  method: 'POST',
  path: '/users/invites/:inviteId/revoke',
  summary: 'Revoke an invite',
  params: z.object({ inviteId: z.uuid() }),
  responses: { 204: NoBody },
  auth: 'session',
  ...users,
});

/** Changes a member's role and ticks; it takes effect on their next request (PERM-2, USR-8). */
export const setUserAccess = defineRoute({
  id: 'setUserAccess',
  method: 'PUT',
  path: '/users/:userId/access',
  summary: "Change a user's role and ticks",
  params: z.object({ userId: z.uuid() }),
  body: AccessSchema,
  responses: { 204: NoBody },
  auth: 'session',
  ...users,
});

/** Removes a member: their sessions end at once (USR-8). */
export const removeUser = defineRoute({
  id: 'removeUser',
  method: 'DELETE',
  path: '/users/:userId',
  summary: 'Remove a user from this workspace',
  params: z.object({ userId: z.uuid() }),
  responses: { 204: NoBody },
  auth: 'session',
  ...users,
});

export const listAccessReviews = defineRoute({
  id: 'listAccessReviews',
  method: 'GET',
  path: '/access-reviews',
  summary: 'The quarterly access reviews',
  responses: { 200: z.array(AccessReviewSchema) },
  auth: 'session',
  ...users,
});

/** Marks a review done; the completion is audited (USR-9). */
export const completeAccessReview = defineRoute({
  id: 'completeAccessReview',
  method: 'POST',
  path: '/access-reviews/:reviewId/complete',
  summary: 'Complete an access review',
  params: z.object({ reviewId: z.uuid() }),
  responses: { 204: NoBody },
  auth: 'session',
  ...users,
});

/** A platform operator invites a workspace's first admin (TEN-7, USR-1). */
export const inviteFirstAdmin = defineRoute({
  id: 'inviteFirstAdmin',
  method: 'POST',
  path: '/platform/workspaces/:workspaceId/invites',
  summary: "Invite a workspace's first admin",
  params: z.object({ workspaceId: z.uuid() }),
  body: z.object({ email: z.email().max(254) }),
  responses: { 201: z.object({ id: z.uuid() }) },
  auth: 'platform',
  tab: 'none',
  adminOnly: false,
  companyScoped: false,
});

export const InviteInfoSchema = z
  .object({
    workspaceName: z.string(),
    invitedBy: z.string(),
    /** Masked, for "the invite for s***@example.test". */
    email: z.string(),
    expiresAt: z.iso.datetime(),
    /** True when the email already has an OmniBridge sign-in: they confirm with its password. */
    existingUser: z.boolean(),
  })
  .meta({ id: 'InviteInfo' });

const outsideTabs = { tab: 'none', adminOnly: false, companyScoped: false } as const;

/** What an invite link is for; 404 when unknown, used, revoked or expired (TEN-7). */
export const getInvite = defineRoute({
  id: 'getInvite',
  method: 'GET',
  path: '/auth/invites/:token',
  summary: 'An invite link',
  params: z.object({ token: z.string().min(16).max(128) }),
  responses: { 200: InviteInfoSchema },
  auth: 'public',
  ...outsideTabs,
});

/**
 * Accepts an invite. A new person sets their name and first password (USR-3 rules); someone who
 * already has a sign-in confirms with their password and sends no name (PS-024). Either way the session starts at MFA:
 * `mfa_setup` for a new person, `mfa_code` otherwise (USR-4).
 */
export const acceptInvite = defineRoute({
  id: 'acceptInvite',
  method: 'POST',
  path: '/auth/invites/accept',
  summary: 'Accept an invite',
  body: z.object({
    token: z.string().min(16).max(128),
    /** Required for a new person (422 without it); ignored for an existing sign-in. */
    name: z.string().trim().min(1).max(200).optional(),
    password: z.string().min(1).max(1024),
  }),
  responses: { 200: z.object({ next: z.enum(['mfa_code', 'mfa_setup']) }) },
  auth: 'public',
  ...outsideTabs,
});

export const userRoutes = [
  listUsers,
  inviteUser,
  revokeInvite,
  setUserAccess,
  removeUser,
  listAccessReviews,
  completeAccessReview,
  inviteFirstAdmin,
  getInvite,
  acceptInvite,
] as const;
