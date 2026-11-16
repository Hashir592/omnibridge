import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EmailLintError, lintEmail, renderInvite } from './templates.ts';

const APP = 'https://app.omnibridge.co.uk';
const invite = () =>
  renderInvite({
    inviterName: 'Synthetic Admin',
    workspaceName: 'Synthetic Workspace',
    acceptUrl: 'https://app.omnibridge.co.uk/invite/abc123',
    appOrigin: APP,
  });

describe('system email templates (MAIL-2)', () => {
  it('[MAIL-2] the invite renders text and HTML in the branded base template', () => {
    const email = invite();
    expect(email.subject).toBe('Synthetic Admin invited you to Synthetic Workspace on OmniBridge');
    expect(email.text).toContain('https://app.omnibridge.co.uk/invite/abc123');
    expect(email.html).toContain('href="https://app.omnibridge.co.uk/invite/abc123"');
    expect(email.html).toContain('OmniBridge');
    // The petrol brand-700 header (ADR-041), not the old navy.
    expect(email.html).toContain('background:#0F6B66;color:#ffffff;padding:16px 24px');
    expect(email.html).not.toContain('#1B2A6B');
    expect(() => {
      lintEmail(email);
    }).not.toThrow();
  });

  it('[MAIL-2] values are HTML-escaped', () => {
    const email = renderInvite({
      inviterName: '<script>alert(1)</script>',
      workspaceName: 'A & B',
      acceptUrl: 'https://app.omnibridge.co.uk/invite/x"onmouseover="y',
      appOrigin: APP,
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('A &amp; B');
    expect(email.html).not.toContain('"onmouseover="');
  });

  it('[MAIL-2] the invite link must be https on the app origin', () => {
    const values = { inviterName: 'A', workspaceName: 'W', appOrigin: APP };
    for (const acceptUrl of [
      'javascript:alert(1)',
      'https://evil.example/invite/x',
      'http://app.omnibridge.co.uk/invite/x',
      'not a url',
    ]) {
      expect(() => renderInvite({ ...values, acceptUrl }), acceptUrl).toThrow(EmailLintError);
    }
    const dev = renderInvite({
      ...values,
      appOrigin: 'http://localhost:5173',
      acceptUrl: 'http://localhost:5173/invite/x',
    });
    expect(dev.text).toContain('http://localhost:5173/invite/x');
  });

  it('[MAIL-2] template lint rejects PII marker values and secrets', () => {
    const kek = `1:${randomBytes(32).toString('base64')}`;
    const bad = [
      { inviterName: 'PIIMARK-buyer-name', workspaceName: 'W' },
      { inviterName: 'A', workspaceName: `key ${kek}` },
      { inviterName: 'A', workspaceName: `AGE-SECRET-KEY-1${'Q'.repeat(58)}` },
      { inviterName: 'A', workspaceName: '-----BEGIN PRIVATE KEY-----' },
    ];
    for (const values of bad) {
      const email = renderInvite({
        ...values,
        acceptUrl: 'https://app.omnibridge.co.uk/invite/x',
        appOrigin: APP,
      });
      expect(() => {
        lintEmail(email);
      }, values.workspaceName).toThrow(EmailLintError);
    }
  });
});
