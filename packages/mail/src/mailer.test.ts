import { describe, expect, it } from 'vitest';
import { isPlainAddress, Mailer, RecipientRejected } from './mailer.ts';
import { renderLockNotice } from './templates.ts';

describe('Mailer recipients (SEC-4, F-M02h-10)', () => {
  it('[SEC-4] only a plain local@domain address is accepted', () => {
    for (const ok of [
      'sam@example.test',
      'first.last+tag@sub.example.co.uk',
      'a_b-c%d@x-y.io',
      "o'brien@example.co.uk",
    ]) {
      expect(isPlainAddress(ok)).toBe(true);
    }
    for (const bad of [
      'Sam <sam@example.test>',
      '"sam"@example.test',
      'sam@example.test, eve@example.test',
      'sam@example.test eve@example.test',
      'sam@example.test\neve@example.test',
      'sam(comment)@example.test',
      'sam@[127.0.0.1]',
      'sam@localhost',
      '@example.test',
      'sam@',
      `${'a'.repeat(65)}@example.test`,
    ]) {
      expect(isPlainAddress(bad)).toBe(false);
    }
  });

  it('[SEC-4] send refuses any other recipient before the address parser sees it', async () => {
    // Port 9 (discard) is never reached: the check runs before nodemailer does anything.
    const mailer = new Mailer({ host: '127.0.0.1', port: 9, secure: false, allowPlain: true });
    const email = renderLockNotice({ recipientName: 'Synthetic User', lockedUntil: '12:00' });
    await expect(mailer.send('sam@example.test, eve@example.test', email)).rejects.toBeInstanceOf(
      RecipientRejected,
    );
    mailer.close();
  });
});
