/**
 * eBay Marketplace Account Deletion (EBAY-2): the endpoint's challenge and the check of each
 * notification's X-EBAY-SIGNATURE, as eBay's official event-notification SDK does them.
 *
 * - The challenge answer is the SHA-256 hex of challengeCode + verificationToken + endpoint.
 * - The header is base64 JSON {alg, kid, signature, digest}. The signature is ECDSA with SHA-1
 *   over JSON.stringify of the message, checked with the public key the Notification API returns
 *   for kid. Keys are cached for an hour (eBay's advice), so a notification is answered fast.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9_-]{32,80}$/;
const KEY_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 2_000;

/** eBay's rule for the verification token: 32 to 80 letters, digits, underscores or hyphens. */
export function isVerificationToken(token: string): boolean {
  return TOKEN.test(token);
}

export function challengeResponse(
  challengeCode: string,
  verificationToken: string,
  endpoint: string,
): string {
  return createHash('sha256')
    .update(challengeCode)
    .update(verificationToken)
    .update(endpoint)
    .digest('hex');
}

/** Returns eBay's public key for a key id, as the Notification API gives it. */
export type PublicKeySource = (kid: string) => Promise<string>;

function signatureHeader(header: string): { kid: string; signature: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { kid, signature } = parsed as Record<string, unknown>;
    return typeof kid === 'string' && typeof signature === 'string'
      ? { kid, signature }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The key as eBay sends it (PEM markers with no line breaks) to a public key object. */
function publicKey(key: string) {
  const body = key
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  return createPublicKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'spki' });
}

/**
 * True only for a notification signed by eBay; any missing, malformed or wrong part is false.
 * A failure to get the key (eBay or our credentials) is not a bad signature: it rejects, so the
 * caller answers 5xx and eBay retries.
 */
export async function verifyNotification(
  message: unknown,
  header: string | undefined,
  keys: PublicKeySource,
): Promise<boolean> {
  if (header === undefined) return false;
  const parsed = signatureHeader(header);
  if (parsed === undefined) return false;
  const pem = await keys(parsed.kid);
  try {
    const key = publicKey(pem);
    return verify(
      'sha1',
      Buffer.from(JSON.stringify(message)),
      key,
      Buffer.from(parsed.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Public keys by kid, each kept for an hour. */
export class PublicKeyCache {
  readonly #keys = new Map<string, { key: string; until: number }>();
  /** One fetch per kid at a time: notices arriving together share it. */
  readonly #pending = new Map<string, Promise<string>>();
  readonly #fetch: PublicKeySource;
  readonly #now: () => number;

  constructor(fetchKey: PublicKeySource, now: () => number = Date.now) {
    this.#fetch = fetchKey;
    this.#now = now;
  }

  get = async (kid: string): Promise<string> => {
    const hit = this.#keys.get(kid);
    if (hit !== undefined && hit.until > this.#now()) return hit.key;
    const pending = this.#pending.get(kid);
    if (pending !== undefined) return pending;
    const fetching = this.#fetch(kid)
      .then((key) => {
        // A few keys at most; an old one is replaced, never kept beside its successor.
        if (this.#keys.size > 32) this.#keys.clear();
        this.#keys.set(kid, { key, until: this.#now() + KEY_TTL_MS });
        return key;
      })
      .finally(() => {
        this.#pending.delete(kid);
      });
    this.#pending.set(kid, fetching);
    return fetching;
  };
}

/** The eBay calls a key read makes, as the governor counts them. */
export type EbayKeyReadApi = 'identity.app_token' | 'notification.public_key';

/** The eBay budget for this call is spent today: it was not sent (RL-2, ADR-058). */
export class EbayBudgetExhausted extends Error {
  readonly api: EbayKeyReadApi;

  constructor(api: EbayKeyReadApi) {
    super(`eBay daily budget spent: ${api}`);
    this.name = 'EbayBudgetExhausted';
    this.api = api;
  }
}

export interface EbayApiOptions {
  /** https://api.ebay.com in production; the provider mocks in dev and CI (ADR-011). */
  apiBase: string;
  clientId: string;
  clientSecret: string;
  /**
   * The eBay governor's count-before-send check (ADR-058): called before each call, which is sent
   * only if it returns true.
   */
  budget: (api: EbayKeyReadApi) => boolean;
  fetch?: typeof fetch;
}

/**
 * Reads a public key from eBay's Notification API with an application token (client
 * credentials), which is cached until shortly before it expires.
 */
export function ebayPublicKeyFetcher(options: EbayApiOptions): PublicKeySource {
  const call = options.fetch ?? fetch;
  let token: { value: string; until: number } | undefined;
  const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const counted = (api: EbayKeyReadApi) => {
    if (!options.budget(api)) throw new EbayBudgetExhausted(api);
  };

  async function appToken(): Promise<string> {
    if (token !== undefined && token.until > Date.now()) return token.value;
    counted('identity.app_token');
    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
    const res = await call(`${options.apiBase}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
      signal: signal(),
    });
    if (!res.ok) throw new Error(`eBay application token: HTTP ${String(res.status)}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('eBay application token: no token');
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 0;
    token = { value: body.access_token, until: Date.now() + Math.max(0, ttl - 60) * 1000 };
    return token.value;
  }

  return async (kid) => {
    const bearer = await appToken();
    counted('notification.public_key');
    const res = await call(
      `${options.apiBase}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
      { headers: { authorization: `Bearer ${bearer}` }, signal: signal() },
    );
    if (!res.ok) throw new Error(`eBay public key: HTTP ${String(res.status)}`);
    const body = (await res.json()) as { key?: unknown };
    if (typeof body.key !== 'string') throw new Error('eBay public key: no key');
    return body.key;
  };
}
