/**
 * PROPOSED SHAPES (mock only, T-0303) for the auth screens. S3 builds the real routes in
 * T-0203/T-0204; the shapes are recorded in docs/DECISIONS.md (Proposed from sessions).
 *
 * Errors use the contract's Problem body (`code` from ERROR_CODES), so no new codes are needed:
 * - 401 `unauthorized`: wrong email or password. One message for both (no account enumeration).
 * - 429 `rate_limited` + `Retry-After` seconds: locked out (USR-5). The server counts failures per
 *   email whether or not the account exists, so the lockout never reveals that an email is real.
 * - 422 `validation_failed`: `errors[].path` names the field; for passwords, `message` is the rule.
 * - 404 `not_found`: a reset or invite link that is unknown, used or expired (one message for all).
 *
 * SYNTHETIC VALUES ONLY. Nothing here is a real password, secret or person. Demo values for
 * clicking through on localhost:
 * - sam.admin@example.test: MFA set up, two workspaces, so the workspace picker appears
 * - pat.packer@example.test: MFA set up, one workspace, goes straight to the app
 * - new.user@example.test: MFA not set up yet, so enrolment appears (USR-4)
 * - password for all three: DEMO_PASSWORD below; TOTP code: DEMO_TOTP
 * - 10 wrong passwords for any email within 15 minutes locks it (USR-5)
 * - invite link: /invite/demo-invite; expired link: /invite/expired. Same for /reset-password?token=
 */
import { HttpResponse, http } from 'msw/http';

export const DEMO_PASSWORD = 'synthetic demo only';
export const DEMO_TOTP = '123456';

/** POST /auth/sign-in → 200. The server sets a pre-MFA session cookie (httpOnly, 10 minutes). */
export interface SignInResult {
  next: 'mfa_code' | 'mfa_setup';
}

/** POST /auth/mfa/verify and /auth/mfa/recovery → 200. Full session cookie is set now. */
export interface MfaResult {
  next: 'workspace_picker' | 'app';
  /** Recovery-code sign in only: how many unused codes are left. */
  recoveryCodesLeft?: number;
}

/** POST /auth/mfa/enrolment → 200: a new TOTP secret, not active until confirmed. */
export interface MfaEnrolment {
  /** Base32 secret for typing into the app by hand, grouped in fours for reading. */
  secret: string;
  /** Account label the authenticator shows, e.g. "OmniBridge (n***@example.test)". */
  label: string;
  /**
   * The otpauth:// URI as a QR module matrix, drawn by the UI as inline SVG: no QR library in
   * the bundle and nothing for the CSP to allow. One string per row, '1' = dark module.
   */
  qr: string[];
}

/** POST /auth/mfa/enrolment/confirm {code} → 200. Codes are shown once and never again. */
export interface MfaConfirmResult {
  recoveryCodes: string[];
}

/** GET /auth/password/reset/:token → 200 when usable; 404 otherwise. */
export interface ResetTokenInfo {
  /** Masked, for "Resetting the password for s***@example.test". */
  emailMasked: string;
  expiresAt: string;
}

/** GET /invites/:token → 200 when usable; 404 otherwise (TEN-7: 72 hours). */
export interface InviteInfo {
  workspaceName: string;
  invitedBy: string;
  email: string;
  expiresAt: string;
}

/** GET /auth/workspaces → 200 (only after MFA). */
export interface WorkspaceChoice {
  id: string;
  name: string;
  role: 'admin' | 'member';
  companies: number;
}

/** USR-3 rules, checked live in the UI; the server checks them again plus breach and history. */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 12 characters' },
  { id: 'personal', label: 'Does not contain your name or the first part of your email' },
  { id: 'breached', label: 'Not found in lists of leaked passwords' },
  { id: 'history', label: 'Not one of your last 10 passwords' },
] as const;

const ACCOUNTS: Record<string, { name: string; mfa: boolean; workspaces: number }> = {
  'sam.admin@example.test': { name: 'Sam Admin', mfa: true, workspaces: 2 },
  'pat.packer@example.test': { name: 'Pat Packer', mfa: true, workspaces: 1 },
  'new.user@example.test': { name: 'New User', mfa: false, workspaces: 1 },
};

const LOCK_AFTER = 10;
const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, number[]>();
/** Email -> time the lock ends: 15 minutes after the 10th failure, not a sliding window (USR-5). */
const lockedUntil = new Map<string, number>();
let current: string | undefined;

/** Clears failure counts and the signed-in email (tests). */
export function resetAuthMock(): void {
  failures.clear();
  lockedUntil.clear();
  current = undefined;
  for (const a of Object.values(ACCOUNTS)) a.mfa = a.name !== 'New User';
}

function problem(status: number, code: string, detail: string, headers?: Record<string, string>) {
  return HttpResponse.json(
    { type: 'about:blank', title: '', status, code, detail },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

/** Seconds left on the lock, or undefined when the email is not locked. */
function locked(email: string, now: number): number | undefined {
  const until = lockedUntil.get(email);
  if (until !== undefined && until > now) return Math.ceil((until - now) / 1000);
  if (until !== undefined) {
    lockedUntil.delete(email);
    failures.delete(email);
  }
  return undefined;
}

/** Records a failure; the 10th within 15 minutes starts a 15-minute lock. */
function fail(email: string, now: number): void {
  const recent = [...(failures.get(email) ?? []), now].filter((t) => now - t < WINDOW_MS);
  failures.set(email, recent);
  if (recent.length >= LOCK_AFTER) lockedUntil.set(email, now + WINDOW_MS);
}

/** A fixed QR-like pattern with the three finder squares. Not scannable: mock only. */
function mockQr(size = 29): string[] {
  const finder = (r: number, c: number) => {
    for (const [r0, c0] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      const y = r - r0;
      const x = c - c0;
      if (y >= -1 && y <= 7 && x >= -1 && x <= 7) {
        if (y < 0 || y > 6 || x < 0 || x > 6) return 0;
        return y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4)
          ? 1
          : 0;
      }
    }
    return undefined;
  };
  let seed = 7;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => finder(r, c) ?? (rand() < 0.45 ? 1 : 0)).join(''),
  );
}

