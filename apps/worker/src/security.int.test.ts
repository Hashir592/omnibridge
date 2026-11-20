import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notifier } from '@omnibridge/core';
import {
  createMainDb,
  MembershipRepository,
  migrateMain,
  NotificationRepository,
  PlatformSecuritySignals,
  SecuritySignals,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import { scanPlatformSecurity, securityScanHandler, type SecurityThresholds } from './security.ts';

// T-0503 (SEC-12): each rule fires on a seeded pattern and stays quiet one below its threshold;
// a canary read raises a critical platform alert; nothing in an alert is PII.

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const HOUR = 3_600_000;
const thresholds: SecurityThresholds = { loginFailures: 3, exportsPerHour: 3, piiViewsPerHour: 3 };

describe('security alerts [SEC-12]', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let vault: TestVault;
  let tenancy: Tenancy;
  let repo: NotificationRepository;
  let web: VaultClient;
  let worker: VaultClient;
  let clock = new Date();
  const A = randomUUID();
  const admin = randomUUID();
  const heavy = randomUUID();
  const light = randomUUID();
  const refs: string[] = [];

  const scan = async () => {
    const handler = securityScanHandler({
      vault: worker,
      signals: new SecuritySignals(db.db),
      notifications: repo,
      notifier: new Notifier({ store: repo, now: () => clock }),
      thresholds,
      logger,
      now: () => clock,
    });
    const job = {
      jobId: randomUUID(),
      envelope: {
        workspace_id: A,
        idempotency_key: `security.scan:${clock.toISOString()}`,
        attempt: 1,
        type: 'security.scan',
        payload: {},
      },
      payload: {},
      attempt: 1,
      progress: () => Promise.resolve(),
    };
    const prepared = await handler.prepare(job);
    await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      handler.commit({ ...job, ctx }, prepared),
    );
  };
  /** Open alerts of a type in A, as `kind:id`. */
  const open = (type: string) =>
    tenancy.runWorkspace({ workspaceId: A }, async (ctx) =>
      (await repo.list(ctx, { userId: admin, tabs: 'all' }, {}, { limit: 200 })).items
        .filter((n) => n.type === type && n.state !== 'resolved')
        .map((n) => `${n.record.kind}:${n.record.id}`),
    );
  const audit = (userId: string, action: string, at: Date, ip: string | null = null) =>
    root.query(
      `INSERT INTO app.audit_events (workspace_id, occurred_at, actor_kind, user_id, action,
                                     entity_type, ip)
       VALUES ($1, $2, 'user', $3, $4, 'user', $5::inet)`,
      [A, at, userId, action, ip],
    );
  const authEvent = (userId: string, action: string, at: Date) =>
    root.query(`INSERT INTO app.auth_events (user_id, action, occurred_at) VALUES ($1, $2, $3)`, [
      userId,
      action,
      at,
    ]);

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    root = new pg.Pool({ connectionString: main.container.getConnectionUri(), max: 2 });
    db = createMainDb({ ...main.connection('ob_worker'), max: 4 });
    tenancy = new Tenancy(db.db);
    repo = new NotificationRepository(db.db);
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
      journalDir: mkdtempSync(join(tmpdir(), 'ob-journal-')),
    });
    web = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.web });
    worker = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.worker });

    await tenancy.run({ workspaceId: A, companyIds: [], userId: admin }, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Security test' }),
    );
    for (const [user, role] of [
      [admin, 'admin'],
      [heavy, 'member'],
      [light, 'member'],
    ] as const) {
      await tenancy.run({ workspaceId: A, companyIds: [], userId: user }, async (c) => {
        await new UserRepository(db.db).create(c, {
          id: user,
          email: `${user}@example.test`,
          name: 'U',
        });
        await new MembershipRepository(db.db).add(c, { userId: user, role });
      });
    }
    for (let i = 0; i < 3; i += 1) {
      const { pii_ref } = await web.ingest({
        workspace_id: A,
        kind: 'buyer_contact',
        subject_type: 'order',
        subject_id: `order-${String(i)}`,
        fields: {
          name: `${PII_MARKER}Buyer ${String(i)}`,
          email: `${PII_MARKER}b${String(i)}@example.test`,
        },
      });
      refs.push(pii_ref);
    }
  }, 300_000);

  afterAll(async () => {
    await vault.close();
    await root.end();
    await db.destroy();
    await Promise.all([main.container.stop(), pii.container.stop()]);
  });

  it('[SEC-12] mass PII views: a user opening buyer records at the threshold in an hour raises a critical alert; one below stays quiet', async () => {
    for (const ref of refs) {
      await web.readFull({
        workspaceId: A,
        piiRef: ref,
        purpose: 'order_detail',
        actorUserId: heavy,
      });
    }
    for (const ref of refs.slice(0, 2)) {
      await web.readFull({
        workspaceId: A,
        piiRef: ref,
        purpose: 'order_detail',
        actorUserId: light,
      });
    }
    clock = new Date();
    await scan();
    expect(await open('security.mass_pii_view')).toEqual([`user:${heavy}`]);
    const alert = await tenancy.runWorkspace({ workspaceId: A }, async (ctx) =>
      (await repo.list(ctx, { userId: admin, tabs: 'all' }, {}, { limit: 200 })).items.find(
        (n) => n.type === 'security.mass_pii_view',
      ),
    );
    expect(alert).toMatchObject({ severity: 'critical', params: { count: 3, windowMinutes: 60 } });
    // An hour later the reads have aged out: the alert resolves itself (NTF-1).
    clock = new Date(Date.now() + 2 * HOUR);
    await scan();
    expect(await open('security.mass_pii_view')).toEqual([]);
  });

  it('[SEC-12] mass exports: exports at the threshold in an hour raise an alert; one below stays quiet', async () => {
    clock = new Date();
    for (let i = 0; i < 3; i += 1)
      await audit(heavy, 'export.created', new Date(clock.getTime() - 60_000));
    for (let i = 0; i < 2; i += 1)
      await audit(light, 'audit_log.exported', new Date(clock.getTime() - 60_000));
    await scan();
    expect(await open('security.mass_export')).toEqual([`user:${heavy}`]);
  });

  it('[SEC-12] unusual logins: a burst of failed sign-ins, and a sign-in from a new network, raise alerts; a first sign-in and a known network do not', async () => {
    clock = new Date();
    const recent = new Date(clock.getTime() - 60_000);
    for (let i = 0; i < 3; i += 1) await authEvent(heavy, 'auth.login_failed', recent);
    for (let i = 0; i < 2; i += 1) await authEvent(light, 'auth.login_failed', recent);
    // heavy signed in from one address 10 days ago, now from another network: unusual.
    await audit(heavy, 'auth.login', new Date(clock.getTime() - 10 * 24 * HOUR), '203.0.113.5');
    await audit(heavy, 'auth.login', recent, '198.51.100.7');
    // light: an IPv6 /64 seen before, a different host in it now: not unusual.
    await audit(light, 'auth.login', new Date(clock.getTime() - 5 * 24 * HOUR), '2001:db8:1:2::10');
    await audit(light, 'auth.login', recent, '2001:db8:1:2::99');
    // admin: a first sign-in ever: never unusual (S1, 19 Nov 2026).
    await audit(admin, 'auth.login', recent, '192.0.2.44');
    await scan();
    const alerts = await open('security.unusual_login');
    expect(alerts.filter((a) => a.startsWith('user:'))).toEqual([`user:${heavy}`]);
    expect(alerts.filter((a) => a.startsWith('login:'))).toHaveLength(1);
    const { rows } = await root.query<{ id: string }>(
      `SELECT id FROM app.audit_events WHERE user_id = $1 AND ip = '198.51.100.7'`,
      [heavy],
    );
    expect(alerts).toContain(`login:${rows[0]?.id ?? ''}`);
    // A second scan raises nothing new (NTF-5).
    await scan();
    expect(await open('security.unusual_login')).toHaveLength(2);
  });

  it('[SEC-12] a lockout raises an alert for that lock', async () => {
    clock = new Date();
    await authEvent(light, 'auth.locked', new Date(clock.getTime() - 60_000));
    await scan();
    const alerts = await open('security.account_locked');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/^lock:\d+$/);
  });

  it('[SEC-12] a canary read raises a critical platform alert, once, for platform admins only', async () => {
    const piiRoot = new pg.Pool({ connectionString: pii.container.getConnectionUri(), max: 1 });
    const { rows } = await piiRoot.query<{ pii_ref: string }>(
      'SELECT pii_ref FROM vault.records WHERE workspace_id = $1 AND canary',
      [A],
    );
    await piiRoot.end();
    const canary = rows[0]?.pii_ref;
    expect(canary).toBeDefined();
    await web.readFull({
      workspaceId: A,
      piiRef: canary ?? '',
      purpose: 'order_detail',
      actorUserId: light,
    });
    clock = new Date();
    await scan();
    await scan();
    const { rows: notices } = await root.query<{ type: string; severity: string; params: object }>(
      `SELECT type, severity, params FROM app.platform_notifications WHERE type = 'security.canary_read'`,
    );
    expect(notices).toEqual([
      {
        type: 'security.canary_read',
        severity: 'critical',
        params: { workspaceId: A, readFull: true, byUser: true, userId: light },
      },
    ]);
    // Not in the workspace bell.
    expect(await open('security.canary_read')).toEqual([]);
  });

  // ---- T-0507: platform admins' sign-ins (S5-20261121-01, ADR-076) ----

  const scanPlatform = () =>
    scanPlatformSecurity({
      signals: new PlatformSecuritySignals(db.db),
      notifications: repo,
      notifier: new Notifier({ store: repo, now: () => clock }),
      thresholds,
      logger,
      now: () => clock,
    });
  /** Open platform notices of a type, as `kind:id`, with their severity. */
  const platformOpen = async (type: string) =>
    (
      await root.query<{ rec: string; severity: string }>(
        `SELECT record_kind || ':' || record_id AS rec, severity FROM app.platform_notifications
          WHERE type = $1 AND resolved_at IS NULL ORDER BY rec`,
        [type],
      )
    ).rows;
  const consoleEntry = async (userId: string, at: Date, ip: string) =>
    (
      await root.query<{ id: string }>(
        `INSERT INTO app.platform_audit_events (occurred_at, user_id, action, ip)
         VALUES ($1, $2, 'platform.console_entered', $3::inet) RETURNING id`,
        [at, userId, ip],
      )
    ).rows[0]?.id ?? '';
  /** A platform admin who is also a member of workspace A (the wrong audience before T-0507). */
  const makeOperator = async () => {
    const id = randomUUID();
    await tenancy.run({ workspaceId: A, companyIds: [], userId: id }, async (c) => {
      await new UserRepository(db.db).create(c, { id, email: `${id}@example.test`, name: 'Op' });
      await new MembershipRepository(db.db).add(c, { userId: id, role: 'member' });
    });
    await root.query('UPDATE app.users SET platform_admin = true WHERE id = $1', [id]);
    return id;
  };

  it("[SEC-12][PLAT-1] a platform admin's console entry from a new network raises a critical platform notice; a known network and the first ever entry do not", async () => {
    clock = new Date();
    const recent = new Date(clock.getTime() - 60_000);
    const moved = await makeOperator();
    const steady = await makeOperator();
    const fresh = await makeOperator();
    await consoleEntry(moved, new Date(clock.getTime() - 10 * 24 * HOUR), '192.0.2.10');
    const unusual = await consoleEntry(moved, recent, '198.51.100.20');
    // The same IPv6 /64, another host: a known network.
    await consoleEntry(steady, new Date(clock.getTime() - 3 * 24 * HOUR), '2001:db8:9:9::1');
    await consoleEntry(steady, recent, '2001:db8:9:9::2');
    // A first entry ever: never unusual.
    await consoleEntry(fresh, recent, '203.0.113.30');
    await scanPlatform();
    await scanPlatform();
    expect(await platformOpen('security.platform_unusual_login')).toEqual([
      { rec: `console_entry:${unusual}`, severity: 'critical' },
    ]);
  });

  it('[SEC-12] a console entry 2 hours old, missed by earlier sweeps, still raises (24-hour window)', async () => {
    clock = new Date();
    const op = await makeOperator();
    await consoleEntry(op, new Date(clock.getTime() - 30 * 24 * HOUR), '192.0.2.50');
    const late = await consoleEntry(op, new Date(clock.getTime() - 2 * HOUR), '198.51.100.50');
    await scanPlatform();
    expect(await platformOpen('security.platform_unusual_login')).toContainEqual({
      rec: `console_entry:${late}`,
      severity: 'critical',
    });
  });

  it('[SEC-12] failed sign-ins at the threshold and a lockout of a platform admin raise warning platform notices; workspace admins get none', async () => {
    clock = new Date();
    const recent = new Date(clock.getTime() - 60_000);
    const op = await makeOperator();
    const calm = await makeOperator();
    for (let i = 0; i < 3; i += 1) await authEvent(op, 'auth.login_failed', recent);
    for (let i = 0; i < 2; i += 1) await authEvent(calm, 'auth.login_failed', recent);
    // A lockout two hours ago, missed by earlier sweeps: still raised (24-hour window). And one
    // a minute ago, inside the workspace rule's own window, which must still leave it alone.
    await authEvent(op, 'auth.locked', new Date(clock.getTime() - 2 * HOUR));
    await authEvent(op, 'auth.locked', recent);
    await scanPlatform();
    expect(await platformOpen('security.platform_login_failures')).toEqual([
      { rec: `user:${op}`, severity: 'warning' },
    ]);
    const locks = await platformOpen('security.platform_account_locked');
    const { rows: opLocks } = await root.query<{ id: string }>(
      `SELECT id FROM app.auth_events WHERE user_id = $1 AND action = 'auth.locked' ORDER BY id`,
      [op],
    );
    expect(locks.map((l) => l.rec)).toEqual(opLocks.map((r) => `lock:${r.id}`));
    expect(locks[0]).toMatchObject({
      rec: expect.stringMatching(/^lock:\d+$/) as string,
      severity: 'warning',
    });
    // The workspace scan of A (where both are members) tells A's admins nothing about them.
    await scan();
    expect((await open('security.unusual_login')).filter((a) => a.includes(op))).toEqual([]);
    const wsLocks = await open('security.account_locked');
    for (const l of locks) expect(wsLocks).not.toContain(l.rec);
    // Fifteen minutes on the failures have aged out: the notice resolves itself.
    clock = new Date(clock.getTime() + 20 * 60_000);
    await scanPlatform();
    expect(await platformOpen('security.platform_login_failures')).toEqual([]);
  });

  it('[SEC-12] alert rows hold IDs and counts only: no buyer PII reached db-main', async () => {
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
  });
});
