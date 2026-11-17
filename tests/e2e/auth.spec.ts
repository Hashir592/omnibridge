import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * DEV ONLY demo sign-in, the same values as apps/web/src/auth/dev-seed.ts (the seed service puts
 * them in the dev stack's database only). Synthetic; never reuse any of them.
 */
const DEMO = {
  email: 'demo.admin@example.test',
  password: 'DEV ONLY lantern harbour 2026',
  totpSecret: Buffer.from('DEV-ONLY-TOTP-SECRET', 'utf8'),
};

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), as the authenticator app computes it. */
function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

const step = () => Math.floor(Date.now() / 30_000);

async function csrf(request: APIRequestContext): Promise<string> {
  const cookie = (await request.storageState()).cookies.find((c) => c.name === 'ob_csrf');
  if (cookie === undefined) throw new Error('no ob_csrf cookie');
  return cookie.value;
}

test('[AT-3] login with TOTP', async ({ request, baseURL }) => {
  // Room to wait out one 30-second TOTP step on a retry.
  test.setTimeout(75_000);
  const origin = new URL(baseURL ?? 'https://localhost:8443').origin;
  const post = async (path: string, data: object) =>
    request.post(path, {
      data,
      headers: { origin, 'x-csrf-token': await csrf(request) },
    });

  expect((await request.get('/api/auth/csrf')).status()).toBe(204);
  const signIn = await post('/api/auth/sign-in', { email: DEMO.email, password: DEMO.password });
  expect(signIn.status()).toBe(200);
  expect(await signIn.json()).toEqual({ next: 'mfa_code' });
  // The password alone opens no workspace route (USR-4).
  expect((await request.get('/api/companies')).status()).toBe(401);

  // Each code works once: if this step's code was already used (a retry), wait for the next one.
  let verify = await post('/api/auth/mfa/verify', { code: totp(DEMO.totpSecret, step()) });
  if (verify.status() === 401) {
    const next = (step() + 1) * 30_000;
    await new Promise((resolve) => setTimeout(resolve, next - Date.now() + 500));
    verify = await post('/api/auth/mfa/verify', { code: totp(DEMO.totpSecret, step()) });
  }
  expect(verify.status()).toBe(200);
  // WWW-7: on a fresh stack the demo user accepts the current terms first.
  const after = (await verify.json()) as { next: string };
  if (after.next === 'terms') {
    const terms = (await (await request.get('/api/auth/terms')).json()) as { version: string };
    const accepted = await post('/api/auth/terms', { version: terms.version });
    expect(await accepted.json()).toEqual({ next: 'app' });
  } else {
    expect(after).toEqual({ next: 'app' });
  }

  const companies = await request.get('/api/companies');
  expect(companies.status()).toBe(200);
  expect(((await companies.json()) as { items: unknown[] }).items).toHaveLength(3);

  // Signing out ends it.
  expect((await post('/api/auth/sign-out', {})).status()).toBe(204);
  expect((await request.get('/api/companies')).status()).toBe(401);
});
