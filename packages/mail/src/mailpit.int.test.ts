import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mailer } from './mailer.ts';
import { EmailLintError, renderInvite } from './templates.ts';

const APP = 'https://app.omnibridge.co.uk';
/** Same image and digest as the mailpit service in infra/compose/compose.dev.yaml. */
const MAILPIT_IMAGE =
  'axllent/mailpit:v1.31.6@sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387';

interface MailpitList {
  messages: { ID: string; Subject: string; To: { Address: string }[] }[];
}

describe('SMTP adapter against Mailpit (MAIL-2)', () => {
  let mailpit: StartedTestContainer;
  let mailer: Mailer;
  const api = (path: string) =>
    `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1${path}`;

  beforeAll(async () => {
    mailpit = await new GenericContainer(MAILPIT_IMAGE)
      .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1' })
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025))
      .start();
    mailer = new Mailer({
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      secure: false,
      allowPlain: true,
    });
  });

  afterAll(async () => {
    mailer.close();
    await mailpit.stop();
  });

  it('[MAIL-2] invite email delivered to Mailpit with no PII marker', async () => {
    const email = renderInvite({
      inviterName: 'Synthetic Admin',
      workspaceName: 'Synthetic Workspace',
      acceptUrl: 'https://app.omnibridge.co.uk/invite/abc123',
      appOrigin: APP,
    });
    await mailer.send('new.user@example.test', email);

    const list = (await (await fetch(api('/messages'))).json()) as MailpitList;
    const message = list.messages.find((m) => m.Subject === email.subject);
    expect(message?.To.map((t) => t.Address)).toEqual(['new.user@example.test']);
    const raw = await (await fetch(api(`/message/${message?.ID ?? ''}/raw`))).text();
    expect(raw).toContain('From: OmniBridge <notifications@omnibridge.co.uk>');
    expect(raw).toContain('https://app.omnibridge.co.uk/invite/abc123');
    expect(raw).not.toContain('PIIMARK-');
  });

  it('[MAIL-2] an email carrying a PII marker is refused and never reaches the server', async () => {
    const before = ((await (await fetch(api('/messages'))).json()) as MailpitList).messages.length;
    const email = renderInvite({
      inviterName: 'PIIMARK-synthetic-buyer',
      workspaceName: 'W',
      acceptUrl: 'https://app.omnibridge.co.uk/invite/x',
      appOrigin: APP,
    });
    await expect(mailer.send('new.user@example.test', email)).rejects.toThrow(EmailLintError);
    const after = ((await (await fetch(api('/messages'))).json()) as MailpitList).messages.length;
    expect(after).toBe(before);
  });
});
