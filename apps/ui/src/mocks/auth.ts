/**
 * MSW mock of the auth routes (T-0303). The shapes themselves live in `src/auth/shapes.ts`
 * (ADR-048), so app code never imports this file and msw never reaches a production build.
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
 * - sam.admin@example.test: MFA set up, two workspaces, so the workspace picker appears; also a
 *   platform operator, so /platform opens the console (PLAT-1)
 * - pat.packer@example.test: MFA set up, one workspace, goes straight to the app
 * - new.user@example.test: MFA not set up yet, so enrolment appears (USR-4)
 * - password for all three: DEMO_PASSWORD below; TOTP code: DEMO_TOTP
 * - 10 wrong passwords for any email within 15 minutes locks it (USR-5)
 * - invite link: /invite/demo-invite; expired link: /invite/expired. Same for /reset-password?token=
 */
import { HttpResponse, http } from 'msw/http';
import {
  consoleSessionInfo,
  getPersona,
  personaSessionInfo,
  setSignedInModules,
} from './session.ts';
import { enterConsoleMock, inConsoleMock, mockIncident, resetPlatformMock } from './platform.ts';
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
} from '../auth/shapes.ts';

export const DEMO_PASSWORD = 'synthetic demo only';
export const DEMO_TOTP = '123456';
/** Demo invite link for someone who already has a sign-in (T-0204). */
export const EXISTING_INVITE = 'existing-user-invite';

/** The terms version the mock asks for (WWW-7); matches the public site's LEGAL_VERSION. */
export const TERMS_VERSION = '2026-11-15';

const ACCOUNTS: Record<
  string,
  { name: string; mfa: boolean; workspaces: number; termsAccepted?: boolean; platform?: boolean }
> = {
  'sam.admin@example.test': { name: 'Sam Admin', mfa: true, workspaces: 2, platform: true },
  'pat.packer@example.test': { name: 'Pat Packer', mfa: true, workspaces: 1 },
  'new.user@example.test': { name: 'New User', mfa: false, workspaces: 1 },
  // Has not accepted the current terms yet: MFA answers next: 'terms'.
  'kim.terms@example.test': { name: 'Kim Terms', mfa: true, workspaces: 1, termsAccepted: false },
};

/** After MFA: the terms first if this account has not accepted the current version. */
function nextAfterMfa(): MfaResult['next'] {
  mfaDone = true;
  const account = current ? ACCOUNTS[current] : undefined;
  if (account?.termsAccepted === false) return 'terms';
  return (account?.workspaces ?? 1) > 1 ? 'workspace_picker' : 'app';
}

const LOCK_AFTER = 10;
const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, number[]>();
/** Email -> time the lock ends: 15 minutes after the 10th failure, not a sliding window (USR-5). */
const lockedUntil = new Map<string, number>();
let current: string | undefined;
/**
 * In the browser mock-ups (not in unit tests), a page opened without signing in gets the demo
 * persona's session, as if already signed in; a sign-in started in the page takes over from there.
 */
let demoSession = false;

export function enableDemoSession(): void {
  demoSession = true;
}

/** False between the password and the code: /auth/session then answers the MFA step. */
let mfaDone = false;
/** The workspace the mock session is in, once chosen (or the only one). */
let currentWorkspace: string | undefined;

const MOCK_WORKSPACES: WorkspaceChoice[] = [
  {
    id: 'ws_1',
    name: 'Demo workspace',
    role: 'admin',
    companies: 3,
    modules: { website_connector: true },
  },
  {
    id: 'ws_2',
    name: 'Second demo workspace',
    role: 'member',
    companies: 1,
    modules: { website_connector: false },
  },
];

// The mock data (orders, stock, connections...) hides the Website channel by the workspace this
// sign-in entered, the same answer GET /auth/session gives (WEB-1).
setSignedInModules(() => {
  if (current === undefined || !mfaDone) return undefined;
  const account = ACCOUNTS[current];
  const id = currentWorkspace ?? (account?.workspaces === 1 ? 'ws_1' : undefined);
  return MOCK_WORKSPACES.find((w) => w.id === id)?.modules;
});

