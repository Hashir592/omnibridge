import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createTOTPKeyURI, generateHOTP } from '@oslojs/otp';
import QRCode from 'qrcode';

/** TOTP as authenticator apps do it (USR-4): SHA-1, 30-second steps, 6 digits. */
export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
const ISSUER = 'OmniBridge';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, as authenticator apps expect. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? '';
  return out;
}

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** The 30-second step an instant falls in. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_S);
}

/** The code for a step (tests and the dev seed). */
export function totpCode(secret: Uint8Array, step: number): string {
  return generateHOTP(secret, BigInt(step), TOTP_DIGITS);
}

/**
 * The step a code belongs to, allowing one step of clock drift either way, or undefined. The
 * caller then accepts that step once only (replay guard in the database).
 */
export function matchTotp(secret: Uint8Array, code: string, now: Date): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const given = Buffer.from(code);
  const current = totpStep(now);
  let matched: number | undefined;
  // Check every candidate, so the time taken does not tell which one matched.
  for (const step of [current - 1, current, current + 1]) {
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), given)) matched ??= step;
  }
  return matched;
}

/** "s***@example.test": enough for the user to recognise, not enough to read off a screen. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export interface Enrolment {
  /** Base32 in groups of four, for typing by hand. */
  secret: string;
  label: string;
  /** The otpauth URI as a QR module matrix: one string per row, '1' = dark. */
  qr: string[];
}

/** What the enrolment screen shows (ADR-048); the QR comes from qrcode, server side (ADR-050). */
export function enrolmentView(secret: Uint8Array, email: string): Enrolment & { uri: string } {
  const uri = createTOTPKeyURI(ISSUER, email, secret, TOTP_PERIOD_S, TOTP_DIGITS);
  const code = QRCode.create(uri, { errorCorrectionLevel: 'M' });
  const size = code.modules.size;
  const qr = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => (code.modules.get(row, col) ? '1' : '0')).join(''),
  );
  return {
    uri,
    secret: (base32(secret).match(/.{1,4}/g) ?? []).join(' '),
    label: `${ISSUER} (${maskEmail(email)})`,
    qr,
  };
}

/** 10 recovery codes of 80 random bits each, as XXXX-XXXX-XXXX-XXXX (ADR-050). */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => (base32(randomBytes(10)).match(/.{4}/g) ?? []).join('-'));
}

/** A recovery code as typed: case, spaces and dashes do not matter. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

/** HMAC-SHA256 under auth_hmac_key, bound to the user (ADR-050). */
export function recoveryCodeHmac(key: Buffer, userId: string, code: string): Buffer {
  return createHmac('sha256', key)
    .update(`recovery-code\0${userId}\0${normaliseRecoveryCode(code)}`)
    .digest();
}
