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
/** eBay key ids are short ids; anything else is refused before any fetch (A-003). */
const KID = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_TTL_MS = 60 * 60_000;
/** An unknown kid is remembered this long, so repeats of it fetch nothing (A-003, ADR-069). */
const MISS_TTL_MS = 60 * 60_000;
/** Uncached key fetches a minute, in total (A-003): eBay rotates keys rarely. */
const FETCHES_PER_MINUTE = 5;
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

/**
 * Returns eBay's public key for a key id, as the Notification API gives it. `beforeFetch`, when
 * given, is called just before a key is actually fetched (not for a cached one), and may throw to
 * stop it: the webhook counts the sender's address there (A-003).
 */
export type PublicKeySource = (kid: string, beforeFetch?: () => void) => Promise<string>;

/** eBay has no key for this kid (HTTP 404): the notice was not signed by eBay. */
export class EbayKeyNotFound extends Error {
  constructor() {
    super('eBay public key: no such key id');
    this.name = 'EbayKeyNotFound';
  }
}

/** Too many uncached key fetches this minute (A-003): nothing was sent; eBay retries later. */
export class EbayKeyFetchThrottled extends Error {
  constructor() {
    super('eBay public key: fetch limit reached this minute');
    this.name = 'EbayKeyFetchThrottled';
  }
}

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
 * True only for a notification signed by eBay; any missing, malformed or wrong part is false,
 * and so is a kid eBay does not know. A failure to get the key (eBay or our credentials) is not a
 * bad signature: it rejects, so the caller answers 5xx and eBay retries.
 */
export async function verifyNotification(
  message: unknown,
  header: string | undefined,
  keys: PublicKeySource,
): Promise<boolean> {
  if (header === undefined) return false;
  const parsed = signatureHeader(header);
  if (parsed === undefined || !KID.test(parsed.kid)) return false;
  let pem: string;
  try {
    pem = await keys(parsed.kid);
  } catch (err) {
    if (err instanceof EbayKeyNotFound) return false;
    throw err;
  }
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

/**
 * Public keys by kid, each kept for an hour. A-003 (ADR-069): anonymous traffic must not spend
 * the eBay budget, so a kid eBay does not know is remembered for an hour too (no second fetch),
 * and at most a few uncached fetches go out a minute in total. A verified notice's kid is cached,
 * so eBay's own notices never wait on either limit once the key is known.
 */
export class PublicKeyCache {
  readonly #keys = new Map<string, { key: string; until: number }>();
  readonly #misses = new Map<string, number>();
  /** One fetch per kid at a time: notices arriving together share it. */
  readonly #pending = new Map<string, Promise<string>>();
  readonly #fetch: PublicKeySource;
  readonly #now: () => number;
  readonly #perMinute: number;
  #window = { start: Number.NEGATIVE_INFINITY, count: 0 };

  constructor(
    fetchKey: PublicKeySource,
    now: () => number = Date.now,
    options: { fetchesPerMinute?: number } = {},
  ) {
    this.#fetch = fetchKey;
    this.#now = now;
    this.#perMinute = options.fetchesPerMinute ?? FETCHES_PER_MINUTE;
  }

  get = (kid: string, beforeFetch?: () => void): Promise<string> => this.#get(kid, beforeFetch);

  async #get(kid: string, beforeFetch?: () => void): Promise<string> {
    const t = this.#now();
    const hit = this.#keys.get(kid);
    if (hit !== undefined && hit.until > t) return hit.key;
    const missUntil = this.#misses.get(kid);
    if (missUntil !== undefined && missUntil > t) throw new EbayKeyNotFound();
    const pending = this.#pending.get(kid);
    if (pending !== undefined) return pending;
    if (t - this.#window.start >= 60_000) this.#window = { start: t, count: 0 };
    if (this.#window.count >= this.#perMinute) {
      // A kid we verified before is used past its hour rather than refused, so a flood that
      // holds the fetch cap cannot block eBay's own notices; it is refreshed once a slot is free.
      if (hit !== undefined) return hit.key;
      throw new EbayKeyFetchThrottled();
    }
    beforeFetch?.();
    this.#window.count += 1;
    const fetching = this.#fetch(kid)
      .then((key) => {
        // A few keys at most; an old one is replaced, never kept beside its successor.
        if (this.#keys.size > 32) this.#keys.clear();
        this.#keys.set(kid, { key, until: this.#now() + KEY_TTL_MS });
        return key;
      })
      .catch((err: unknown) => {
        if (err instanceof EbayKeyNotFound) {
          // Bounded: at most a few new entries a minute can be added (the fetch cap).
          if (this.#misses.size > 10_000) this.#misses.clear();
          this.#misses.set(kid, this.#now() + MISS_TTL_MS);
        }
        throw err;
      })
      .finally(() => {
        this.#pending.delete(kid);
      });
    this.#pending.set(kid, fetching);
    return fetching;
  }
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
    // eBay answers 404 for a kid it does not know: a forged notice, not an outage. Anything else
    // (a 400 from our own request too) stays an error, so eBay retries and nothing is cached.
    if (res.status === 404) throw new EbayKeyNotFound();
    if (!res.ok) throw new Error(`eBay public key: HTTP ${String(res.status)}`);
    const body = (await res.json()) as { key?: unknown };
    if (typeof body.key !== 'string') throw new Error('eBay public key: no key');
    return body.key;
  };
}
