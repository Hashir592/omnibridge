import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import {
  base32,
  enrolmentView,
  maskEmail,
  matchTotp,
  newRecoveryCodes,
  normaliseRecoveryCode,
  recoveryCodeHmac,
  totpCode,
  totpStep,
} from './totp.ts';

const secret = Buffer.from('12345678901234567890'); // the RFC 6238 test key

// ADR-050
describe('TOTP and recovery codes [USR-4]', () => {
  it('[USR-4] codes match the RFC 6238 SHA-1 test vectors', () => {
    // RFC 6238 Appendix B, 8-digit values; their last 6 digits are the 6-digit codes.
    expect(totpCode(secret, totpStep(new Date(59_000)))).toBe('287082');
    expect(totpCode(secret, totpStep(new Date(1_111_111_109_000)))).toBe('081804');
  });

  it('[USR-4] a code is accepted one step either side, and tells which step', () => {
    const now = new Date('2026-10-21T09:00:10.000Z');
    const step = totpStep(now);
    expect(matchTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(matchTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, step - 2), now)).toBeUndefined();
    expect(matchTotp(secret, 'abcdef', now)).toBeUndefined();
  });

  // ADR-050
  it('[USR-4] the QR matrix encodes exactly the otpauth URI', () => {
    const view = enrolmentView(secret, 'sam.admin@example.test');
    expect(view.uri).toMatch(/^otpauth:\/\/totp\/OmniBridge:sam\.admin%40example\.test\?/);
    expect(view.uri).toContain(`secret=${base32(secret)}`);
    // Round trip: the segments the library encoded spell out exactly the URI, and the matrix we
    // send is exactly its modules.
    const code = QRCode.create(view.uri, { errorCorrectionLevel: 'M' });
    const segments = code.segments as unknown as { data: Uint8Array | string }[];
    const decoded = segments
      .map((s) => (typeof s.data === 'string' ? s.data : Buffer.from(s.data).toString('utf8')))
      .join('');
    expect(decoded).toBe(view.uri);
    expect(view.qr).toHaveLength(code.modules.size);
    view.qr.forEach((row, r) => {
      expect(row).toHaveLength(code.modules.size);
      Array.from(row).forEach((bit, c) => {
        expect(bit === '1').toBe(code.modules.get(r, c) === 1);
      });
    });
    expect(view.secret).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);
    expect(view.label).toBe('OmniBridge (s***@example.test)');
  });

  it('[USR-4] recovery codes are 10 codes of 80 random bits, typed in any case', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/); // 16 x 5 bits
    const key = Buffer.alloc(32, 1);
    const first = codes[0] ?? '';
    expect(recoveryCodeHmac(key, 'u1', first.toLowerCase().replaceAll('-', ' '))).toEqual(
      recoveryCodeHmac(key, 'u1', first),
    );
    // Bound to the user: the same code means nothing for another user.
    expect(recoveryCodeHmac(key, 'u2', first)).not.toEqual(recoveryCodeHmac(key, 'u1', first));
    expect(normaliseRecoveryCode(' ab-cd ')).toBe('ABCD');
    expect(maskEmail('pat@example.test')).toBe('p***@example.test');
  });
});
