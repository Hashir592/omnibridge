import { describe, expect, it } from 'vitest';
import { EmailLintError, lintEmail, renderLockNotice, renderPasswordReset } from './templates.ts';

const APP = 'https://app.omnibridge.co.uk';

describe('sign-in emails (USR-5, USR-7, MAIL-2)', () => {
  it('[USR-5] the lock notice tells the user, and an admin who it is about', () => {
    const own = renderLockNotice({ recipientName: 'Sam Admin', lockedUntil: '21/10/2026 10:15' });
    expect(own.subject).toBe('Sign in to your OmniBridge account is locked');
    expect(own.text).toContain('paused until 21/10/2026 10:15 (UK time)');
    const admin = renderLockNotice({
      recipientName: 'Pat Owner',
      lockedName: 'Sam <Admin>',
      lockedUntil: '21/10/2026 10:15',
    });
    expect(admin.subject).toBe('Sign in locked for Sam <Admin> on OmniBridge');
    expect(admin.html).toContain('Sam &lt;Admin&gt;');
    expect(admin.html).not.toContain('<Admin>');
    lintEmail(own);
    lintEmail(admin);
  });

  it('[USR-7] the reset email links to the app origin only and says MFA is still needed', () => {
    const mail = renderPasswordReset({
      recipientName: 'Sam Admin',
      resetUrl: `${APP}/reset-password?token=abc`,
      appOrigin: APP,
      expiresAt: '21/10/2026 10:30',
    });
    expect(mail.text).toContain(`${APP}/reset-password?token=abc`);
    expect(mail.text).toContain('authenticator app');
    for (const resetUrl of ['https://evil.example/reset', 'http://app.omnibridge.co.uk/reset']) {
      expect(() =>
        renderPasswordReset({ recipientName: 'x', resetUrl, appOrigin: APP, expiresAt: 'x' }),
      ).toThrow(EmailLintError);
    }
  });
});