/** Clears failure counts and the signed-in email (tests). */
export function resetAuthMock(): void {
  failures.clear();
  lockedUntil.clear();
  current = undefined;
  currentWorkspace = undefined;
  demoSession = false;
  mfaDone = false;
  resetPlatformMock();
  for (const a of Object.values(ACCOUNTS)) {
    a.mfa = a.name !== 'New User';
    if (a.termsAccepted !== undefined) a.termsAccepted = false;
  }
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
  // The CSRF cookie (SEC-1), set as the server sets it, so the SPA asks only once. The mock
  // checks no token.
  http.get(
    '*/api/auth/csrf',
    () =>
      new HttpResponse(null, {
        status: 204,
        headers: {
          'set-cookie': '__Host-ob_csrf=mock-csrf-token; Path=/; Secure; SameSite=Strict',
        },
      }),
  ),

  http.post('*/api/auth/sign-in', async ({ request }) => {
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
    mfaDone = false;
    currentWorkspace = undefined;
    return HttpResponse.json<SignInResult>({ next: account.mfa ? 'mfa_code' : 'mfa_setup' });
  }),

  http.post('*/api/auth/mfa/verify', async ({ request }) => {
    const { code } = (await request.json()) as { code?: string };
    if (code !== DEMO_TOTP) return problem(401, 'unauthorized', 'invalid_code');
    return HttpResponse.json<MfaResult>({ next: nextAfterMfa() });
  }),

  http.post('*/api/auth/mfa/recovery', async ({ request }) => {
    const { code } = (await request.json()) as { code?: string };
    if (!/^[a-z0-9]{5}-[a-z0-9]{5}$/i.test((code ?? '').trim())) {
      return problem(401, 'unauthorized', 'invalid_code');
    }
    return HttpResponse.json<MfaResult>({ next: nextAfterMfa(), recoveryCodesLeft: 9 });
  }),

  http.post('*/api/auth/mfa/enrolment', () =>
    HttpResponse.json<MfaEnrolment>({
      secret: 'MOCK SECR ETNO TREA LXXX XXXX XXXX',
      label: 'OmniBridge (n***@example.test)',
      qr: mockQr(),
    }),
  ),

  http.post('*/api/auth/mfa/enrolment/confirm', async ({ request }) => {
    const { code } = (await request.json()) as { code?: string };
    if (code !== DEMO_TOTP) return problem(401, 'unauthorized', 'invalid_code');
    const account = current ? ACCOUNTS[current] : undefined;
    if (account) account.mfa = true;
    const recoveryCodes = Array.from({ length: 10 }, (_, i) => {
      const n = (i + 1) * 7919;
      return `mock${String(i)}-${n.toString(36).padStart(5, '0').slice(-5)}`;
    });
    mfaDone = true;
    return HttpResponse.json<MfaConfirmResult>({ recoveryCodes });
  }),

  // Always 202, whether or not the email has an account (no account enumeration).
  http.post('*/api/auth/password/forgot', () => new HttpResponse(null, { status: 202 })),

  http.get('*/api/auth/password/reset/:token', ({ params }) =>
    usable(params.token as string)
      ? HttpResponse.json<ResetTokenInfo>({
          emailMasked: 's***@example.test',
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        })
      : problem(404, 'not_found', 'link_unusable'),
  ),

  http.post('*/api/auth/password/reset', async ({ request }) => {
    const { token, password } = (await request.json()) as { token?: string; password?: string };
    if (!usable(token)) return problem(404, 'not_found', 'link_unusable');
    if ((password ?? '').toLowerCase().includes('password')) return breached();
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/auth/invites/:token', ({ params }) =>
    usable(params.token as string)
      ? HttpResponse.json<InviteInfo>({
          workspaceName: 'Demo workspace',
          invitedBy: 'Sam Admin',
          email: params.token === EXISTING_INVITE ? 'p***@example.test' : 'n***@example.test',
          expiresAt: new Date(Date.now() + 72 * 3_600_000).toISOString(),
          // The demo link /invite/existing-user-invite is for someone who already has a sign-in (T-0204).
          existingUser: params.token === EXISTING_INVITE,
        })
      : problem(404, 'not_found', 'link_unusable'),
  ),

  http.post('*/api/auth/invites/accept', async ({ request }) => {
    const { token, password } = (await request.json()) as { token?: string; password?: string };
    if (!usable(token)) return problem(404, 'not_found', 'link_unusable');
    if (token === EXISTING_INVITE) {
      if (password !== DEMO_PASSWORD) return problem(401, 'unauthorized', 'invalid_credentials');
      current = 'pat.packer@example.test';
      return HttpResponse.json<SignInResult>({ next: 'mfa_code' });
    }
    if ((password ?? '').toLowerCase().includes('password')) return breached();
    current = 'new.user@example.test';
    return HttpResponse.json<SignInResult>({ next: 'mfa_setup' });
  }),

  http.get('*/api/auth/terms', () =>
    HttpResponse.json<TermsInfo>({
      version: TERMS_VERSION,
      termsUrl: 'https://omnibridge.co.uk/terms',
      privacyUrl: 'https://omnibridge.co.uk/privacy',
    }),
  ),

  http.post('*/api/auth/terms', async ({ request }) => {
    const { version } = (await request.json()) as { version?: string };
    // A stale version (the terms changed while the screen was open) is refused, as the server does.
    if (version !== TERMS_VERSION) {
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: '',
          status: 422,
          code: 'validation_failed',
          errors: [{ location: 'body', path: 'version', message: 'stale' }],
        },
        { status: 422, headers: { 'content-type': 'application/problem+json' } },
      );
    }
    const account = current ? ACCOUNTS[current] : undefined;
    if (account) account.termsAccepted = true;
    return HttpResponse.json<TermsAccepted>({
      next: (account?.workspaces ?? 1) > 1 ? 'workspace_picker' : 'app',
    });
  }),

  http.get('*/api/auth/workspaces', () => HttpResponse.json<WorkspaceChoice[]>(MOCK_WORKSPACES)),

  http.post('*/api/auth/workspace', async ({ request }) => {
    const { workspaceId } = (await request.json()) as { workspaceId?: string };
    currentWorkspace = workspaceId;
    return new HttpResponse(null, { status: 204 });
  }),

  // The shape of GET /auth/session (ADR-062): the MFA step until the code is in; then one
  // workspace is entered at once, two wait for the picker.
  http.get('*/api/auth/session', () => {
    const account = current ? ACCOUNTS[current] : undefined;
    if (current === undefined || account === undefined) {
      if (demoSession) return HttpResponse.json<SessionInfo>(personaSessionInfo());
      return problem(401, 'unauthorized', 'no_session');
    }
    if (!mfaDone) {
      return HttpResponse.json<SessionInfo>({
        user: { id: 'usr_mock', name: account.name, email: current },
        next: account.mfa ? 'mfa_code' : 'mfa_setup',
        platform: false,
        workspace: null,
        modules: { website_connector: false },
        incident: mockIncident(),
      });
    }
    if (inConsoleMock())
      return HttpResponse.json(consoleSessionInfo(account.name, current, 'usr_mock'));
    const id = currentWorkspace ?? (account.workspaces === 1 ? 'ws_1' : undefined);
    const ws = MOCK_WORKSPACES.find((w) => w.id === id);
    return HttpResponse.json<SessionInfo>({
      user: { id: 'usr_mock', name: account.name, email: current },
      next:
        ws !== undefined ? null : account.termsAccepted === false ? 'terms' : 'workspace_picker',
      platform: false,
      workspace: ws === undefined ? null : { id: ws.id, name: ws.name, role: ws.role },
      modules: ws?.modules ?? { website_connector: false },
      incident: mockIncident(),
    });
  }),

  // A platform operator enters the console (PLAT-1); anyone else is 403. The demo admin persona
  // is an operator in the mock-ups; the packer is not.
  http.post('*/api/auth/platform', () => {
    const account = current ? ACCOUNTS[current] : undefined;
    const operator =
      account !== undefined
        ? mfaDone && account.platform === true
        : demoSession && getPersona() === 'admin';
    if (!operator) return problem(403, 'forbidden', 'not_platform_admin');
    enterConsoleMock();
    return new HttpResponse(null, { status: 204 });
  }),
];
