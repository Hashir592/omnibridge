/**
 * The auth routes (T-0203, ADR-048) through the typed client: sign in, MFA, password reset and
 * the workspace picker. Every state-changing call carries the CSRF token (SEC-1): the server sets
 * the `ob_csrf` cookie and the SPA echoes it in `x-csrf-token`.
 */
import { createApiClient } from '@omnibridge/contract/client';
import type { WorkspaceUser } from '../mocks/admin.ts';
import type {
  InviteInfo,
  MfaConfirmResult,
  MfaEnrolment,
  MfaResult,
  ResetTokenInfo,
  SignInResult,
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
const api = createApiClient({ baseUrl: globalThis.location.origin });

const CSRF_COOKIE = 'ob_csrf';

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

/** Users of the workspace (T-0204, admin only): members and open invites. */
export const usersApi = {
  list: async (): Promise<WorkspaceUser[]> => {
    const r = await reply<WorkspaceUser[]>(api.GET('/users'));
    if (!r.ok) throw new Error(String(r.status));
    return r.body as WorkspaceUser[];
  },
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
  workspaces: () => reply<WorkspaceChoice[]>(api.GET('/auth/workspaces')),
  invite: (token: string) =>
    reply<InviteInfo>(api.GET('/auth/invites/{token}', { params: { path: { token } } })),
  acceptInvite: async (token: string, name: string, password: string) =>
    reply<SignInResult>(
      api.POST('/auth/invites/accept', {
        body: { token, name, password },
        headers: await csrfHeaders(),
      }),
    ),
  chooseWorkspace: async (workspaceId: string) =>
    reply<never>(
      api.POST('/auth/workspace', { body: { workspaceId }, headers: await csrfHeaders() }),
    ),
};
