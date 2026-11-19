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

/* ---------- buyer data requests (T-0404 routes, T-0308 screens: DEL-3, DEL-4, DEL-5) ---------- */

export type BuyerIdentifiers = components['schemas']['BuyerIdentifiers'];
export type ErasureRequest = components['schemas']['ErasureRequest'];
export type ErasureRequestCreated = components['schemas']['ErasureRequestCreated'];
export type ErasureMatch = components['schemas']['ErasureMatch'];
export type JobProgress = components['schemas']['JobProgress'];
/** The fixed list of withdraw reasons (ADR-067); no free text, so no buyer detail can get in. */
export type WithdrawReason = NonNullable<ErasureRequest['withdrawReason']>;

/**
 * Hands a downloaded file to the browser's save dialog. The bytes live only in memory for this
 * moment: nothing is written to localStorage, sessionStorage or IndexedDB (T-0308).
 */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked later: some browsers start the download after click() returns.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

/**
 * Erasure and subject access requests, admin only. The buyer's identifiers go only in request
 * bodies, never in a URL (T-0404).
 */
export const privacyApi = {
  list: async (): Promise<ErasureRequest[]> => {
    const r = await reply<{ items: ErasureRequest[] }>(api.GET('/erasure-requests'));
    if (!r.ok) throw new Error(String(r.status));
    return (r.body as { items: ErasureRequest[] }).items;
  },
  /**
   * DEL-4 step 1: find every record; nothing is deleted yet. 400 when the identifiers do not pin
   * one buyer; 422 `too_many_matches` when they match too much (nothing is stored).
   */
  startErasure: async (identifiers: BuyerIdentifiers) =>
    reply<ErasureRequestCreated>(
      api.POST('/erasure-requests', { body: { identifiers }, headers: await csrfHeaders() }),
    ),
  /** DEL-4 step 2: 202 with the deletion job; 409 `conflict` when already confirmed. */
  confirmErasure: async (id: string) =>
    reply<ErasureRequest>(
      api.POST('/erasure-requests/{id}/confirm', {
        params: { path: { id } },
        headers: await csrfHeaders(),
      }),
    ),
  /** ADR-067: closes an open request without deleting; 409 `conflict` when it is not open. */
  withdrawErasure: async (id: string, reason: WithdrawReason) =>
    reply<ErasureRequest>(
      api.POST('/erasure-requests/{id}/withdraw', {
        params: { path: { id } },
        body: { reason },
        headers: await csrfHeaders(),
      }),
    ),
  /** A-006: runs a failed deletion again; 202 confirmed with a new job, 409 unless failed. */
  retryErasure: async (id: string) =>
    reply<ErasureRequest>(
      api.POST('/erasure-requests/{id}/retry', {
        params: { path: { id } },
        headers: await csrfHeaders(),
      }),
    ),
  job: async (id: string): Promise<JobProgress> => {
    const r = await reply<JobProgress>(api.GET('/jobs/{id}', { params: { path: { id } } }));
    if (!r.ok) throw new Error(String(r.status));
    return r.body as JobProgress;
  },
  /** DEL-5: a JSON file; 422 `validation_failed` when too many records match. */
  exportAccess: async (identifiers: BuyerIdentifiers) =>
    reply<Blob>(
      api.POST('/access-requests/export', {
        body: { identifiers },
        headers: await csrfHeaders(),
        parseAs: 'blob',
      }),
    ),
  /** DEL-3: a text file per channel account. */
  deletionCertificate: (channelAccountId: string) =>
    reply<Blob>(
      api.GET('/channel-accounts/{id}/deletion-certificate', {
        params: { path: { id: channelAccountId } },
        parseAs: 'blob',
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
