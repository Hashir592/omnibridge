import type { AccessToken } from './adapters.ts';

/** A token is renewed this long before it expires, so no call goes out with a dying one. */
const EARLY_MS = 60_000;

/**
 * Access tokens per channel account, in this worker's memory only (never stored, never logged).
 * Refresh tokens and API keys stay encrypted in app.credentials (INT-3); a cold worker or an
 * expired token makes one refresh call, shared by concurrent callers.
 */
export class AccessTokenCache {
  readonly #tokens = new Map<string, AccessToken>();
  readonly #pending = new Map<string, Promise<AccessToken>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The cached token, or a new one from `issue`; `refreshed` says which. */
  async get(
    key: string,
    issue: () => Promise<AccessToken>,
  ): Promise<{ token: AccessToken; refreshed: boolean }> {
    const cached = this.#tokens.get(key);
    if (cached !== undefined && cached.expiresAt.getTime() - EARLY_MS > this.#now()) {
      return { token: cached, refreshed: false };
    }
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      pending = issue()
        .then((token) => {
          this.#tokens.set(key, token);
          return token;
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return { token: await pending, refreshed: true };
  }

  /** After a 401: the next call issues a new token. */
  invalidate(key: string): void {
    this.#tokens.delete(key);
  }
}
