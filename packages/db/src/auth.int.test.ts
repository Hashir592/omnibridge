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
  setWorkspaceModule,
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
  'app.reset_requests',
  'app.lock_notices',
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
  let worker: pg.Pool;
  let ops: pg.Pool;
  const A = randomUUID();
  const B = randomUUID();
  const user = randomUUID();
  const email = `${user.slice(0, 8)}@example.test`;
  const t0 = new Date('2026-10-21T09:00:00.000Z');

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_worker',
      'ob_ops',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    app = new pg.Pool({ ...cluster.connection('ob_app'), max: 2 });
    worker = new pg.Pool({ ...cluster.connection('ob_worker'), max: 1 });
    ops = new pg.Pool({ ...cluster.connection('ob_ops'), max: 1 });
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
    await worker.end();
    await ops.end();
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

  // ADR-051
  it('[USR-6][SEC-3] ob_worker reaches only the reset-link definer, never sessions or hashes', async () => {
    const tok = () => randomBytes(32);
    const denied = /permission denied for function/;
    await expect(worker.query('SELECT * FROM app.auth_login_lookup($1)', [email])).rejects.toThrow(
      denied,
    );
    await expect(worker.query('SELECT * FROM app.session_find($1)', [tok()])).rejects.toThrow(
      denied,
    );
    await expect(
      worker.query('SELECT app.session_create($1, $2, $3, $4, $5, $6, $7)', [
        randomUUID(),
        tok(),
        tok(),
        user,
        'platform',
        t0,
        at(t0, 60 * MIN),
      ]),
    ).rejects.toThrow(denied);
    await expect(
      worker.query('SELECT app.auth_reset_create($1, $2, $3, $4)', [
        tok(),
        user,
        t0,
        at(t0, 30 * MIN),
      ]),
    ).resolves.toBeDefined();
    // ob_ops (rewrap-keys, seed) cannot open sessions or read hashes either.
    await expect(
      ops.query('SELECT app.session_create($1, $2, $3, $4, $5, $6, $7)', [
        randomUUID(),
        tok(),
        tok(),
        user,
        'pre_mfa',
        t0,
        at(t0, 10 * MIN),
      ]),
    ).rejects.toThrow(denied);
    await expect(ops.query('SELECT * FROM app.auth_login_lookup($1)', [email])).rejects.toThrow(
      denied,
    );
    await expect(ops.query('SELECT * FROM app.platform_key_get(NULL)')).resolves.toBeDefined();
  });

  // ADR-051
  it('[USR-6][SEC-3] a session starts at pre_mfa, and platform needs the platform_admin flag', async () => {
    const tok = () => randomBytes(32);
    await expect(
      app.query('SELECT app.session_create($1, $2, $3, $4, $5, $6, $7)', [
        randomUUID(),
        tok(),
        tok(),
        user,
        'platform',
        t0,
        at(t0, 12 * 60 * MIN),
      ]),
    ).rejects.toThrow(/starts at pre_mfa/);
    const id = randomUUID();
    await store.createSession({
      id,
      tokenHash: tok(),
      csrfHash: tok(),
      userId: user,
      stage: 'pre_mfa',
      now: t0,
      expiresAt: at(t0, 10 * MIN),
    });
    const advance = (stage: string, workspace: string | null, signedIn: boolean) =>
      app
        .query<{ ok: boolean }>(
          'SELECT app.session_advance($1, $2, $3, $4, $5, $6, $7, $8) AS ok',
          [id, tok(), tok(), stage, workspace, t0, signedIn, at(t0, 60 * MIN)],
        )
        .then((r) => r.rows[0]?.ok);
    // pre_mfa can never jump to platform, nor move without MFA being passed.
    expect(await advance('platform', null, true)).toBe(false);
    expect(await advance('workspace', A, false)).toBe(false);
    expect(await advance('signed_in', null, true)).toBe(true);
    // signed_in → platform is refused: this user is not a platform admin.
    expect(await advance('platform', null, false)).toBe(false);
    expect(await advance('workspace', A, false)).toBe(true);
    expect(await advance('signed_in', null, false)).toBe(false);
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

  it('[USR-7][SEC-1] reset mail caps: 3 per email and 10 per address an hour, 100 mails a day in all', async () => {
    // A clock of its own, a day after the others, so earlier rows never count.
    const base = at(t0, 3 * 24 * 60 * MIN);
    const key = randomBytes(32);
    const perEmail = [];
    for (let i = 0; i < 4; i += 1) {
      perEmail.push(await store.allowReset(key, '198.51.100.1', at(base, i * MIN), true));
    }
    expect(perEmail).toEqual(['ok', 'ok', 'ok', 'capped']);
    expect(await store.allowReset(key, '198.51.100.1', at(base, 61 * MIN), true)).toBe('ok');

    // The address cap counts every request, real email or not.
    const ip = '198.51.100.2';
    const perIp = [];
    for (let i = 0; i < 11; i += 1) {
      const t = at(base, 2 * 60 * MIN + i * 1000);
      perIp.push(await store.allowReset(randomBytes(32), ip, t, i % 2 === 0));
    }
    expect(perIp.slice(0, 10).every((v) => v === 'ok')).toBe(true);
    expect(perIp[10]).toBe('capped');

    // 100 mails in 24 hours overall: 4 + 5 so far, then 91 from fresh addresses, then no more.
    const t = at(base, 4 * 60 * MIN);
    for (let i = 0; i < 91; i += 1) {
      expect(await store.allowReset(randomBytes(32), `198.51.101.${String(i)}`, t, true)).toBe(
        'ok',
      );
    }
    expect(await store.allowReset(randomBytes(32), '198.51.102.1', t, true)).toBe('global_capped');
    // A day later it opens again, and the old rows are gone.
    const later = at(base, 25 * 60 * MIN);
    expect(await store.allowReset(randomBytes(32), '198.51.102.1', later, true)).toBe('ok');
  });

  it('[USR-7] junk reset requests do not use up the platform-wide cap (S5-20261117-01)', async () => {
    const base = at(t0, 10 * 24 * 60 * MIN);
    // 150 requests for emails with no account, from 15 addresses, within the per-address cap.
    for (let i = 0; i < 150; i += 1) {
      const r = await store.allowReset(
        randomBytes(32),
        `198.51.103.${String(i % 15)}`,
        at(base, i * 1000),
        false,
      );
      expect(r).toBe('ok');
    }
    // A real account's mail still goes out.
    expect(await store.allowReset(randomBytes(32), '203.0.113.9', at(base, 5 * MIN), true)).toBe(
      'ok',
    );
  });

  it('[USR-5][USR-7] two IPv6 addresses in one /64 share a counter; IPv4 stays per address', async () => {
    const t = at(t0, 20 * 24 * 60 * MIN);
    const waits: (Date | null)[] = [];
    for (let i = 1; i <= 4; i += 1) {
      // Four failures from four hosts of one /64: the 4th waits, as from one address.
      const r = await store.recordFailure(randomBytes(32), `2001:db8:5:7::${String(i)}`, at(t, i));
      waits.push(r.ipBlockedUntil);
    }
    expect(waits.slice(0, 3)).toEqual([null, null, null]);
    expect(waits[3]).not.toBeNull();
    const other = await store.lockState(randomBytes(32), '2001:db8:5:7:ffff::1', at(t, 10));
    expect(other.ipBlockedUntil).not.toBeNull();
    // A neighbouring /64 and a neighbouring IPv4 address are counted apart.
    expect(
      (await store.lockState(randomBytes(32), '2001:db8:5:8::1', at(t, 10))).ipBlockedUntil,
    ).toBeNull();
    for (let i = 1; i <= 4; i += 1) await store.recordFailure(randomBytes(32), '192.0.2.200', t);
    expect((await store.lockState(randomBytes(32), '192.0.2.201', t)).ipBlockedUntil).toBeNull();
    // The reset caps group the /64 too: 10 an hour from it, whatever the host.
    const resets = [];
    for (let i = 1; i <= 11; i += 1) {
      resets.push(
        await store.allowReset(randomBytes(32), `2001:db8:9:1::${String(i)}`, at(t, i), false),
      );
    }
    expect(resets.at(-1)).toBe('capped');
  });

  it('[USR-5] repeated locks within a day send one notice, and the platform caps notices (S5-20261117-03)', async () => {
    const t = at(t0, 30 * 24 * 60 * MIN);
    const lockOnce = async (who: string, start: Date) => {
      const key = randomBytes(32);
      let notice: string | null = null;
      for (let i = 1; i <= 10; i += 1) {
        const r = await store.recordFailure(key, '192.0.2.150', at(start, i), {
          userId: who,
          failure: 'password',
        });
        if (r.newlyLocked) notice = r.notice;
      }
      return notice;
    };
    expect(await lockOnce(user, t)).toBe('send');
    expect(await lockOnce(user, at(t, 20 * MIN))).toBe('recent');
    expect(await lockOnce(user, at(t, 23 * 60 * MIN))).toBe('recent');
    expect(await lockOnce(user, at(t, 24 * 60 * MIN + MIN))).toBe('send');

    // 100 notices in 24 hours platform-wide (99 others plus this user's), then audited only.
    const day = at(t, 3 * 24 * 60 * MIN);
    const owner = new pg.Pool({ ...cluster.connection('ob_owner'), max: 1 });
    try {
      await owner.query(
        `INSERT INTO app.lock_notices (user_id, sent_at)
           SELECT gen_random_uuid(), $1 FROM generate_series(1, 99)`,
        [day],
      );
      expect(await lockOnce(user, at(day, MIN))).toBe('send');
      expect(await lockOnce(user, at(day, 25 * 60 * MIN))).toBe('send');
      await owner.query(
        `INSERT INTO app.lock_notices (user_id, sent_at)
           SELECT gen_random_uuid(), $1 FROM generate_series(1, 99)`,
        [at(day, 25 * 60 * MIN)],
      );
      await owner.query('DELETE FROM app.lock_notices WHERE user_id = $1', [user]);
      await owner.query('INSERT INTO app.lock_notices (user_id, sent_at) VALUES ($1, $2)', [
        randomUUID(),
        at(day, 25 * 60 * MIN),
      ]);
      expect(await lockOnce(user, at(day, 26 * 60 * MIN))).toBe('platform_capped');
      // Every failure was still audited for the person, notice or not.
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.auth_events WHERE user_id = $1 AND action = 'auth.locked'`,
        [user],
      );
      expect(Number(rows[0]?.n)).toBe(7);
    } finally {
      await owner.query('DELETE FROM app.lock_notices');
      await owner.end();
    }
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
      {
        id: A,
        name: 'Workspace A',
        role: 'admin',
        companies: 1,
        modules: { website_connector: false },
      },
      {
        id: B,
        name: 'Workspace B',
        role: 'member',
        companies: 0,
        modules: { website_connector: false },
      },
    ]);
    expect(await store.userWorkspaces(randomUUID())).toEqual([]);
  });

  it('[PLAT-2][WEB-1] a workspace with no module setting reads off; only platform tooling switches one on', async () => {
    // A workspace no one has set reads website_connector false (above).
    const denied = /permission denied for function/;
    await expect(
      app.query('SELECT app.workspace_set_module($1, $2, $3)', [A, 'website_connector', true]),
    ).rejects.toThrow(denied);
    await expect(
      worker.query('SELECT app.workspace_set_module($1, $2, $3)', [A, 'website_connector', true]),
    ).rejects.toThrow(denied);
    const opsDb = createMainDb({ ...cluster.connection('ob_ops'), max: 1 });
    try {
      expect(await setWorkspaceModule(opsDb.db, A, 'website_connector', true)).toBe(true);
      expect(await setWorkspaceModule(opsDb.db, randomUUID(), 'website_connector', true)).toBe(
        false,
      );
      await expect(
        ops.query('SELECT app.workspace_set_module($1, $2, $3)', [A, 'advertising', true]),
      ).rejects.toThrow(/unknown module/);
      expect((await store.userWorkspaces(user)).map((w) => [w.id, w.modules])).toEqual([
        [A, { website_connector: true }],
        [B, { website_connector: false }],
      ]);
      expect(await setWorkspaceModule(opsDb.db, A, 'website_connector', false)).toBe(true);
      expect((await store.userWorkspaces(user))[0]?.modules).toEqual({ website_connector: false });
    } finally {
      await opsDb.destroy();
    }
  });
  it('[USR-3][USR-7] setting a password marks the open reset links used', async () => {
    const link = sha('reset-before-change');
    const t = at(t0, 40 * 24 * 60 * MIN);
    await store.createReset(link, user, t, at(t, 30 * MIN));
    expect(await store.findReset(link, at(t, MIN))).toMatchObject({ userId: user });
    await store.setPassword(user, fakeHash(77), at(t, 2 * MIN));
    expect(await store.findReset(link, at(t, 3 * MIN))).toBeUndefined();
  });

  it('[USR-2][USR-5] the rollout functions 0020 retired are gone (0023)', async () => {
    // ADR-063: revoked from every role in 0020, then dropped in 0023.
    const retired = [
      'app.auth_record_failure(bytea, inet, timestamptz)',
      'app.auth_reset_allow(bytea, inet, timestamptz)',
      'app.auth_user_workspaces(uuid)',
    ];
    for (const fn of retired) {
      const { rows } = await app.query<{ oid: string | null }>(
        'SELECT to_regprocedure($1) AS oid',
        [fn],
      );
      expect({ fn, oid: rows[0]?.oid }).toEqual({ fn, oid: null });
    }
    await expect(
      app.query('SELECT * FROM app.auth_user_workspaces($1)', [randomUUID()]),
    ).rejects.toThrow(/does not exist/);
  });
});
