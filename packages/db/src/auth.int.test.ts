import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthStore,
  CompanyRepository,
  createMainDb,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from './index.ts';

const AUTH_TABLES = [
  'app.user_auth',
  'app.password_history',
  'app.recovery_codes',
  'app.sessions',
  'app.login_counters',
  'app.ip_counters',
  'app.password_resets',
  'app.platform_keys',
];
/** A syntactically valid argon2id string; the store never checks it, the web layer does. */
const fakeHash = (n: number) => `$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$hash${String(n)}`;
const sha = (v: string) => createHash('sha256').update(v).digest();
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const MIN = 60_000;

describe('auth store behind definer functions (USR-2 to USR-7)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let store: AuthStore;
  let app: pg.Pool;
  const A = randomUUID();
  const B = randomUUID();
  const user = randomUUID();
  const email = `${user.slice(0, 8)}@example.test`;
  const t0 = new Date('2026-10-21T09:00:00.000Z');

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    app = new pg.Pool({ ...cluster.connection('ob_app'), max: 2 });
    store = new AuthStore(main.db);
    const tenancy = new Tenancy(main.db);
    for (const [ws, name] of [
      [A, 'Workspace A'],
      [B, 'Workspace B'],
    ] as const) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: user }, async (ctx) => {
        await new WorkspaceRepository(main.db).create(ctx, { name });
        if (ws === A) {
          await new UserRepository(main.db).create(ctx, { id: user, email, name: 'Sam Admin' });
        }
        await new MembershipRepository(main.db).add(ctx, {
          userId: user,
          role: ws === A ? 'admin' : 'member',
        });
      });
    }
    await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      new CompanyRepository(main.db).create(ctx, {
        legalName: 'A Ltd',
        tradingName: 'A',
        registeredAddress: { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' },
      }),
    );
    await store.setPassword(user, fakeHash(0), t0);
  });

  afterAll(async () => {
    await app.end();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[USR-5] ob_app has no grant on any auth table: only the definer functions reach them', async () => {
    for (const table of AUTH_TABLES) {
      await expect(app.query(`SELECT * FROM ${table}`), table).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
    }
    const { rows } = await app.query<{ name: string; definer: boolean; path: string[] | null }>(
      `SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS path
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND (p.proname LIKE 'auth\\_%' OR p.proname LIKE 'session\\_%'
               OR p.proname LIKE 'platform\\_key\\_%')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const f of rows) {
      expect(f).toEqual({ name: f.name, definer: true, path: ['search_path=pg_catalog, pg_temp'] });
    }
  });

  it('[USR-5] 10 failures in 15 minutes lock for 15 minutes from the 10th, once', async () => {
    const key = randomBytes(32);
    const ip = '192.0.2.1';
    let locks = 0;
    for (let i = 1; i <= 10; i += 1) {
      const r = await store.recordFailure(key, ip, at(t0, i * 1000));
      if (r.newlyLocked) locks += 1;
      expect(r.lockedUntil === null).toBe(i < 10);
    }
    expect(locks).toBe(1);
    const tenth = at(t0, 10_000);
    expect((await store.lockState(key, ip, at(tenth, 14 * MIN))).lockedUntil).toEqual(
      at(tenth, 15 * MIN),
    );
    // More failures during the lock neither extend it nor notify again.
    const during = await store.recordFailure(key, ip, at(tenth, 5 * MIN));
    expect(during).toMatchObject({ newlyLocked: false, lockedUntil: at(tenth, 15 * MIN) });
    // After the lock the count starts again.
    expect((await store.lockState(key, ip, at(tenth, 15 * MIN))).lockedUntil).toBeNull();
    const after = await store.recordFailure(key, ip, at(tenth, 16 * MIN));
    expect(after).toMatchObject({ newlyLocked: false, lockedUntil: null });
  });

  it('[USR-5] failures more than 15 minutes apart never add up to a lock', async () => {
    const key = randomBytes(32);
    for (let i = 0; i < 12; i += 1) {
      const r = await store.recordFailure(key, `198.51.100.${String(i)}`, at(t0, i * 16 * MIN));
      expect(r.lockedUntil).toBeNull();
    }
  });

  it('[USR-5] a good password clears its email counter', async () => {
    const key = randomBytes(32);
    for (let i = 0; i < 9; i += 1) await store.recordFailure(key, '192.0.2.9', at(t0, i * 1000));
    await store.clearFailures(key);
    const r = await store.recordFailure(key, '192.0.2.9', at(t0, 10_000));
    expect(r.lockedUntil).toBeNull();
  });

  it('[USR-5] one address waits 1 s after its 4th failure, doubling to 30 s', async () => {
    const ip = '203.0.113.7';
    const waits: (number | null)[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const now = at(t0, i * 1000);
      const r = await store.recordFailure(randomBytes(32), ip, now);
      waits.push(
        r.ipBlockedUntil === null ? null : (r.ipBlockedUntil.getTime() - now.getTime()) / 1000,
      );
    }
    expect(waits).toEqual([null, null, null, 1, 2, 4, 8, 16, 30, 30]);
  });

  it('[USR-5] counter rows go 24 hours after their last failure', async () => {
    const key = randomBytes(32);
    await store.recordFailure(key, '192.0.2.50', t0);
    await store.recordFailure(randomBytes(32), '192.0.2.51', at(t0, 24 * 60 * MIN + 1000));
    const owner = new pg.Pool({ ...cluster.connection('ob_owner'), max: 1 });
    try {
      const { rows } = await owner.query<{ n: string }>(
        'SELECT count(*) AS n FROM app.login_counters WHERE key = $1',
        [key],
      );
      expect(rows[0]?.n).toBe('0');
    } finally {
      await owner.end();
    }
  });

  it('[USR-7][SEC-1] reset mail caps: 3 per email and 10 per address an hour, 100 a day in all', async () => {
    // A clock of its own, a day after the others, so earlier rows never count.
    const base = at(t0, 3 * 24 * 60 * MIN);
    const key = randomBytes(32);
    const perEmail = [];
    for (let i = 0; i < 4; i += 1) {
      perEmail.push(await store.allowReset(key, '198.51.100.1', at(base, i * MIN)));
    }
    expect(perEmail).toEqual([true, true, true, false]);
    expect(await store.allowReset(key, '198.51.100.1', at(base, 61 * MIN))).toBe(true);

    const ip = '198.51.100.2';
    const perIp = [];
    for (let i = 0; i < 11; i += 1) {
      perIp.push(await store.allowReset(randomBytes(32), ip, at(base, 2 * 60 * MIN + i * 1000)));
    }
    expect(perIp.filter(Boolean)).toHaveLength(10);
    expect(perIp[10]).toBe(false);

    // 100 allowed in 24 hours overall: 4 + 10 so far, then 86 from fresh addresses, then no more.
    const t = at(base, 4 * 60 * MIN);
    for (let i = 0; i < 86; i += 1) {
      expect(await store.allowReset(randomBytes(32), `198.51.101.${String(i)}`, t)).toBe(true);
    }
    expect(await store.allowReset(randomBytes(32), '198.51.102.1', t)).toBe(false);
    // A day later it opens again, and the old rows are gone.
    expect(await store.allowReset(randomBytes(32), '198.51.102.1', at(base, 25 * 60 * MIN))).toBe(
      true,
    );
  });

  it('[USR-6] a session enters only a workspace its user belongs to, and revokes everywhere', async () => {
    const id = randomUUID();
    await store.createSession({
      id,
      tokenHash: sha(`t-${id}`),
      csrfHash: sha(`c-${id}`),
      userId: user,
      stage: 'pre_mfa',
      now: t0,
      expiresAt: at(t0, 10 * MIN),
    });
    const move = (workspaceId: string, token: string) =>
      store.advanceSession({
        id,
        tokenHash: sha(token),
        csrfHash: sha(`c2-${token}`),
        stage: 'workspace',
        workspaceId,
        now: t0,
        signedIn: true,
        expiresAt: at(t0, 12 * 60 * MIN),
      });
    expect(await move(randomUUID(), 'x1')).toBe(false);
    expect(await move(A, 'x2')).toBe(true);
    // The old token is gone; the new one finds the session in its workspace.
    expect(await store.findSession(sha(`t-${id}`))).toBeUndefined();
    expect(await store.findSession(sha('x2'))).toMatchObject({
      id,
      stage: 'workspace',
      workspaceId: A,
    });
    expect(await store.revokeUserSessions(user, t0)).toBeGreaterThanOrEqual(1);
    expect(await store.findSession(sha('x2'))).toBeUndefined();
  });

  it('[USR-4] a TOTP step is accepted once, and a recovery code works once', async () => {
    const step = 58_000_000;
    // Not confirmed yet: no step is accepted.
    expect(await store.useTotpStep(user, step)).toBe(false);
    expect(await store.setPendingTotp(user, randomBytes(40), 1)).toBe(true);
    const codes = Array.from({ length: 10 }, () => randomBytes(32));
    expect(await store.confirmTotp(user, step, codes, t0)).toBe(true);
    // Confirmed: a new enrolment cannot silently replace it.
    expect(await store.setPendingTotp(user, randomBytes(40), 1)).toBe(false);
    expect(await store.useTotpStep(user, step)).toBe(false);
    expect(await store.useTotpStep(user, step + 1)).toBe(true);
    expect(await store.useTotpStep(user, step + 1)).toBe(false);
    const first = codes[0] ?? Buffer.alloc(32);
    expect(await store.useRecoveryCode(user, first, t0)).toBe(9);
    expect(await store.useRecoveryCode(user, first, t0)).toBeUndefined();
    expect(await store.useRecoveryCode(user, randomBytes(32), t0)).toBeUndefined();
  });

  it('[USR-3] the password history keeps the newest 10', async () => {
    for (let i = 1; i <= 12; i += 1) await store.setPassword(user, fakeHash(i), at(t0, i * MIN));
    const hashes = await store.passwordHashes(user);
    expect(hashes).toEqual(Array.from({ length: 10 }, (_, k) => fakeHash(12 - k)));
    expect((await store.loginLookup(email.toUpperCase()))?.passwordHash).toBe(fakeHash(12));
  });

  it('[USR-7] a reset link works once, within its time, and voids the others', async () => {
    const one = sha('reset-one');
    const two = sha('reset-two');
    await store.createReset(one, user, t0, at(t0, 30 * MIN));
    await store.createReset(two, user, t0, at(t0, 30 * MIN));
    expect(await store.findReset(one, at(t0, 30 * MIN))).toBeUndefined();
    expect(await store.findReset(one, at(t0, 29 * MIN))).toMatchObject({ userId: user });
    expect(await store.resetPassword(one, at(t0, 29 * MIN), fakeHash(99))).toBe(user);
    expect(await store.resetPassword(one, at(t0, 29 * MIN), fakeHash(98))).toBeUndefined();
    expect(await store.findReset(two, at(t0, 29 * MIN))).toBeUndefined();
    expect((await store.loginLookup(email))?.passwordHash).toBe(fakeHash(99));
  });

  it('[USR-2] the picker lists every workspace of the user with role and companies', async () => {
    const list = await store.userWorkspaces(user);
    expect(list).toEqual([
      { id: A, name: 'Workspace A', role: 'admin', companies: 1 },
      { id: B, name: 'Workspace B', role: 'member', companies: 0 },
    ]);
    expect(await store.userWorkspaces(randomUUID())).toEqual([]);
  });
});
