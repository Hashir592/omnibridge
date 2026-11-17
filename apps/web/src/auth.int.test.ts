import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  AccessReviewRepository,
  AuditLog,
  AuthStore,
  CompanyRepository,
  createMainDb,
  InviteRepository,
  issuePasswordReset,
  MemberAccessRepository,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';
import { HashGate, Passwords } from './auth/passwords.ts';
import { PlatformKeys, totpAad } from './auth/platform-keys.ts';
import { AuthService, type AuthNotifier, type AuthServiceOptions } from './auth/service.ts';
import { newTotpSecret, recoveryCodeHmac, totpCode, totpStep } from './auth/totp.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const ORIGIN = 'https://app.omnibridge.test';
const TERMS = '2026-11-15';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };
const PASSWORD = 'tangerine harbour lantern 47';

type Server = ReturnType<typeof buildWebApp>;

/** A browser: keeps cookies, sends the Origin and echoes the CSRF cookie (what the SPA does). */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly server: Server;
  readonly ip: string;

  constructor(server: Server, ip = '192.0.2.10') {
    this.server = server;
    this.ip = ip;
  }

  async send(
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    opts: { csrf?: string | null; origin?: string | null; headers?: Record<string, string> } = {},
  ) {
    const csrf = opts.csrf === undefined ? this.cookies.get('__Host-ob_csrf') : opts.csrf;
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    const res = await this.server.inject({
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        ...(this.cookies.size === 0
          ? {}
          : { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }),
        ...(origin === null ? {} : { origin }),
        ...(csrf == null ? {} : { 'x-csrf-token': csrf }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...opts.headers,
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    const set = res.headers['set-cookie'];
    for (const line of Array.isArray(set) ? set : set === undefined ? [] : [set]) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/Max-Age=0/i.test(line) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async start() {
    await this.send('GET', '/api/auth/csrf');
    return this;
  }

  signIn(email: string, password: string) {
    return this.send('POST', '/api/auth/sign-in', { email, password });
  }
}

describe('passwords, MFA, lockout and sessions (USR-2 to USR-7, SEC-1, AT-3)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let owner: pg.Pool;
  let store: AuthStore;
  let tenancy: Tenancy;
  let passwords: Passwords;
  let platformKeys: PlatformKeys;
  let clock = new Date('2026-10-21T09:00:00.000Z');
  const hmacKey = Buffer.alloc(32, 9);
  const keyring = parseKeyring('secrets', generateKekLine(1));
  const notified = {
    locked: [] as Parameters<AuthNotifier['locked']>[0][],
    reset: [] as Parameters<AuthNotifier['passwordReset']>[0][],
  };
  const A = randomUUID();
  const B = randomUUID();
  const companyA = { id: '' };

  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  const serviceOptions = (gate?: HashGate): AuthServiceOptions => ({
    store,
    passwords: gate === undefined ? passwords : new Passwords(gate),
    platformKeys,
    tenancy,
    audit: new AuditLog(main.db),
    notifier: {
      locked: (input) => {
        notified.locked.push(input);
        return Promise.resolve();
      },
      passwordReset: (input) => {
        notified.reset.push(input);
        return Promise.resolve();
      },
      invite: () => Promise.resolve(),
    },
    logger,
    hmacKey,
    origins: [ORIGIN],
    termsVersion: TERMS,
    now: () => clock,
  });
  const service = (gate?: HashGate) => new AuthService(serviceOptions(gate));

  const app = (auth = service(), trustedProxies?: string, log = logger) =>
    buildWebApp({
      ...(trustedProxies === undefined ? {} : { trustedProxies }),
      logger: log,
      version: '0',
      checks,
      tenancy,
      directory: {
        workspaces: new WorkspaceRepository(main.db),
        companies: new CompanyRepository(main.db),
      },
      audit: new AuditLog(main.db),
      auth,
      people: {
        members: new MemberAccessRepository(main.db),
        invites: new InviteRepository(main.db),
        reviews: new AccessReviewRepository(main.db),
        workspaces: new WorkspaceRepository(main.db),
        store,
        notifier: { invite: () => Promise.resolve() },
        audit: new AuditLog(main.db),
        tenancy,
      },
    });

  /** An invite to workspace A with a token the test holds, as the worker would mail it. */
  async function inviteLink(email: string, role: 'admin' | 'member' = 'member') {
    const raw = randomBytes(32).toString('base64url');
    await tenancy.runWorkspace({ workspaceId: A }, async (ctx) => {
      const repo = new InviteRepository(main.db);
      const created = await repo.create(ctx, { email, role, tabs: [], companyIds: [] }, clock);
      await repo.setToken(ctx, created.id, createHash('sha256').update(raw).digest());
    });
    return raw;
  }

  /** The user-level auth events of a user (ADR-052), read as the owner. */
  const authEvents = async (userId: string) =>
    (
      await owner.query<{ action: string; ip: string }>(
        'SELECT action, host(ip) AS ip FROM app.auth_events WHERE user_id = $1 ORDER BY id',
        [userId],
      )
    ).rows;

  /** A user with a password and, unless `mfa` is false, a confirmed TOTP secret. */
  async function makeUser(
    opts: {
      workspaces?: readonly string[];
      mfa?: boolean;
      name?: string;
      passwordAgeMs?: number;
      /** False: the current terms are not accepted yet (WWW-7). */
      terms?: boolean;
    } = {},
  ) {
    const id = randomUUID();
    const email = `u${id.slice(0, 8)}@example.test`;
    const name = opts.name ?? 'Robin Tester';
    const workspaces = opts.workspaces ?? [A];
    for (const [i, ws] of workspaces.entries()) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: id }, async (ctx) => {
        if (i === 0) await new UserRepository(main.db).create(ctx, { id, email, name });
        await new MembershipRepository(main.db).add(ctx, { userId: id, role: 'admin' });
      });
    }
    const setAt = new Date(clock.getTime() - (opts.passwordAgeMs ?? 2 * DAY));
    await store.setPassword(id, await passwords.hash(PASSWORD), setAt);
    const secret = newTotpSecret();
    const recovery = ['AAAA-BBBB-CCCC-DDDD'];
    if (opts.mfa !== false) {
      const key = await platformKeys.current();
      await store.setPendingTotp(id, key.encrypt(secret, totpAad(id)), key.version);
      const hmacs = Array.from({ length: 10 }, (_, k) =>
        recoveryCodeHmac(
          hmacKey,
          id,
          k === 0 ? (recovery[0] ?? '') : `ZZZZ-ZZZZ-ZZZZ-ZZ${'ABCDEFGHIJ'.charAt(k)}A`,
        ),
      );
      await store.confirmTotp(id, totpStep(clock) - 10, hmacs, clock);
    }
    if (opts.terms !== false) await store.acceptTerms(id, TERMS, clock, '192.0.2.1');
    return { id, email, name, secret, recovery: recovery[0] ?? '' };
  }

  const code = (secret: Buffer) => totpCode(secret, totpStep(clock));

  /** Password and TOTP: a full sign-in. */
  async function signedIn(server: Server, user: { email: string; secret: Buffer }) {
    const b = await new Browser(server).start();
    expect((await b.signIn(user.email, PASSWORD)).statusCode).toBe(200);
    later(30_000); // a fresh TOTP step every time
    const v = await b.send('POST', '/api/auth/mfa/verify', { code: code(user.secret) });
    expect(v.statusCode).toBe(200);
    return { b, next: v.json<{ next: string }>().next };
  }

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 8 });
    owner = new pg.Pool({ ...cluster.connection('ob_owner'), max: 2 });
    store = new AuthStore(main.db);
    tenancy = new Tenancy(main.db);
    passwords = new Passwords();
    platformKeys = new PlatformKeys(store, keyring);
    for (const [ws, name] of [
      [A, 'Workspace A'],
      [B, 'Workspace B'],
    ] as const) {
      await tenancy.run({ workspaceId: ws, companyIds: [] }, (ctx) =>
        new WorkspaceRepository(main.db).create(ctx, { name }),
      );
    }
    companyA.id = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      new CompanyRepository(main.db).create(ctx, {
        legalName: 'A Ltd',
        tradingName: 'A',
        registeredAddress: address,
      }),
    );
  });

  afterAll(async () => {
    await owner.end();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[USR-4][AT-3] no workspace route is reachable before MFA is set up and verified', async () => {
    const server = app();
    // MFA set up: the password alone opens nothing but the MFA routes.
    const user = await makeUser();
    const b = await new Browser(server).start();
    const first = await b.signIn(user.email, PASSWORD);
    expect(first.json()).toEqual({ next: 'mfa_code' });
    expect(first.headers['cache-control']).toBe('no-store');
    for (const url of ['/api/companies', '/api/auth/workspaces', '/api/audit-events']) {
      expect({ url, status: (await b.send('GET', url)).statusCode }).toEqual({ url, status: 401 });
    }
    later(30_000);
    const wrong = await b.send('POST', '/api/auth/mfa/verify', { code: '000000' });
    expect(wrong.statusCode).toBe(401);
    const ok = await b.send('POST', '/api/auth/mfa/verify', { code: code(user.secret) });
    expect(ok.json()).toEqual({ next: 'app' });
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(200);
    // The same code cannot be used twice (no replay).
    const again = await new Browser(server).start();
    await again.signIn(user.email, PASSWORD);
    expect(
      (await again.send('POST', '/api/auth/mfa/verify', { code: code(user.secret) })).statusCode,
    ).toBe(401);

    // MFA not set up: sign-in leads to enrolment, and still nothing else opens.
    const fresh = await makeUser({ mfa: false });
    const c = await new Browser(server).start();
    expect((await c.signIn(fresh.email, PASSWORD)).json()).toEqual({ next: 'mfa_setup' });
    expect((await c.send('GET', '/api/companies')).statusCode).toBe(401);
    expect((await c.send('POST', '/api/auth/mfa/verify', { code: '123456' })).statusCode).toBe(403);
    const enrol = await c.send('POST', '/api/auth/mfa/enrolment');
    expect(enrol.statusCode).toBe(200);
    expect(enrol.headers['cache-control']).toBe('no-store');
    const view = enrol.json<{ secret: string; label: string; qr: string[] }>();
    expect(view.label).toMatch(/^OmniBridge \(u\*\*\*@example\.test\)$/);
    expect(view.qr.length).toBeGreaterThan(20);
    const secret = Buffer.from(base32Decode(view.secret.replaceAll(' ', '')));
    later(30_000);
    const confirm = await c.send('POST', '/api/auth/mfa/enrolment/confirm', { code: code(secret) });
    expect(confirm.statusCode).toBe(200);
    const { recoveryCodes } = confirm.json<{ recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);
    for (const r of recoveryCodes) expect(r).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect((await c.send('GET', '/api/companies')).statusCode).toBe(200);
    // Enrolment cannot be restarted once confirmed.
    const d = await new Browser(server).start();
    await d.signIn(fresh.email, PASSWORD);
    expect((await d.send('POST', '/api/auth/mfa/enrolment')).statusCode).toBe(403);
    await server.close();
  });

  it('[USR-4] a recovery code signs in once and says how many are left', async () => {
    const server = app();
    const user = await makeUser();
    const b = await new Browser(server).start();
    await b.signIn(user.email, PASSWORD);
    const used = await b.send('POST', '/api/auth/mfa/recovery', {
      code: user.recovery.toLowerCase(),
    });
    expect(used.json()).toEqual({ next: 'app', recoveryCodesLeft: 9 });
    const c = await new Browser(server).start();
    await c.signIn(user.email, PASSWORD);
    expect(
      (await c.send('POST', '/api/auth/mfa/recovery', { code: user.recovery })).statusCode,
    ).toBe(401);
    await server.close();
  });

  it('[USR-5][AT-3] 10 failures lock for 15 minutes and notify', async () => {
    const server = app();
    const user = await makeUser();
    const b = await new Browser(server, '192.0.2.21').start();
    const before = notified.locked.length;
    for (let i = 1; i <= 9; i += 1) {
      later(31_000); // past the per-address delay, well inside 15 minutes
      expect((await b.signIn(user.email, `wrong password ${String(i)}`)).statusCode).toBe(401);
    }
    later(31_000);
    const tenth = await b.signIn(user.email, 'wrong password 10');
    expect(tenth.statusCode).toBe(429);
    expect(tenth.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(tenth.headers['retry-after'])).toBe(15 * 60);
    // The right password does not open it during the lock.
    later(14 * MIN);
    expect((await b.signIn(user.email, PASSWORD)).statusCode).toBe(429);
    // The user and the workspace admins are told, once (the worker sends the mail).
    const told = notified.locked.slice(before);
    expect(told.map((n) => ({ userId: n.userId, workspaceIds: n.workspaceIds }))).toEqual([
      { userId: user.id, workspaceIds: [A] },
    ]);
    expect(told[0]?.lockedUntil.getTime()).toBe(clock.getTime() + MIN);
    // Failures are kept per person, never in a workspace's audit log (ADR-052).
    const events = await authEvents(user.id);
    expect(events.map((e) => e.action)).toContain('auth.locked');
    expect(events.filter((e) => e.action === 'auth.login_failed')).toHaveLength(10);
    const inWorkspace = await tenancy.run({ workspaceId: A, companyIds: [] }, (ctx) =>
      new AuditLog(main.db).list(ctx, { userId: user.id }, { limit: 50 }),
    );
    expect(inWorkspace.items.map((e) => e.action)).not.toContain('auth.login_failed');
    // 15 minutes after the 10th failure it opens again.
    later(MIN);
    expect((await b.signIn(user.email, PASSWORD)).statusCode).toBe(200);
    await server.close();
  });

  it('[USR-5] an unknown email locks exactly like a real one and its plaintext is never stored', async () => {
    const server = app();
    const real = await makeUser();
    const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;
    const answers: { status: number; body: unknown; retry: unknown }[][] = [[], []];
    const before = notified.locked.length;
    for (const [k, email] of [real.email, unknown].entries()) {
      const b = await new Browser(server, `192.0.2.${String(30 + k)}`).start();
      for (let i = 1; i <= 10; i += 1) {
        later(31_000);
        const res = await b.signIn(email, 'not the password');
        answers[k]?.push({
          status: res.statusCode,
          body: { ...res.json<object>(), request_id: undefined },
          retry: res.headers['retry-after'],
        });
      }
    }
    // Same statuses, same bodies, same Retry-After: the lock says nothing about the email.
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[1]?.at(-1)).toMatchObject({ status: 429, retry: String(15 * 60) });
    // Only the real account's lock is reported.
    expect(notified.locked.slice(before).map((n) => n.userId)).toEqual([real.id]);
    // The unknown email is in no auth table and no queued job, in any form.
    for (const table of ['login_counters', 'ip_counters', 'sessions', 'password_resets']) {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.${table} t WHERE t::text ILIKE $1 OR t::text ILIKE $2`,
        [`%${unknown}%`, `%${Buffer.from(unknown).toString('hex')}%`],
      );
      expect({ table, n: rows[0]?.n }).toEqual({ table, n: '0' });
    }
    const { rows: jobs } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pgboss.job WHERE data::text ILIKE $1`,
      [`%${unknown}%`],
    );
    expect(jobs[0]?.n).toBe('0');
    await server.close();
  });

  it('[USR-5] a lock set by attempts running at the same time beats a right password', async () => {
    const user = await makeUser();
    const key = service().emailKey(user.email);
    // While this sign-in hashes, ten other attempts fail and lock the email.
    class RacingPasswords extends Passwords {
      override async check(stored: string | undefined, password: string): Promise<boolean> {
        for (let i = 0; i < 10; i += 1) await store.recordFailure(key, '198.51.100.250', clock);
        return super.check(stored, password);
      }
    }
    const racing = new AuthService({
      store,
      passwords: new RacingPasswords(),
      platformKeys,
      tenancy,
      audit: new AuditLog(main.db),
      notifier: {
        locked: () => Promise.resolve(),
        passwordReset: () => Promise.resolve(),
        invite: () => Promise.resolve(),
      },
      logger,
      hmacKey,
      origins: [ORIGIN],
      termsVersion: TERMS,
      now: () => clock,
    });
    const server = app(racing);
    const b = await new Browser(server, '192.0.2.60').start();
    const res = await b.signIn(user.email, PASSWORD);
    expect(res.statusCode).toBe(429);
    expect(b.cookies.has('__Host-ob_session')).toBe(false);
    await server.close();
  });

  it('[USR-5] the client address comes through the private-network edge, never from a public peer', async () => {
    const server = app(service(), 'uniquelocal');
    const user = await makeUser();
    const viaEdge = await new Browser(server, '172.18.0.4').start();
    later(31_000);
    await viaEdge.send(
      'POST',
      '/api/auth/sign-in',
      { email: user.email, password: 'wrong one' },
      { headers: { 'x-forwarded-for': '203.0.113.99' } },
    );
    const direct = await new Browser(server, '198.51.100.77').start();
    later(31_000);
    await direct.send(
      'POST',
      '/api/auth/sign-in',
      { email: user.email, password: 'wrong two' },
      { headers: { 'x-forwarded-for': '203.0.113.98' } },
    );
    const events = (await authEvents(user.id)).filter((e) => e.action === 'auth.login_failed');
    expect(events.map((e) => e.ip).sort()).toEqual(['198.51.100.77', '203.0.113.99']);
    await server.close();
  });

  it('[USR-5] one address that keeps failing waits, with Retry-After', async () => {
    const server = app();
    const b = await new Browser(server, '192.0.2.40').start();
    for (let i = 0; i < 4; i += 1) {
      expect((await b.signIn(`x${String(i)}@example.test`, 'nope nope nope')).statusCode).toBe(401);
    }
    const slowed = await b.signIn('another@example.test', 'nope nope nope');
    expect(slowed.statusCode).toBe(429);
    expect(Number(slowed.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    later(31_000);
    expect((await b.signIn('another@example.test', 'nope nope nope')).statusCode).toBe(401);
    await server.close();
  });

  it('[USR-3] rejects breached, short, name-containing and reused passwords', async () => {
    const server = app();
    const user = await makeUser({ name: 'Morgan Quayle' });
    const { b } = await signedIn(server, user);
    const change = (password: string, currentPassword = PASSWORD) =>
      b.send('POST', '/api/auth/password/change', { currentPassword, password });
    const rules = async (password: string) => {
      const res = await change(password);
      expect(res.statusCode).toBe(422);
      return res
        .json<{ code: string; errors: { path: string; message: string }[] }>()
        .errors.map((e) => `${e.path}:${e.message}`);
    };
    expect(await rules('short')).toContain('password:length');
    expect(await rules('Password123!')).toEqual(['password:breached']);
    expect(await rules('iloveyou2026!')).toEqual(['password:breached']);
    expect(await rules('quayle forever and ever')).toEqual(['password:personal']);
    expect(await rules(`${user.email.split('@')[0] ?? ''} is my login`)).toEqual([
      'password:personal',
    ]);
    expect(await rules(PASSWORD)).toEqual(['password:history']);
    expect((await change('a much better passphrase', 'wrong current')).json()).toMatchObject({
      errors: [{ path: 'currentPassword' }],
    });
    // A good one is accepted; every session then ends.
    expect((await change('copper meadow violin 83')).statusCode).toBe(204);
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(401);
    // Minimum age: not again within a day.
    const again = await signedIn(server, { email: user.email, secret: user.secret }).catch(
      () => undefined,
    );
    expect(again).toBeUndefined(); // the old password no longer works
    const c = await new Browser(server).start();
    expect((await c.signIn(user.email, 'copper meadow violin 83')).statusCode).toBe(200);
    later(30_000);
    await c.send('POST', '/api/auth/mfa/verify', { code: code(user.secret) });
    const tooSoon = await c.send('POST', '/api/auth/password/change', {
      currentPassword: 'copper meadow violin 83',
      password: 'another fine passphrase 11',
    });
    expect(tooSoon.json<{ errors: { message: string }[] }>().errors.map((e) => e.message)).toEqual([
      'min_age',
    ]);
    await server.close();
  });

  it('[USR-5][USR-3] a wrong current password counts toward the same lock as sign-in', async () => {
    const server = app();
    const signIn = async (user: { email: string; secret: Buffer }, ip: string) => {
      const b = await new Browser(server, ip).start();
      expect((await b.signIn(user.email, PASSWORD)).statusCode).toBe(200);
      later(30_000);
      expect(
        (await b.send('POST', '/api/auth/mfa/verify', { code: code(user.secret) })).statusCode,
      ).toBe(200);
      return b;
    };
    const change = (b: Browser, currentPassword: string) =>
      b.send('POST', '/api/auth/password/change', {
        currentPassword,
        password: 'harbour lantern quartz 52',
      });

    // 10 wrong current passwords lock the email; the 10th answers 429 with Retry-After.
    const one = await makeUser();
    const b1 = await signIn(one, '192.0.2.61');
    for (let i = 1; i <= 9; i += 1) {
      later(31_000); // past the per-address delay
      expect((await change(b1, `wrong current ${String(i)}`)).statusCode).toBe(422);
    }
    later(31_000);
    const tenth = await change(b1, 'wrong current 10');
    expect(tenth.statusCode).toBe(429);
    expect(Number(tenth.headers['retry-after'])).toBe(15 * 60);
    // The right current password is refused while the lock lasts, and so is sign-in.
    later(31_000);
    expect((await change(b1, PASSWORD)).statusCode).toBe(429);
    expect(
      (await (await new Browser(server, '192.0.2.62').start()).signIn(one.email, PASSWORD))
        .statusCode,
    ).toBe(429);

    // A lock started by sign-in failures blocks the change too.
    const two = await makeUser();
    const b2 = await signIn(two, '192.0.2.63');
    const attacker = await new Browser(server, '192.0.2.64').start();
    for (let i = 1; i <= 10; i += 1) {
      later(31_000);
      await attacker.signIn(two.email, `guess ${String(i)}`);
    }
    expect((await change(b2, PASSWORD)).statusCode).toBe(429);
    await server.close();
  });

  it('[USR-3] a password older than 365 days must be changed before anything else', async () => {
    const server = app();
    const user = await makeUser({ passwordAgeMs: 366 * DAY });
    const { b, next } = await signedIn(server, user);
    expect(next).toBe('password_change');
    expect((await b.send('GET', '/api/auth/workspaces')).statusCode).toBe(403);
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(401);
    const res = await b.send('POST', '/api/auth/password/change', {
      currentPassword: PASSWORD,
      password: 'saffron glacier pebble 64',
    });
    expect(res.statusCode).toBe(204);
    await server.close();
  });

  it('[USR-6] idle 30 min and absolute 12 h expiry', async () => {
    const server = app();
    const user = await makeUser();
    const { b } = await signedIn(server, user);
    later(29 * MIN);
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(200);
    later(29 * MIN);
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(200);
    later(30 * MIN);
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(401);

    // Active all the time, it still ends 12 hours after sign-in.
    const { b: busy } = await signedIn(server, user);
    for (let elapsed = 0; elapsed < 12 * HOUR - 25 * MIN; elapsed += 25 * MIN) {
      later(25 * MIN);
      expect((await busy.send('GET', '/api/companies')).statusCode).toBe(200);
    }
    later(25 * MIN);
    expect((await busy.send('GET', '/api/companies')).statusCode).toBe(401);
    await server.close();
  });

  it('[USR-6] sign out on all devices ends every session of the user', async () => {
    const server = app();
    const user = await makeUser();
    const { b: laptop } = await signedIn(server, user);
    const { b: phone } = await signedIn(server, user);
    expect((await laptop.send('POST', '/api/auth/sign-out-all')).statusCode).toBe(204);
    expect((await phone.send('GET', '/api/companies')).statusCode).toBe(401);
    expect((await laptop.send('GET', '/api/companies')).statusCode).toBe(401);
    // Plain sign-out ends only this browser's session.
    const { b: one } = await signedIn(server, user);
    const { b: two } = await signedIn(server, user);
    expect((await one.send('POST', '/api/auth/sign-out')).statusCode).toBe(204);
    expect((await one.send('GET', '/api/companies')).statusCode).toBe(401);
    expect((await two.send('GET', '/api/companies')).statusCode).toBe(200);
    await server.close();
  });

  it('[USR-7] reset link expires after 30 minutes and reset does not bypass MFA', async () => {
    const auth = service();
    const server = app(auth);
    const user = await makeUser();
    const anon = await new Browser(server).start();
    const before = notified.reset.length;
    expect(
      (await anon.send('POST', '/api/auth/password/forgot', { email: user.email })).statusCode,
    ).toBe(202);
    expect(
      (await anon.send('POST', '/api/auth/password/forgot', { email: 'nobody@example.test' }))
        .statusCode,
    ).toBe(202);
    await auth.idle();
    // One mail job, for the real account only; the worker makes the link.
    expect(notified.reset.slice(before)).toEqual([{ userId: user.id, workspaceId: A }]);

    const stale = await issuePasswordReset(store, user.id, clock);
    const info = await anon.send('GET', `/api/auth/password/reset/${stale.token}`);
    expect(info.json()).toEqual({
      emailMasked: `u***@example.test`,
      expiresAt: stale.expiresAt.toISOString(),
    });
    later(30 * MIN);
    expect((await anon.send('GET', `/api/auth/password/reset/${stale.token}`)).statusCode).toBe(
      404,
    );
    expect(
      (await anon.send('POST', '/api/auth/password/reset', { token: stale.token, password: 'x' }))
        .statusCode,
    ).toBe(404);

    const { b: oldSession } = await signedIn(server, user);
    const link = await issuePasswordReset(store, user.id, clock);
    const weak = await anon.send('POST', '/api/auth/password/reset', {
      token: link.token,
      password: 'password',
    });
    expect(weak.statusCode).toBe(422);
    const done = await anon.send('POST', '/api/auth/password/reset', {
      token: link.token,
      password: 'lavender canyon whistle 29',
    });
    expect(done.statusCode).toBe(204);
    expect(
      (
        await anon.send('POST', '/api/auth/password/reset', {
          token: link.token,
          password: 'another one entirely 55',
        })
      ).statusCode,
    ).toBe(404);
    // Every session ended, and signing in again still needs MFA.
    expect((await oldSession.send('GET', '/api/companies')).statusCode).toBe(401);
    const b = await new Browser(server).start();
    expect((await b.signIn(user.email, 'lavender canyon whistle 29')).json()).toEqual({
      next: 'mfa_code',
    });
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(401);
    await server.close();
  });

  it('[SEC-5][USR-7] the reset token in the link lookup path never reaches the request log', async () => {
    const lines: string[] = [];
    const captured = createLogger({
      service: 'test',
      version: '0',
      destination: { write: (line: string) => lines.push(line) },
    });
    const web = await app(service(), undefined, captured);
    const marker = `TOKENMARK${randomUUID().replaceAll('-', '')}`;
    const res = await web.inject({ method: 'GET', url: `/api/auth/password/reset/${marker}` });
    expect(res.statusCode).toBe(404);
    const text = lines.join('');
    expect(text).toContain('/api/auth/password/reset/[REDACTED]');
    expect(text).not.toContain(marker);
    await web.close();
  });

  it('[USR-7] forgot-password answers before any lookup, so a real email takes no longer', async () => {
    // A store whose reset bookkeeping never finishes: the 202 must not wait for it (F-M02h-04).
    const hung = new Proxy(store, {
      get: (target, prop, receiver) =>
        prop === 'allowReset'
          ? () => new Promise<boolean>(() => undefined)
          : (Reflect.get(target, prop, receiver) as unknown),
    });
    const auth = new AuthService({ ...serviceOptions(), store: hung });
    const server = app(auth);
    const user = await makeUser();
    const anon = await new Browser(server).start();
    const res = await anon.send('POST', '/api/auth/password/forgot', { email: user.email });
    expect(res.statusCode).toBe(202);
    await server.close();
  });

  it('[USR-7][SEC-1] reset mail is capped at 3 an hour per address; over the cap it still answers 202', async () => {
    const auth = service();
    const server = app(auth);
    const user = await makeUser();
    const anon = await new Browser(server, '192.0.2.71').start();
    const before = notified.reset.length;
    for (let i = 0; i < 5; i += 1) {
      later(61_000); // past the one-a-minute job key, so only the cap can stop a mail
      const res = await anon.send('POST', '/api/auth/password/forgot', { email: user.email });
      expect(res.statusCode).toBe(202);
      await auth.idle();
    }
    expect(notified.reset.slice(before)).toHaveLength(3);
    // An hour after the first, one more is allowed.
    later(60 * MIN);
    await anon.send('POST', '/api/auth/password/forgot', { email: user.email });
    await auth.idle();
    expect(notified.reset.slice(before)).toHaveLength(4);
    await server.close();
  });

  it('[WWW-7] a new version forces re-acceptance; acceptance is audited', async () => {
    const one = await makeUser({ terms: false });
    // Not accepted yet: MFA passes, but nothing opens until the terms are accepted.
    const server = app();
    const first = await signedIn(server, one);
    expect(first.next).toBe('terms');
    expect((await first.b.send('GET', '/api/companies')).statusCode).toBe(401);
    expect((await first.b.send('POST', '/api/auth/workspace', { workspaceId: A })).statusCode).toBe(
      403,
    );
    const terms = await first.b.send('GET', '/api/auth/terms');
    expect(terms.json()).toMatchObject({ version: TERMS });
    expect(
      (await first.b.send('POST', '/api/auth/terms', { version: '2025-01-01' })).statusCode,
    ).toBe(422);
    const accepted = await first.b.send('POST', '/api/auth/terms', { version: TERMS });
    expect(accepted.json()).toEqual({ next: 'app' });
    expect((await first.b.send('GET', '/api/companies')).statusCode).toBe(200);
    // Next sign-in: accepted, straight in.
    expect((await signedIn(server, one)).next).toBe('app');

    // A new version: asked again at the next sign-in.
    const NEW = '2027-01-01';
    const v2 = app(new AuthService({ ...serviceOptions(), termsVersion: NEW }));
    const again = await signedIn(v2, one);
    expect(again.next).toBe('terms');
    expect((await again.b.send('POST', '/api/auth/terms', { version: NEW })).statusCode).toBe(200);

    // The log: each version with its time and address, and it cannot be changed.
    const rows = await owner.query<{ version: string; ip: string }>(
      'SELECT version, host(ip) AS ip FROM app.terms_acceptances WHERE user_id = $1 ORDER BY id',
      [one.id],
    );
    expect(rows.rows.map((r) => r.version)).toEqual([TERMS, NEW]);
    await server.close();
    await v2.close();
    await expect(
      owner.query('DELETE FROM app.terms_acceptances WHERE user_id = $1', [one.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('[USR-1][USR-4] accepting an invite sets the first password and still needs MFA; the link works once', async () => {
    const server = app();
    const email = `new-${randomUUID().slice(0, 8)}@example.test`;
    const token = await inviteLink(email);
    const anon = await new Browser(server).start();
    const info = await anon.send('GET', `/api/auth/invites/${token}`);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ email: 'n***@example.test', existingUser: false });
    // USR-3 rules apply to the first password.
    const weak = await anon.send('POST', '/api/auth/invites/accept', {
      token,
      name: 'Nova Newcomer',
      password: 'password123',
    });
    expect(weak.statusCode).toBe(422);
    const ok = await anon.send('POST', '/api/auth/invites/accept', {
      token,
      name: 'Nova Newcomer',
      password: 'lantern orchard copper 17',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ next: 'mfa_setup' });
    // The new session is pre-MFA: no workspace route yet (USR-4).
    expect((await anon.send('GET', '/api/companies')).statusCode).toBe(401);
    // Used once.
    expect((await anon.send('GET', `/api/auth/invites/${token}`)).statusCode).toBe(404);
    expect(
      (
        await anon.send('POST', '/api/auth/invites/accept', {
          token,
          name: 'Nova Newcomer',
          password: 'lantern orchard copper 17',
        })
      ).statusCode,
    ).toBe(404);
    // And the new person can sign in with the password they chose.
    const again = await new Browser(server).start();
    expect((await again.signIn(email, 'lantern orchard copper 17')).json()).toEqual({
      next: 'mfa_setup',
    });
    await server.close();
  });

  it('[USR-1][USR-5] someone who already has a sign-in confirms the invite with their password', async () => {
    const server = app();
    const user = await makeUser({ workspaces: [B] });
    const token = await inviteLink(user.email);
    const b = await new Browser(server, '192.0.2.81').start();
    expect((await b.send('GET', `/api/auth/invites/${token}`)).json()).toMatchObject({
      existingUser: true,
    });
    const wrong = await b.send('POST', '/api/auth/invites/accept', {
      token,
      name: 'Anything',
      password: 'not their password',
    });
    expect(wrong.statusCode).toBe(401);
    expect((await authEvents(user.id)).map((e) => e.action)).toContain('auth.login_failed');
    const right = await b.send('POST', '/api/auth/invites/accept', {
      token,
      name: 'Anything',
      password: PASSWORD,
    });
    expect(right.json()).toEqual({ next: 'mfa_code' });
    expect((await store.userWorkspaces(user.id)).map((w) => w.id).sort()).toEqual([A, B].sort());
    await server.close();
  });

  it('[SEC-1] state-changing request without CSRF token is rejected', async () => {
    const server = app();
    const user = await makeUser();
    const b = await new Browser(server).start();
    const noToken = await b.send(
      'POST',
      '/api/auth/sign-in',
      { email: user.email, password: PASSWORD },
      { csrf: null },
    );
    expect(noToken.statusCode).toBe(403);
    const wrongToken = await b.send(
      'POST',
      '/api/auth/sign-in',
      { email: user.email, password: PASSWORD },
      { csrf: 'not-the-cookie' },
    );
    expect(wrongToken.statusCode).toBe(403);
    const otherSite = await b.send(
      'POST',
      '/api/auth/sign-in',
      { email: user.email, password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(otherSite.statusCode).toBe(403);
    const noOrigin = await b.send(
      'POST',
      '/api/auth/sign-in',
      { email: user.email, password: PASSWORD },
      { origin: null },
    );
    expect(noOrigin.statusCode).toBe(403);

    // Signed in: the token must also be this session's own, not any double-submitted value.
    const { b: inside } = await signedIn(server, user);
    const forged = 'forged-token-value';
    inside.cookies.set('__Host-ob_csrf', forged);
    expect((await inside.send('POST', '/api/auth/sign-out-all')).statusCode).toBe(403);
    // Reads need no token.
    expect((await inside.send('GET', '/api/companies', undefined, { csrf: null })).statusCode).toBe(
      200,
    );
    // The cookies are Secure, SameSite=Strict, and the session one HttpOnly.
    const c = await new Browser(server).start();
    const res = await c.signIn(user.email, PASSWORD);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((x) => x.startsWith('__Host-ob_session='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Strict/);
    // __Host-: Secure, Path=/ and no Domain, so a sibling host cannot plant one (hardening 1).
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-/);
      expect(cookie).toMatch(/; Path=\/(;|$)/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect(cookies.find((x) => x.startsWith('__Host-ob_csrf='))).not.toMatch(/HttpOnly/);
    await server.close();
  });

  it('[USR-2] a user of two workspaces picks one after MFA', async () => {
    const server = app();
    const user = await makeUser({ workspaces: [A, B] });
    const { b, next } = await signedIn(server, user);
    expect(next).toBe('workspace_picker');
    expect((await b.send('GET', '/api/companies')).statusCode).toBe(401);
    const list = await b.send('GET', '/api/auth/workspaces');
    expect(list.json()).toEqual([
      { id: A, name: 'Workspace A', role: 'admin', companies: 1 },
      { id: B, name: 'Workspace B', role: 'admin', companies: 0 },
    ]);
    expect(
      (await b.send('POST', '/api/auth/workspace', { workspaceId: randomUUID() })).statusCode,
    ).toBe(403);
    expect((await b.send('POST', '/api/auth/workspace', { workspaceId: A })).statusCode).toBe(204);
    const companies = await b.send('GET', '/api/companies');
    expect(companies.json()).toEqual({ items: [expect.objectContaining({ id: companyA.id })] });
    // Switch: the picker stays open while in a workspace.
    expect((await b.send('POST', '/api/auth/workspace', { workspaceId: B })).statusCode).toBe(204);
    expect((await b.send('GET', '/api/companies')).json()).toEqual({ items: [] });
    await server.close();
  });

  it('[USR-4] a platform operator reaches the console only after MFA', async () => {
    const server = app();
    const operator = await makeUser({ workspaces: [A] });
    // Operators are made by platform tooling (M05); here the container's superuser sets the flag.
    const root = new pg.Client({ connectionString: cluster.container.getConnectionUri() });
    await root.connect();
    const made = await root.query('UPDATE app.users SET platform_admin = true WHERE id = $1', [
      operator.id,
    ]);
    await root.end();
    expect(made.rowCount).toBe(1);
    const member = await makeUser();
    const { b } = await signedIn(server, operator);
    expect((await b.send('POST', '/api/auth/platform')).statusCode).toBe(204);
    const created = await b.send('POST', '/api/platform/workspaces', {
      name: 'Made by the console',
    });
    expect(created.statusCode).toBe(201);
    const { b: notOperator } = await signedIn(server, member);
    expect((await notOperator.send('POST', '/api/auth/platform')).statusCode).toBe(403);
    const pre = await new Browser(server).start();
    await pre.signIn(operator.email, PASSWORD);
    expect((await pre.send('POST', '/api/auth/platform')).statusCode).toBe(401);
    await server.close();
  });

  it('[USR-5] a flood of sign-ins runs at most 4 hashes at once and keeps web under its memory limit', async () => {
    const gate = new HashGate(4, 16);
    const server = app(service(gate));
    const rssBefore = process.memoryUsage().rss;
    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, i) => {
        const b = await new Browser(server, `198.51.100.${String(i + 1)}`).start();
        return (await b.signIn(`flood${String(i)}@example.test`, 'not the password')).statusCode;
      }),
    );
    expect(gate.peak).toBeLessThanOrEqual(4);
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(results.every((s) => s === 401 || s === 429)).toBe(true);
    // 4 hashes of 19 MiB each; the web container allows 384 MB in all.
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(150 * 1024 * 1024);
    await server.close();
  });
  it('[USR-7] 100 unknown-email reset requests leave a real reset mail sendable (S5-20261117-01)', async () => {
    const auth = service();
    const user = await makeUser();
    const before = notified.reset.length;
    // 100 junk requests from 10 addresses, inside the per-address cap of 10 an hour.
    for (let i = 0; i < 100; i += 1) {
      later(1000);
      auth.forgotPassword(
        `junk-${randomUUID().slice(0, 8)}@example.test`,
        `198.51.100.${String(150 + (i % 10))}`,
      );
      if (i % 10 === 9) await auth.idle();
    }
    await auth.idle();
    expect(notified.reset.length).toBe(before);
    later(1000);
    auth.forgotPassword(user.email, '203.0.113.150');
    await auth.idle();
    expect(notified.reset.slice(before)).toEqual([{ userId: user.id, workspaceId: A }]);
  });

  it('[USR-5][USR-7] a hit platform-wide cap is logged at warn, for reset mail and lock notices', async () => {
    const lines: string[] = [];
    const captured = createLogger({
      service: 'test',
      version: '0',
      destination: { write: (line: string) => lines.push(line) },
    });
    const capped = new Proxy(store, {
      get: (target, prop, receiver) => {
        if (prop === 'allowReset') return () => Promise.resolve('global_capped');
        if (prop === 'recordFailure') {
          return () =>
            Promise.resolve({
              lockedUntil: new Date(clock.getTime() + 15 * MIN),
              newlyLocked: true,
              ipBlockedUntil: null,
              notice: 'platform_capped',
            });
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        // Private fields need the real store as `this`.
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const auth = new AuthService({ ...serviceOptions(), store: capped, logger: captured });
    const user = await makeUser();
    const beforeReset = notified.reset.length;
    const beforeLocked = notified.locked.length;
    auth.forgotPassword(user.email, '203.0.113.151');
    await auth.idle();
    const server = app(auth);
    const b = await new Browser(server, '203.0.113.152').start();
    expect((await b.signIn(user.email, 'wrong password')).statusCode).toBe(429);
    await server.close();
    expect(notified.reset.length).toBe(beforeReset);
    expect(notified.locked.length).toBe(beforeLocked);
    const warns = lines
      .map((l) => JSON.parse(l) as { level: string | number; event?: string })
      .filter((l) => l.level === 'warn' || l.level === 40)
      .map((l) => l.event);
    expect(warns).toEqual(
      expect.arrayContaining(['auth.reset_capped', 'auth.lock_notices_capped']),
    );
  });

  it('[USR-5] a failed sign-in makes the same database calls for a real and an unknown email (S5-20261117-02)', async () => {
    const calls: string[] = [];
    const counting = new Proxy(store, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const server = app(new AuthService({ ...serviceOptions(), store: counting }));
    const real = await makeUser();
    const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;
    const seen: string[][] = [];
    for (const [k, email] of [real.email, unknown].entries()) {
      const b = await new Browser(server, `192.0.2.${String(160 + k)}`).start();
      later(31_000);
      calls.length = 0;
      expect((await b.signIn(email, 'not the password')).statusCode).toBe(401);
      seen.push([...calls]);
    }
    expect(seen[0]).toEqual(['lockState', 'loginLookup', 'recordFailure']);
    expect(seen[1]).toEqual(seen[0]);
    // The real account's failure is still audited, per person (ADR-052).
    expect((await authEvents(real.id)).map((e) => e.action)).toEqual(['auth.login_failed']);
    await server.close();
  });

  it('[USR-5] repeated locks within a day send one notice (S5-20261117-03)', async () => {
    const server = app();
    const user = await makeUser();
    const before = notified.locked.length;
    for (let round = 0; round < 3; round += 1) {
      const b = await new Browser(server, `192.0.2.${String(170 + round)}`).start();
      for (let i = 1; i <= 10; i += 1) {
        later(31_000);
        await b.signIn(user.email, `wrong ${String(round)}-${String(i)}`);
      }
      later(16 * MIN); // the lock runs out; the next round locks again
    }
    expect(notified.locked.slice(before).map((n) => n.userId)).toEqual([user.id]);
    const locks = (await authEvents(user.id)).filter((e) => e.action === 'auth.locked');
    expect(locks).toHaveLength(3);
    await server.close();
  });

  it('[USR-3] a reset by email link is not held back by the 1-day minimum age (ADR-061)', async () => {
    const server = app();
    const user = await makeUser({ passwordAgeMs: HOUR });
    const anon = await new Browser(server).start();
    // A change in the app still waits a day.
    const { b } = await signedIn(server, user);
    const change = await b.send('POST', '/api/auth/password/change', {
      currentPassword: PASSWORD,
      password: 'meadow copper falcon 31',
    });
    expect(change.statusCode).toBe(422);
    expect(JSON.stringify(change.json())).toContain('min_age');
    // The emailed link does not.
    const link = await issuePasswordReset(store, user.id, clock);
    const reset = await anon.send('POST', '/api/auth/password/reset', {
      token: link.token,
      password: 'meadow copper falcon 31',
    });
    expect(reset.statusCode).toBe(204);
    await server.close();
  });

  it('[USR-7][USR-3] changing the password marks open reset links used', async () => {
    const server = app();
    const user = await makeUser();
    const anon = await new Browser(server).start();
    const link = await issuePasswordReset(store, user.id, clock);
    expect((await anon.send('GET', `/api/auth/password/reset/${link.token}`)).statusCode).toBe(200);
    const { b } = await signedIn(server, user);
    const change = await b.send('POST', '/api/auth/password/change', {
      currentPassword: PASSWORD,
      password: 'orchid basalt meadow 18',
    });
    expect(change.statusCode).toBe(204);
    expect((await anon.send('GET', `/api/auth/password/reset/${link.token}`)).statusCode).toBe(404);
    await server.close();
  });
});

/** RFC 4648 base32 (the enrolment's typed secret) back to bytes. */
function base32Decode(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
