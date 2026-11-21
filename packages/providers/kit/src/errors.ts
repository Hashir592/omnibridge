import type { Provider } from '@omnibridge/core';

/** A call refused before it was sent: its host is not on this mode's allowlist (invariant 17). */
export class EgressRefused extends Error {
  constructor(provider: Provider, host: string) {
    super(`Provider ${provider} may not reach host ${host} in this mode`);
    this.name = 'EgressRefused';
  }
}

/**
 * The provider refused the credential (AMZ-12, EBAY-5). `revoked`: the token can never work again
 * (invalid_grant, a revocation), so the account is marked Needs re-authorisation at once;
 * otherwise it counts towards the 3-in-an-hour rule.
 */
export class AuthFailed extends Error {
  readonly provider: Provider;
  readonly revoked: boolean;

  constructor(provider: Provider, revoked: boolean) {
    super(`${provider}: authorisation ${revoked ? 'revoked' : 'failed'}`);
    this.name = 'AuthFailed';
    this.provider = provider;
    this.revoked = revoked;
  }
}

/**
 * The provider said slow down (429). `retryAfterMs` when it said how long; `daily` when a daily
 * cap is spent (eBay), so nothing more may go today. `limitPerSecond` from x-amzn-RateLimit-Limit.
 */
export class RateLimited extends Error {
  readonly provider: Provider;
  readonly retryAfterMs: number | undefined;
  readonly daily: boolean;
  readonly limitPerSecond: number | undefined;

  constructor(
    provider: Provider,
    options: { retryAfterMs?: number; daily?: boolean; limitPerSecond?: number } = {},
  ) {
    super(`${provider}: rate limited${options.daily === true ? ' for today' : ''}`);
    this.name = 'RateLimited';
    this.provider = provider;
    this.retryAfterMs = options.retryAfterMs;
    this.daily = options.daily ?? false;
    this.limitPerSecond = options.limitPerSecond;
  }
}

/** The provider refused the request itself (e.g. Evri INVALID parcel): a stable code, no retry. */
export class ProviderRejected extends Error {
  readonly provider: Provider;
  readonly code: string;

  constructor(provider: Provider, code: string) {
    super(`${provider}: rejected (${code})`);
    this.name = 'ProviderRejected';
    this.provider = provider;
    this.code = code;
  }
}

/** 5xx, a timeout or a broken connection: worth a retry later. */
export class ProviderUnavailable extends Error {
  readonly provider: Provider;
  readonly status: number | undefined;

  constructor(provider: Provider, status?: number) {
    super(`${provider}: unavailable${status === undefined ? '' : ` (HTTP ${String(status)})`}`);
    this.name = 'ProviderUnavailable';
    this.provider = provider;
    this.status = status;
  }
}

/** True for a failure of the provider call itself, as opposed to our own (db-main, a bug). */
export function isProviderError(err: unknown): boolean {
  return (
    err instanceof AuthFailed ||
    err instanceof RateLimited ||
    err instanceof ProviderRejected ||
    err instanceof ProviderUnavailable ||
    err instanceof ProviderParserError ||
    err instanceof EgressRefused
  );
}

/** A stable error code for a provider failure, for health rows and job records. */
export function providerErrorCode(err: unknown): string {
  if (err instanceof AuthFailed) return 'provider.auth_failed';
  if (err instanceof RateLimited) return 'provider.rate_limited';
  if (err instanceof ProviderRejected) return 'provider.rejected';
  if (err instanceof ProviderUnavailable) return 'provider.unavailable';
  if (err instanceof ProviderParserError) return 'provider.parser_failed';
  if (err instanceof EgressRefused) return 'provider.egress_refused';
  return 'provider.failed';
}

/**
 * A provider answer the versioned parser cannot read (INT-5). It names the provider, parser,
 * version and field path only, never a value, and carries no cause (the Zod issue holds input).
 */
export class ProviderParserError extends Error {
  readonly provider: Provider;
  readonly parser: string;
  readonly version: number;
  readonly path: string;

  constructor(provider: Provider, parser: string, version: number, path: string) {
    super(`Parser ${provider}.${parser} v${String(version)} failed at ${path}`);
    this.name = 'ProviderParserError';
    this.provider = provider;
    this.parser = parser;
    this.version = version;
    this.path = path;
  }

  toJSON() {
    return { provider: this.provider, parser: this.parser, version: this.version, path: this.path };
  }
}
