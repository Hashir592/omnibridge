import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PASSWORD, DEMO_TOTP, resetAuthMock } from './auth.ts';
import { handlers } from './handlers.ts';

// The auth mock stands in for S3's routes (PS-016), so it must already behave as the server
// will: no account enumeration, lockout for any email, and forgot-password that never tells.

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const res = await getResponse(handlers, req);
  if (!res) throw new Error(`no mock handler for ${method} ${path}`);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as unknown) : undefined,
    retryAfter: res.headers.get('retry-after'),
  };
}

const signIn = (email: string, password: string) =>
  call('POST', '/auth/sign-in', { email, password });

beforeEach(() => {
  resetAuthMock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mock auth API', () => {
  it('[USR-5] an unknown email and a wrong password get the same answer', async () => {
    const unknown = await signIn('nobody@example.test', 'wrong');
    const wrong = await signIn('sam.admin@example.test', 'wrong');
    expect(unknown.status).toBe(401);
    expect(wrong).toEqual(unknown);
  });

  it('[USR-5] locks any email, known or not, after 10 failures in 15 minutes', async () => {
    for (const email of ['nobody@example.test', 'sam.admin@example.test']) {
      const answers = [];
      for (let i = 0; i < 10; i++) answers.push((await signIn(email, 'wrong')).status);
      expect(answers.slice(0, 9)).toEqual(Array(9).fill(401));
      expect(answers[9]).toBe(429);
      const locked = await signIn(email, DEMO_PASSWORD);
      expect(locked.status).toBe(429);
      expect(Number(locked.retryAfter)).toBeGreaterThan(14 * 60);
    }
  });

  it('[USR-5] the lock lasts 15 minutes from the 10th failure, not from the first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-20T09:00:00Z').getTime();
    vi.setSystemTime(t0);
    for (let i = 0; i < 9; i++) await signIn('pat.packer@example.test', 'wrong');
    vi.setSystemTime(t0 + 14 * 60_000);
    expect((await signIn('pat.packer@example.test', 'wrong')).status).toBe(429);
    // 15 minutes after the first failure the lock still holds: it started at the 10th.
    vi.setSystemTime(t0 + 16 * 60_000);
    const still = await signIn('pat.packer@example.test', DEMO_PASSWORD);
    expect(still.status).toBe(429);
    expect(Number(still.retryAfter)).toBe(13 * 60);
    vi.setSystemTime(t0 + 29 * 60_000 + 1000);
    expect((await signIn('pat.packer@example.test', DEMO_PASSWORD)).status).toBe(200);
  });

  it('[USR-4] a user without MFA is sent to enrolment, and gets 10 recovery codes', async () => {
    expect((await signIn('new.user@example.test', DEMO_PASSWORD)).body).toEqual({
      next: 'mfa_setup',
    });
    const enrol = (await call('POST', '/auth/mfa/enrolment')).body as { qr: string[] };
    expect(enrol.qr.length).toBeGreaterThan(20);
    const wrong = await call('POST', '/auth/mfa/enrolment/confirm', { code: '000000' });
    expect(wrong.status).toBe(401);
    const ok = await call('POST', '/auth/mfa/enrolment/confirm', { code: DEMO_TOTP });
    const codes = (ok.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(new Set(codes).size).toBe(10);
  });

  it('[USR-4] a user with MFA must enter a code; several workspaces lead to the picker', async () => {
    expect((await signIn('sam.admin@example.test', DEMO_PASSWORD)).body).toEqual({
      next: 'mfa_code',
    });
    expect((await call('POST', '/auth/mfa/verify', { code: '000000' })).status).toBe(401);
    expect((await call('POST', '/auth/mfa/verify', { code: DEMO_TOTP })).body).toEqual({
      next: 'workspace_picker',
    });
  });

  it('[USR-7] forgot password answers 202 whether or not the email has an account', async () => {
    const known = await call('POST', '/auth/password/forgot', {
      email: 'sam.admin@example.test',
    });
    const unknown = await call('POST', '/auth/password/forgot', {
      email: 'nobody@example.test',
    });
    expect(known.status).toBe(202);
    expect(unknown).toEqual(known);
  });

  it('[USR-7] [TEN-7] used or expired reset and invite links get one 404', async () => {
    expect((await call('GET', '/auth/password/reset/expired')).status).toBe(404);
    expect((await call('GET', '/api/mock/invites/expired')).status).toBe(404);
    expect((await call('GET', '/auth/password/reset/demo-reset')).status).toBe(200);
  });

  it('[USR-3] a leaked password is refused with the rule id', async () => {
    const r = await call('POST', '/auth/password/reset', {
      token: 'demo-reset',
      password: 'my password is long',
    });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'validation_failed', errors: [{ message: 'breached' }] });
  });
});
