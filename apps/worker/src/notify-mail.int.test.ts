import { randomUUID } from 'node:crypto';
import { Notifier, type TenantContext } from '@omnibridge/core';
import {
  CompanyRepository,
  createMainDb,
  createQueues,
  JobRecordRepository,
  MemberAccessRepository,
  MembershipRepository,
  migrateMain,
  NotificationRepository,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { Mailer } from '@omnibridge/mail';
import { emailOnRaise, JobQueue, notifyEmailJob } from '@omnibridge/queue';
import {
  PII_MARKER,
  scanTextForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerBoss } from './heartbeat.ts';
import { notifyEmailHandler, sweepPlatformEmails } from './notify-mail.ts';

// T-0502: a raise queues one email job per recipient in the raiser's transaction; the worker
// sends each through SMTP (Mailpit here) with nothing from the record, once per version.

const APP = 'https://app.omnibridge.test';
/** Same image and digest as the mailpit service in infra/compose/compose.dev.yaml. */
const MAILPIT_IMAGE =
  'axllent/mailpit:v1.31.6@sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387';
const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };

interface Message {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

describe('notification emails [NTF-3][NTF-4][MAIL-3]', () => {
  let main: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  let boss: PgBoss;
  let mailpit: StartedTestContainer;
  let mailer: Mailer;
  let notifier: Notifier;
  let repo: NotificationRepository;
  const A = randomUUID();
  const admin1 = randomUUID();
  const admin2 = randomUUID();
  const opted = randomUUID();
  const notOpted = randomUUID();
  const operator = randomUUID();
  let c1 = '';

  const email = (u: string) => `${u.slice(0, 8)}@example.test`;
  const api = (path: string) =>
    `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1${path}`;
  const messages = async (): Promise<Message[]> =>
    ((await (await fetch(api('/messages?limit=500'))).json()) as { messages: Message[] }).messages;
  const clearMail = () => fetch(api('/messages'), { method: 'DELETE' });
  const recipientsOf = (list: Message[], subjectPart: string) =>
    list
      .filter((m) => m.Subject.includes(subjectPart))
      .flatMap((m) => m.To.map((t) => t.Address))
      .sort();
  /** Waits until no notify.email job is left to run, then reads Mailpit. */
  const settled = async (): Promise<Message[]> => {
    for (let i = 0; i < 120; i += 1) {
      const { rows } = await root.query<{ n: string }>(
        `SELECT count(*) AS n FROM pgboss.job
          WHERE name = 'notify.email' AND state IN ('created', 'retry', 'active')`,
      );
      if (rows[0]?.n === '0') return messages();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('email jobs did not finish');
  };
  const inJob = <T>(fn: (ctx: TenantContext) => Promise<T>) =>
    tenancy.runWorkspace({ workspaceId: A }, fn);

  beforeAll(async () => {
    [main, mailpit] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_worker']),
      new GenericContainer(MAILPIT_IMAGE)
        .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1' })
        .withExposedPorts(1025, 8025)
        .withWaitStrategy(Wait.forHttp('/readyz', 8025))
        .start(),
    ]);
    await migrateMain(main.connection('ob_owner'));
    await createQueues(main.connection('ob_owner'), [
      { ...notifyEmailJob, retry: { ...notifyEmailJob.retry, limit: 0 } },
    ]);
    root = new pg.Pool({ connectionString: main.container.getConnectionUri(), max: 2 });
    db = createMainDb({ ...main.connection('ob_worker'), max: 6 });
    tenancy = new Tenancy(db.db);
    repo = new NotificationRepository(db.db);
    mailer = new Mailer({
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      secure: false,
      allowPlain: true,
    });

    await tenancy.run({ workspaceId: A, companyIds: [], userId: admin1 }, async (c) => {
      await new WorkspaceRepository(db.db).create(c, { name: 'Mail test' });
    });
    for (const [user, role, name] of [
      [admin1, 'admin', 'Admin One'],
      [admin2, 'admin', 'Admin Two'],
      [opted, 'member', 'Opted In'],
      [notOpted, 'member', 'Not Opted'],
      [operator, 'member', 'Operator'],
    ] as const) {
      await tenancy.run({ workspaceId: A, companyIds: [], userId: user }, async (c) => {
        await new UserRepository(db.db).create(c, { id: user, email: email(user), name });
        await new MembershipRepository(db.db).add(c, { userId: user, role });
      });
    }
    await root.query('UPDATE app.users SET platform_admin = true WHERE id = $1', [operator]);
    c1 = await inJob((c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'One Ltd',
        tradingName: 'Company One',
        registeredAddress: address,
      }),
    );
    for (const child of [opted, notOpted]) {
      await tenancy.runWorkspace({ workspaceId: A, userId: admin1 }, (c) =>
        new MemberAccessRepository(db.db).set(c, child, {
          role: 'member',
          tabs: ['finance', 'stock-catalogue'],
          companyIds: [c1],
        }),
      );
    }
    // admin1 has critical stock alerts switched off in the database (as if set while a child);
    // the opted-in child wants bill emails, which are off by default.
    await inJob(async (c) => {
      await repo.setEmailPreferences(
        c,
        admin1,
        [{ type: 'inventory.oversold', email: false }],
        new Date(),
      );
      await repo.setEmailPreferences(
        c,
        opted,
        [{ type: 'finance.bill_due', email: true }],
        new Date(),
      );
      await repo.setEmailPreferences(
        c,
        opted,
        [{ type: 'inventory.oversold', email: false }],
        new Date(),
      );
    });

    boss = createWorkerBoss(main.connection('ob_worker'), { monitorIntervalSeconds: 1 });
    boss.on('error', () => undefined);
    await boss.start();
    const queue = new JobQueue({ boss, records: new JobRecordRepository(db.db), tenancy, logger });
    notifier = new Notifier({ store: repo, onRaised: emailOnRaise({ queue, recipients: repo }) });
    await queue.work(
      notifyEmailJob,
      notifyEmailHandler({ tenancy, notifications: repo, mailer, appOrigin: APP, logger }),
      { pollingIntervalSeconds: 0.5 },
    );
  }, 300_000);

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    mailer.close();
    await root.end();
    await db.destroy();
    await Promise.all([main.container.stop(), mailpit.stop()]);
  });

  it('[NTF-4] a critical raise emails every admin, even one whose preference is off; a child gets it by default unless they turned it off', async () => {
    await clearMail();
    await inJob((c) =>
      notifier.raise(c, {
        type: 'inventory.oversold',
        record: { kind: 'sku', id: randomUUID() },
        companyId: c1,
      }),
    );
    const sent = await settled();
    expect(recipientsOf(sent, 'Oversold')).toEqual(
      [email(admin1), email(admin2), email(notOpted)].sort(),
    );
    expect(sent.find((m) => m.Subject.includes('Oversold'))?.Subject).toBe(
      '[Critical] Oversold (Company One)',
    );
  });

  it('[NTF-4] a warning emails only the users who opted in to its type', async () => {
    await clearMail();
    await inJob((c) =>
      notifier.raise(c, {
        type: 'finance.bill_due',
        record: { kind: 'bill', id: randomUUID() },
        severity: 'warning',
        companyId: c1,
      }),
    );
    expect(recipientsOf(await settled(), 'Unpaid bill')).toEqual([email(opted)]);
  });

  it('[NTF-5][NTF-3] a dedupe update sends no second email; a severity rise does', async () => {
    await clearMail();
    const bill = randomUUID();
    const raise = (severity: 'info' | 'warning') =>
      inJob((c) =>
        notifier.raise(c, {
          type: 'finance.bill_due',
          record: { kind: 'bill', id: bill },
          severity,
          companyId: c1,
          params: { daysLeft: severity === 'info' ? 3 : 0 },
        }),
      );
    await raise('info');
    expect(recipientsOf(await settled(), 'Unpaid bill')).toEqual([email(opted)]);
    await raise('info');
    await raise('info');
    expect(recipientsOf(await settled(), 'Unpaid bill')).toEqual([email(opted)]);
    await raise('warning');
    expect(recipientsOf(await settled(), 'Unpaid bill')).toEqual([email(opted), email(opted)]);
  });

  it('[NTF-2][NTF-3] a critical platform notice is emailed to each platform admin once; others are not emailed', async () => {
    await clearMail();
    await notifier.raisePlatform(null, {
      type: 'platform.amazon_secret_rotation',
      record: { kind: 'day', id: '2026-11-19' },
    });
    await notifier.raisePlatform(null, {
      type: 'platform.report_failure',
      record: { kind: 'day', id: '2026-11-19' },
    });
    const deps = { notifications: repo, mailer, appOrigin: APP, logger };
    expect(await sweepPlatformEmails(deps)).toBe(1);
    expect(await sweepPlatformEmails(deps)).toBe(0);
    const sent = await messages();
    expect(recipientsOf(sent, 'rotation')).toEqual([email(operator)]);
    expect(recipientsOf(sent, 'parser failure')).toEqual([]);
  });

  it('[MAIL-3][NTF-3] emails say what happened and link to the app: no record contents, no buyer PII', async () => {
    await clearMail();
    const order = randomUUID();
    await inJob((c) =>
      notifier.raise(c, {
        type: 'tracking.unconfirmed',
        record: { kind: 'order', id: order },
        companyId: c1,
        params: { orderId: order, hoursLate: 5 },
      }),
    );
    const sent = await settled();
    expect(sent.length).toBeGreaterThan(0);
    // Decoded parts (the raw source wraps long lines as quoted-printable).
    const parts = await Promise.all(
      sent.map(
        async (m) =>
          (await (await fetch(api(`/message/${m.ID}`))).json()) as {
            From: { Address: string };
            Text: string;
            HTML: string;
          },
      ),
    );
    for (const part of parts) {
      expect(part.From.Address).toBe('notifications@omnibridge.co.uk');
      expect(part.Text).toContain(`${APP}/notifications/`);
      expect(part.Text).toContain('Tracking not confirmed within 4 hours');
      expect(`${part.Text}${part.HTML}`).not.toContain(order);
    }
    // The planted marker never got into a notification, so it cannot be in any email.
    await expect(
      inJob((c) =>
        notifier.raise(c, {
          type: 'tracking.unconfirmed',
          record: { kind: 'order', id: order },
          params: { buyer: `${PII_MARKER}Buyer` },
        }),
      ),
    ).rejects.toThrow();
    const all = await messages();
    const everything = await Promise.all(
      all.map(async (m) => (await fetch(api(`/message/${m.ID}/raw`))).text()),
    );
    expect(scanTextForMarkers(everything.flatMap((r) => r.split('\n')))).toEqual([]);
  });
});
