/**
 * MOCK-ONLY data access for the T-0301 mock-ups. These routes are PROPOSED SHAPES that the
 * contract does not have yet, so the typed client cannot reach them. Each function is replaced by
 * an `api.GET(...)` call from @omnibridge/contract/client once S3 builds the real route.
 */
import type {
  InviteInfo,
  MfaConfirmResult,
  MfaEnrolment,
  MfaResult,
  ResetTokenInfo,
  SignInResult,
  WorkspaceChoice,
} from '../auth/shapes.ts';
import type { HomeSummary } from './home.ts';
import type { OrderDetail, OrderPage, Session } from './types.ts';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} returned ${String(res.status)}`);
  return (await res.json()) as T;
}

export const mockApi = {
  session: () => getJson<Session>('/api/mock/session'),
  orders: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== '') qs.set(k, String(v));
    return getJson<OrderPage>(`/api/mock/orders?${qs.toString()}`);
  },
  home: (company: string) =>
    getJson<HomeSummary>(`/api/mock/home?company=${encodeURIComponent(company)}`),
  order: (id: string) => getJson<OrderDetail>(`/api/mock/orders/${encodeURIComponent(id)}`),
};

/** A mock POST answer: the parsed body (JSON or problem+json) plus status and headers. */
export interface MockReply<T> {
  ok: boolean;
  status: number;
  body: T | MockProblem | undefined;
  retryAfter: number | undefined;
}

export interface MockProblem {
  code: string;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}

async function send<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<MockReply<T>> {
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  const retry = Number(res.headers.get('retry-after'));
  return {
    ok: res.ok,
    status: res.status,
    body: text ? (JSON.parse(text) as T | MockProblem) : undefined,
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
  };
}

/** Auth routes (T-0303), PROPOSED SHAPES; see mocks/auth.ts. */
export const authApi = {
  signIn: (email: string, password: string) =>
    send<SignInResult>('POST', '/api/mock/auth/sign-in', { email, password }),
  verifyCode: (code: string) => send<MfaResult>('POST', '/api/mock/auth/mfa/verify', { code }),
  recovery: (code: string) => send<MfaResult>('POST', '/api/mock/auth/mfa/recovery', { code }),
  startEnrolment: () => send<MfaEnrolment>('POST', '/api/mock/auth/mfa/enrolment'),
  confirmEnrolment: (code: string) =>
    send<MfaConfirmResult>('POST', '/api/mock/auth/mfa/enrolment/confirm', { code }),
  forgot: (email: string) => send<never>('POST', '/api/mock/auth/password/forgot', { email }),
  resetInfo: (token: string) =>
    send<ResetTokenInfo>('GET', `/api/mock/auth/password/reset/${encodeURIComponent(token)}`),
  reset: (token: string, password: string) =>
    send<never>('POST', '/api/mock/auth/password/reset', { token, password }),
  invite: (token: string) =>
    send<InviteInfo>('GET', `/api/mock/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, name: string, password: string) =>
    send<SignInResult>('POST', `/api/mock/invites/${encodeURIComponent(token)}/accept`, {
      name,
      password,
    }),
  workspaces: () => send<WorkspaceChoice[]>('GET', '/api/mock/auth/workspaces'),
  chooseWorkspace: (workspaceId: string) =>
    send<never>('POST', '/api/mock/auth/workspace', { workspaceId }),
};