/** 422: the password is on the leaked list. The mock treats any password containing "password" so. */
const breached = () =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: '',
      status: 422,
      code: 'validation_failed',
      errors: [{ location: 'body', path: 'password', message: 'breached' }],
    },
    { status: 422, headers: { 'content-type': 'application/problem+json' } },
  );

const usable = (token: string | null | undefined) => !!token && token !== 'expired';

export const authHandlers = [
  http.post('*/api/mock/auth/sign-in', async ({ request }) => {
    const body = (await request.json()) as { email?: string; password?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const now = Date.now();
    const wait = locked(email, now);
    if (wait !== undefined) {
      return problem(429, 'rate_limited', 'locked', { 'retry-after': String(wait) });
    }
    const account = ACCOUNTS[email];
    if (!account || body.password !== DEMO_PASSWORD) {
      fail(email, now);
      const after = locked(email, now);
      if (after !== undefined) {
        return problem(429, 'rate_limited', 'locked', { 'retry-after': String(after) });
      }
      return problem(401, 'unauthorized', 'invalid_credentials');
    }
    failures.delete(email);
    current = email;
    return HttpResponse.json<SignInResult>({ next: account.mfa ? 'mfa_code' : 'mfa_setup' });
  }),

  http.post('*/api/mock/auth/mfa/verify', async ({ request }) => {
    const { code } = (await request.json()) as { code?: string };
    if (code !== DEMO_TOTP) return problem(401, 'unauthorized', 'invalid_code');
    const ws = current ? (ACCOUNTS[current]?.workspaces ?? 1) : 1;
    return HttpResponse.json<MfaResult>({ next: ws > 1 ? 'workspace_picker' : 'app' });
  }),

  http.post('*/api/mock/auth/mfa/recovery', async ({ request }) => {
    const { code } = (await request.json()) as { code?: string };
    if (!/^[a-z0-9]{5}-[a-z0-9]{5}$/i.test((code ?? '').trim())) {
      return problem(401, 'unauthorized', 'invalid_code');
    }
    const ws = current ? (ACCOUNTS[current]?.workspaces ?? 1) : 1;
    return HttpResponse.json<MfaResult>({
      next: ws > 1 ? 'workspace_picker' : 'app',
      recoveryCodesLeft: 9,
    });
  }),

  http.post('*/api/mock/auth/mfa/enrolment', () =>
    HttpResponse.json<MfaEnrolment>({
      secret: 'MOCK SECR ETNO TREA LXXX XXXX XXXX',
      label: 'OmniBridge (n***@example.test)',
      qr: mockQr(),
    }),
  ),

  http.post('*/api/mock/auth/mfa/enrolment/confirm', async ({ request }) => {
    const { code } = (await request.json()) as { code?: string };
    if (code !== DEMO_TOTP) return problem(401, 'unauthorized', 'invalid_code');
    const account = current ? ACCOUNTS[current] : undefined;
    if (account) account.mfa = true;
    const recoveryCodes = Array.from({ length: 10 }, (_, i) => {
      const n = (i + 1) * 7919;
      return `mock${String(i)}-${n.toString(36).padStart(5, '0').slice(-5)}`;
    });
    return HttpResponse.json<MfaConfirmResult>({ recoveryCodes });
  }),

  // Always 202, whether or not the email has an account (no account enumeration).
  http.post('*/api/mock/auth/password/forgot', () => new HttpResponse(null, { status: 202 })),

  http.get('*/api/mock/auth/password/reset/:token', ({ params }) =>
    usable(params.token as string)
      ? HttpResponse.json<ResetTokenInfo>({
          emailMasked: 's***@example.test',
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        })
      : problem(404, 'not_found', 'link_unusable'),
  ),

  http.post('*/api/mock/auth/password/reset', async ({ request }) => {
    const { token, password } = (await request.json()) as { token?: string; password?: string };
    if (!usable(token)) return problem(404, 'not_found', 'link_unusable');
    if ((password ?? '').toLowerCase().includes('password')) return breached();
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/mock/invites/:token', ({ params }) =>
    usable(params.token as string)
      ? HttpResponse.json<InviteInfo>({
          workspaceName: 'Demo workspace',
          invitedBy: 'Sam Admin',
          email: 'new.user@example.test',
          expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        })
      : problem(404, 'not_found', 'link_unusable'),
  ),

  http.post('*/api/mock/invites/:token/accept', async ({ params, request }) => {
    if (!usable(params.token as string)) return problem(404, 'not_found', 'link_unusable');
    const { password } = (await request.json()) as { password?: string };
    if ((password ?? '').toLowerCase().includes('password')) return breached();
    current = 'new.user@example.test';
    return HttpResponse.json<SignInResult>({ next: 'mfa_setup' });
  }),

  http.get('*/api/mock/auth/workspaces', () =>
    HttpResponse.json<WorkspaceChoice[]>([
      { id: 'ws_1', name: 'Demo workspace', role: 'admin', companies: 3 },
      { id: 'ws_2', name: 'Second demo workspace', role: 'member', companies: 1 },
    ]),
  ),

  http.post('*/api/mock/auth/workspace', () => new HttpResponse(null, { status: 204 })),
];
