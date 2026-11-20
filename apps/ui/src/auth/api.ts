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
  WorkspaceList,
  Incident,
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

/* ---------- notifications (T-0501, T-0502 routes; T-0312 screens: NTF-1, NTF-4, NTF-5) ---------- */

export type Notification = components['schemas']['Notification'];
export type EmailPreference = components['schemas']['EmailPreference'];
export interface NotificationFilter {
  state?: Notification['state'] | undefined;
  severity?: Notification['severity'] | undefined;
}

/** The bell and the centre. The server shows each user only what their tabs and companies allow. */
export const notificationApi = {
  list: async (filter: NotificationFilter, cursor: string | undefined, limit = 50) => {
    const r = await reply<{ items: Notification[]; next_cursor: string | null }>(
      api.GET('/notifications', {
        params: {
          query: {
            limit,
            ...(cursor === undefined ? {} : { cursor }),
            ...(filter.state === undefined ? {} : { state: filter.state }),
            ...(filter.severity === undefined ? {} : { severity: filter.severity }),
          },
        },
      }),
    );
    if (!r.ok) throw new Error(String(r.status));
    return r.body as { items: Notification[]; next_cursor: string | null };
  },
  unreadCount: async (): Promise<number> => {
    const r = await reply<{ unread: number }>(api.GET('/notifications/unread-count'));
    if (!r.ok) throw new Error(String(r.status));
    return (r.body as { unread: number }).unread;
  },
  /** 404 when it does not exist or this user may not see it. */
  markRead: async (id: string) =>
    reply<{ marked: number }>(
      api.POST('/notifications/{id}/read', {
        params: { path: { id } },
        headers: await csrfHeaders(),
      }),
    ),
  markAllRead: async () =>
    reply<{ marked: number }>(
      api.POST('/notifications/read-all', { headers: await csrfHeaders() }),
    ),
  emailPreferences: async (): Promise<EmailPreference[]> => {
    const r = await reply<{ items: EmailPreference[] }>(
      api.GET('/me/notification-email-preferences'),
    );
    if (!r.ok) throw new Error(String(r.status));
    return (r.body as { items: EmailPreference[] }).items;
  },
  /** NTF-4: the full list back; 400 for a type this user cannot receive or a locked one. */
  setEmailPreference: async (type: string, email: boolean) =>
    reply<{ items: EmailPreference[] }>(
      api.PUT('/me/notification-email-preferences', {
        body: { items: [{ type, email }] },
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
  workspaces: () => reply<WorkspaceList>(api.GET('/auth/workspaces')),
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
  /** A platform operator enters the console instead of a workspace; 403 for anyone else. */
  enterPlatform: async () =>
    reply<never>(api.POST('/auth/platform', { headers: await csrfHeaders() })),
};

/* ---------- companies (TEN-5): the user's permitted companies, by name (ADR-072) ---------- */

export type CompanyRecord = components['schemas']['Company'];

export const companiesApi = {
  list: async (): Promise<CompanyRecord[]> => {
    const r = await reply<{ items: CompanyRecord[] }>(api.GET('/companies'));
    if (!r.ok) throw new Error(String(r.status));
    return (r.body as { items: CompanyRecord[] }).items;
  },
};

/* ---------- platform console (T-0504, T-0505 routes; T-0313 screens: PLAT-1, PLAT-2, PLAT-4) ---------- */

export type ConsoleWorkspace = components['schemas']['ConsoleWorkspace'];
export type WorkspaceStatus = ConsoleWorkspace['status'];
export type PlatformFlags = components['schemas']['PlatformFlags'];
export type QueueOverview = components['schemas']['QueueOverview'];
export type DeadLetter = components['schemas']['DeadLetter'];
export type ApiUsage = components['schemas']['ApiUsage'];
export type CredentialExpiry = components['schemas']['CredentialExpiry'];
export type PlatformHealth = components['schemas']['PlatformHealth'];
export type AppSecretStatus = components['schemas']['AppSecretStatus'];
export type AppSecretName = AppSecretStatus['name'];
export type Maintenance = components['schemas']['Maintenance'];
export type EbayBudget = components['schemas']['EbayBudget'];
export interface LiveUsage {
  ebay_budget: EbayBudget[];
  items: Array<ApiUsage & { updated_at: string }>;
}
export type SecretSlot = 'current' | 'next';
export type StatusMove = 'suspend' | 'reactivate' | 'archive';
export interface IncidentInput {
  message: string;
  severity: Incident['severity'];
}

/**
 * A console read that failed. The status is kept, so the console can tell "sign in again" (401)
 * from "not allowed from here" (403: no platform flag, no MFA or outside the allowlist, PLAT-1).
 */
export class ConsoleError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`console ${String(status)}`);
    this.status = status;
  }
}

