/**
 * The auth routes (T-0203, ADR-048) through the typed client: sign in, MFA, password reset and
 * the workspace picker. Every state-changing call carries the CSRF token (SEC-1): the server sets
 * the `__Host-ob_csrf` cookie and the SPA echoes it in `x-csrf-token`.
 */
import { createApiClient, type components } from '@omnibridge/contract/client';
import type {
  InviteInfo,
  MfaConfirmResult,
  MfaEnrolment,
  MfaResult,
  ResetTokenInfo,
  SignInResult,
  TermsAccepted,
  TermsInfo,
  SessionInfo,
  WorkspaceChoice,
} from './shapes.ts';

/** A reply as the screens read it: the parsed body (data or problem), status and Retry-After. */
export interface ApiReply<T> {
  ok: boolean;
  status: number;
  body: T | ApiProblem | undefined;
  retryAfter: number | undefined;
}

export interface ApiProblem {
  code: string;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}

// The page's own origin: the API is same-origin, and an absolute base also works outside a
// browser (component tests).
// fetch is looked up on each call, not captured here: in browsers that refuse service workers the
// mock-ups replace window.fetch after this module has loaded (mocks/browser.ts).
const api = createApiClient({
  baseUrl: globalThis.location.origin,
  fetch: (input) => globalThis.fetch(input),
});

// __Host-: Secure, Path=/ and host-only, so a sibling host cannot plant it (S5 hardening 1).
const CSRF_COOKIE = '__Host-ob_csrf';

function csrfToken(): string | undefined {
  for (const part of document.cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === CSRF_COOKIE) return value.join('=');
  }
  return undefined;
}

/** The CSRF header for a state-changing call; asks the server for the cookie first if needed. */
async function csrfHeaders(): Promise<Record<string, string>> {
  if (csrfToken() === undefined) await api.GET('/auth/csrf');
  const token = csrfToken();
  return token === undefined ? {} : { 'x-csrf-token': token };
}

async function reply<T>(
  call: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<ApiReply<T>> {
  const { data, error, response } = await call;
  const retry = Number(response.headers.get('retry-after'));
  return {
    ok: response.ok,
    status: response.status,
    body: (response.ok ? data : error) as T | ApiProblem | undefined,
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
  };
}

/** A member or an open invite (T-0204). For an invite, `id` is the invite id. */
export type WorkspaceUser = components['schemas']['WorkspaceUser'];
/** Role and ticks; an admin's tabs and companies are empty, since admins see everything. */
export type UserAccess = components['schemas']['UserAccess'];
export type UserTab = UserAccess['tabs'][number];
export type AccessReview = components['schemas']['AccessReview'];

/** Users of the workspace (T-0204, admin only): members, open invites and access reviews. */
export const usersApi = {
  list: async (): Promise<WorkspaceUser[]> => {
    const r = await reply<WorkspaceUser[]>(api.GET('/users'));
    if (!r.ok) throw new Error(String(r.status));
    return r.body as WorkspaceUser[];
  },
  invite: async (email: string, access: UserAccess) =>
    reply<WorkspaceUser>(
      api.POST('/users/invites', { body: { email, ...access }, headers: await csrfHeaders() }),
    ),
  revokeInvite: async (inviteId: string) =>
    reply<never>(
      api.POST('/users/invites/{inviteId}/revoke', {
        params: { path: { inviteId } },
        headers: await csrfHeaders(),
      }),
    ),
  /** 409 `conflict` when it would demote the last admin (PERM-7). */
  setAccess: async (userId: string, access: UserAccess) =>
    reply<never>(
      api.PUT('/users/{userId}/access', {
        params: { path: { userId } },
        body: access,
        headers: await csrfHeaders(),
      }),
    ),
  /** 409 `conflict` when it would remove the last admin (PERM-7). */
  remove: async (userId: string) =>
    reply<never>(
      api.DELETE('/users/{userId}', { params: { path: { userId } }, headers: await csrfHeaders() }),
    ),
  accessReviews: async (): Promise<AccessReview[]> => {
    const r = await reply<AccessReview[]>(api.GET('/access-reviews'));
    if (!r.ok) throw new Error(String(r.status));
    return r.body as AccessReview[];
  },
  completeReview: async (reviewId: string) =>
    reply<never>(
      api.POST('/access-reviews/{reviewId}/complete', {
        params: { path: { reviewId } },
        headers: await csrfHeaders(),
      }),
    ),
};

export const authApi = {
  signIn: async (email: string, password: string) =>
    reply<SignInResult>(
      api.POST('/auth/sign-in', { body: { email, password }, headers: await csrfHeaders() }),
    ),
  verifyCode: async (code: string) =>
    reply<MfaResult>(
      api.POST('/auth/mfa/verify', { body: { code }, headers: await csrfHeaders() }),
    ),
  recovery: async (code: string) =>
    reply<MfaResult>(
      api.POST('/auth/mfa/recovery', { body: { code }, headers: await csrfHeaders() }),
    ),
  startEnrolment: async () =>
    reply<MfaEnrolment>(api.POST('/auth/mfa/enrolment', { headers: await csrfHeaders() })),
  confirmEnrolment: async (code: string) =>
    reply<MfaConfirmResult>(
      api.POST('/auth/mfa/enrolment/confirm', { body: { code }, headers: await csrfHeaders() }),
    ),
  forgot: async (email: string) =>
    reply<never>(
      api.POST('/auth/password/forgot', { body: { email }, headers: await csrfHeaders() }),
    ),
  resetInfo: (token: string) =>
    reply<ResetTokenInfo>(api.GET('/auth/password/reset/{token}', { params: { path: { token } } })),
  reset: async (token: string, password: string) =>
    reply<never>(
      api.POST('/auth/password/reset', {
        body: { token, password },
        headers: await csrfHeaders(),
      }),
    ),
  /** Where the session is (ADR-062); 401 without one. */
  session: () => reply<SessionInfo>(api.GET('/auth/session')),
  workspaces: () => reply<WorkspaceChoice[]>(api.GET('/auth/workspaces')),
  invite: (token: string) =>
    reply<InviteInfo>(api.GET('/auth/invites/{token}', { params: { path: { token } } })),
  acceptInvite: async (token: string, name: string | undefined, password: string) =>
    reply<SignInResult>(
      api.POST('/auth/invites/accept', {
        body: { token, password, ...(name === undefined ? {} : { name }) },
        headers: await csrfHeaders(),
      }),
    ),
  terms: () => reply<TermsInfo>(api.GET('/auth/terms')),
  acceptTerms: async (version: string) =>
    reply<TermsAccepted>(
      api.POST('/auth/terms', { body: { version }, headers: await csrfHeaders() }),
    ),
  chooseWorkspace: async (workspaceId: string) =>
    reply<never>(
      api.POST('/auth/workspace', { body: { workspaceId }, headers: await csrfHeaders() }),
    ),
};
