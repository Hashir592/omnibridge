/**
 * The session cookie (USR-6, SEC-1): the 256-bit token, never readable by page script. The
 * __Host- prefix makes the browser refuse it unless Secure, Path=/ and host-only, so a sibling
 * host such as the public site can never plant one on the app (S5-20261117 hardening 1).
 */
export const SESSION_COOKIE = '__Host-ob_session';
/** The CSRF cookie the SPA echoes in `x-csrf-token` (double submit, SEC-1). */
export const CSRF_COOKIE = '__Host-ob_csrf';
export const CSRF_HEADER = 'x-csrf-token';

type Headers = Readonly<Record<string, string | string[] | undefined>>;

/** One cookie from the request's Cookie header. */
export function readCookie(headers: Headers, name: string): string | undefined {
  const raw = headers.cookie;
  const text = Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) {
      const value = part.slice(at + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

export function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A Set-Cookie value: SameSite=Strict, Secure and Path=/ always; HttpOnly for the session. No
 * Max-Age, so the browser forgets it when closed; the server enforces the real lifetimes.
 */
export function setCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean },
): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
    ...(options.httpOnly ? ['HttpOnly'] : []),
  ].join('; ');
}

export function clearCookie(name: string, options: { httpOnly: boolean; secure: boolean }) {
  return `${setCookie(name, '', options)}; Max-Age=0`;
}