async function read<T>(
  call: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<T> {
  const r = await reply<T>(call);
  if (!r.ok) throw new ConsoleError(r.status);
  return r.body as T;
}

const wsPath = (workspaceId: string) => ({ params: { path: { workspaceId } } });

/** Every route is `auth: platform` (PS-032, PS-033): IDs, names, statuses, dates and counts only. */
export const platformApi = {
  workspaces: async () =>
    (await read<{ items: ConsoleWorkspace[] }>(api.GET('/platform/workspaces'))).items,
  /** 202 { id, status }; 409 for a move the current status does not allow (archive is final). */
  moveWorkspace: async (workspaceId: string, move: StatusMove) => {
    const init = { ...wsPath(workspaceId), headers: await csrfHeaders() };
    return reply<{ id: string; status: WorkspaceStatus }>(
      move === 'suspend'
        ? api.POST('/platform/workspaces/{workspaceId}/suspend', init)
        : move === 'reactivate'
          ? api.POST('/platform/workspaces/{workspaceId}/reactivate', init)
          : api.POST('/platform/workspaces/{workspaceId}/archive', init),
    );
  },
  /** 200 with the toggles; 409 for an archived workspace. */
  setModules: async (workspaceId: string, modules: ConsoleWorkspace['modules']) =>
    reply<ConsoleWorkspace['modules']>(
      api.PUT('/platform/workspaces/{workspaceId}/modules', {
        ...wsPath(workspaceId),
        body: modules,
        headers: await csrfHeaders(),
      }),
    ),
  flags: () => read<PlatformFlags>(api.GET('/platform/flags')),
  setFlags: async (flags: { public_signup: boolean }) =>
    reply<PlatformFlags>(api.PUT('/platform/flags', { body: flags, headers: await csrfHeaders() })),
  jobs: async () => (await read<{ items: QueueOverview[] }>(api.GET('/platform/jobs'))).items,
  deadLetters: async (limit = 50) =>
    (
      await read<{ items: DeadLetter[] }>(
        api.GET('/platform/jobs/dead-letters', { params: { query: { limit } } }),
      )
    ).items,
  /** 202 { id }; 404 when it is no longer dead-lettered. */
  redrive: async (type: string, id: string) =>
    reply<{ id: string }>(
      api.POST('/platform/jobs/{type}/dead-letters/{id}/redrive', {
        params: { path: { type, id } },
        headers: await csrfHeaders(),
      }),
    ),
  /** YYYY-MM-DD, at most 92 days apart. */
  apiUsage: async (from: string, to: string) =>
    (
      await read<{ items: ApiUsage[] }>(
        api.GET('/platform/api-usage', { params: { query: { from, to } } }),
      )
    ).items,
  credentialExpiry: async (withinDays: number) =>
    (
      await read<{ items: CredentialExpiry[] }>(
        api.GET('/platform/credential-expiry', { params: { query: { within_days: withinDays } } }),
      )
    ).items,
  health: () => read<PlatformHealth>(api.GET('/platform/health')),
  /** SAFE-3: the global maintenance switch. */
  maintenance: () => read<Maintenance>(api.GET('/platform/maintenance')),
  setMaintenance: async (maintenance: boolean) =>
    reply<Maintenance>(
      api.PUT('/platform/maintenance', { body: { maintenance }, headers: await csrfHeaders() }),
    ),
  /** RL-5: today's usage, each row written as the call is made. */
  liveUsage: () => read<LiveUsage>(api.GET('/platform/api-usage/live')),
  incident: async () =>
    (await read<{ incident: Incident | null }>(api.GET('/platform/incident-banner'))).incident,
  setIncident: async (input: IncidentInput) =>
    reply<{ incident: Incident }>(
      api.PUT('/platform/incident-banner', { body: input, headers: await csrfHeaders() }),
    ),
  clearIncident: async () =>
    reply<never>(api.DELETE('/platform/incident-banner', { headers: await csrfHeaders() })),
  appSecrets: async () =>
    (await read<{ items: AppSecretStatus[] }>(api.GET('/platform/app-secrets'))).items,
  /** Write-only (PLAT-4): 204 and nothing comes back. */
  setAppSecret: async (name: AppSecretName, slot: SecretSlot, value: string) =>
    reply<never>(
      api.PUT('/platform/app-secrets/{name}/{slot}', {
        params: { path: { name, slot } },
        body: { value },
        headers: await csrfHeaders(),
      }),
    ),
  /** 204; 409 when there is no next value to promote. */
  promoteAppSecret: async (name: AppSecretName) =>
    reply<never>(
      api.POST('/platform/app-secrets/{name}/promote', {
        params: { path: { name } },
        headers: await csrfHeaders(),
      }),
    ),
};

/* ---------- connections (T-0701, T-0702 routes; T-0314 screens: INT-4, SAFE-1, SAFE-2) ---------- */

export type Connection = components['schemas']['Connection'];
export type ConnectionDetail = components['schemas']['ConnectionDetail'];
export type ConnectionStatus = components['schemas']['ConnectionStatus'];
export type Provider = components['schemas']['Provider'];
export type ApiUsageToday = components['schemas']['ApiUsageToday'];
export type MaintenanceState = components['schemas']['MaintenanceState'];
export type BulkAction = components['schemas']['BulkAction'];
export type BulkPreview = components['schemas']['BulkPreview'];
export type BulkConfirmed = components['schemas']['BulkConfirmed'];

const accountPath = (accountId: string) => ({ params: { path: { accountId } } });

/** Connections is an admin tab; the server answers only the companies in the user's scope. */
export const connectionsApi = {
  list: async () =>
    read<{ items: Connection[]; maintenance: MaintenanceState }>(api.GET('/connections')),
  get: (accountId: string) =>
    read<ConnectionDetail>(api.GET('/connections/{accountId}', accountPath(accountId))),
  /** SAFE-2: answers the Connection with its new kill switch. */
  setKillSwitch: async (accountId: string, paused: boolean) =>
    reply<Connection>(
      api.PUT('/connections/{accountId}/kill-switch', {
        ...accountPath(accountId),
        body: { paused },
        headers: await csrfHeaders(),
      }),
    ),
  /** The provider's consent URL; 409 for an API-key provider. */
  authorise: async (accountId: string) =>
    reply<{ redirect_url: string }>(
      api.POST('/connections/{accountId}/authorise', {
        ...accountPath(accountId),
        headers: await csrfHeaders(),
      }),
    ),
};

/** SAFE-1: preview names every account; confirm sends the token only. */
export const bulkApi = {
  preview: async (
    action: BulkAction,
    channelAccountIds: string[],
    params?: Record<string, string | number | boolean | string[]>,
  ) =>
    reply<BulkPreview>(
      api.POST('/bulk-writes/preview', {
        body: {
          action,
          channel_account_ids: channelAccountIds,
          ...(params === undefined ? {} : { params }),
        },
        headers: await csrfHeaders(),
      }),
    ),
  /** 202; 404 for an unknown token; 409 when it expired, was used or the scope changed. */
  confirm: async (token: string) =>
    reply<BulkConfirmed>(
      api.POST('/bulk-writes/confirm', { body: { token }, headers: await csrfHeaders() }),
    ),
};
