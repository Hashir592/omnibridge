// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What the SPA sent: method, path and the CSRF header. */
interface Sent {
  method: string;
  path: string;
  csrf: string | null;
}

async function loadWith(answer: (req: Request) => Response) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: Request) => {
      sent.push({
        method: input.method,
        path: new URL(input.url).pathname,
        csrf: input.headers.get('x-csrf-token'),
      });
      return Promise.resolve(answer(input));
    }),
  );
  vi.resetModules();
  const { authApi } = await import('./api.ts');
  return { authApi, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('SPA auth client (SEC-1, ADR-048)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = '__Host-ob_csrf=; Path=/; Secure; max-age=0';
  });

  it('[SEC-1] state-changing calls echo the __Host-ob_csrf cookie in x-csrf-token', async () => {
    document.cookie = '__Host-ob_csrf=token-from-cookie; Path=/; Secure';
    const { authApi, sent } = await loadWith(() => json(200, { next: 'mfa_code' }));
    const r = await authApi.signIn('sam@example.test', 'a long passphrase');
    expect(r).toMatchObject({ ok: true, status: 200, body: { next: 'mfa_code' } });
    expect(sent).toEqual([
      { method: 'POST', path: '/api/auth/sign-in', csrf: 'token-from-cookie' },
    ]);
  });

  it('[SEC-1] without the cookie it asks for one first; reads send no token', async () => {
    const { authApi, sent } = await loadWith((req) => {
      if (new URL(req.url).pathname === '/api/auth/csrf') {
        document.cookie = '__Host-ob_csrf=fresh-token; Path=/; Secure';
        return new Response(null, { status: 204 });
      }
      return json(200, []);
    });
    await authApi.verifyCode('123456');
    await authApi.workspaces();
    expect(sent).toEqual([
      { method: 'GET', path: '/api/auth/csrf', csrf: null },
      { method: 'POST', path: '/api/auth/mfa/verify', csrf: 'fresh-token' },
      { method: 'GET', path: '/api/auth/workspaces', csrf: null },
    ]);
  });

  it('[USR-5] a lock answer keeps its problem body and Retry-After for the screen', async () => {
    document.cookie = '__Host-ob_csrf=t; Path=/; Secure';
    const { authApi } = await loadWith(() =>
      json(429, { code: 'rate_limited', detail: 'locked' }, { 'retry-after': '900' }),
    );
    expect(await authApi.signIn('sam@example.test', 'wrong')).toEqual({
      ok: false,
      status: 429,
      body: { code: 'rate_limited', detail: 'locked' },
      retryAfter: 900,
    });
  });
});
