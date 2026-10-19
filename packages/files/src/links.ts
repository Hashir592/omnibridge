import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signed download links live 5 minutes (NFR-5). */
export const LINK_TTL_SECONDS = 300;

export interface FileLink {
  /** Expiry, Unix seconds. */
  exp: number;
  /** base64url HMAC-SHA256. */
  sig: string;
}

function mac(key: Buffer, fileId: string, sessionId: string, exp: number): Buffer {
  return createHmac('sha256', key)
    .update(`ob-file-link-v1|${fileId}|${sessionId}|${String(exp)}`)
    .digest();
}

/** Signs a link to one file for one session. Issue it only after the caller's permission check. */
export function signFileLink(
  input: { fileId: string; sessionId: string; now?: Date; ttlSeconds?: number },
  key: Buffer,
): FileLink {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const exp = now + (input.ttlSeconds ?? LINK_TTL_SECONDS);
  return { exp, sig: mac(key, input.fileId, input.sessionId, exp).toString('base64url') };
}

/**
 * Checks a link: the signature first (so a changed expiry is `invalid`), then the expiry.
 * The comparison is constant-time.
 */
export function verifyFileLink(
  input: { fileId: string; sessionId: string; exp: number; sig: string; now?: Date },
  key: Buffer,
): 'ok' | 'expired' | 'invalid' {
  if (!Number.isSafeInteger(input.exp)) return 'invalid';
  const expected = mac(key, input.fileId, input.sessionId, input.exp);
  const given = Buffer.from(input.sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  return now > input.exp ? 'expired' : 'ok';
}
