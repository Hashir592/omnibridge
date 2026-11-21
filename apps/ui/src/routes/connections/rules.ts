/**
 * Connections rules that need no server (T-0314), kept apart so unit tests can prove them. The
 * server works out each status (disconnected, then needs_reauth, then paused, then error) and
 * checks every write again.
 */
import type { ApiUsageToday, Connection, Provider } from '../../auth/api.ts';
import { formatInt } from '../../lib/format.ts';

export type Kind = 'channel' | 'ads' | 'carrier';

export function kindOf(provider: Provider): Kind {
  if (provider === 'amazon_ads') return 'ads';
  if (provider === 'evri' || provider === 'dpd') return 'carrier';
  return 'channel';
}

/** Accounts connected with OAuth; the others take an API key, and authorise answers 409. */
const OAUTH: ReadonlySet<Provider> = new Set(['amazon', 'amazon_ads', 'ebay']);

/** Re-authorise (or connect again) is offered for an OAuth account that needs it. */
export const canAuthorise = (c: Pick<Connection, 'provider' | 'status'>): boolean =>
  OAUTH.has(c.provider) && (c.status === 'needs_reauth' || c.status === 'disconnected');

/** Calls today against the cap, in the provider's own day (RL-5). */
export function usageLine(u: ApiUsageToday): string {
  return u.cap === null
    ? `${formatInt(u.calls)} calls, no daily cap`
    : `${formatInt(u.calls)} of ${formatInt(u.cap)}`;
}

/** Whole percent of the cap used; null without a cap. */
export function usageShare(u: ApiUsageToday): number | null {
  return u.cap === null || u.cap === 0 ? null : Math.round((u.calls / u.cap) * 100);
}

/** The OAuth return (`?connected=<id>` or `?error=<code>`), read once from the address. */
export type OAuthReturn = { ok: true; accountId: string } | { ok: false; text: string };

/**
 * Every `error` the OAuth return can carry: OAUTH_RETURN_ERRORS in the contract (S3, 21 Nov 2026).
 * The SPA may import only the typed client (ADR-004), which does not carry that list, so it is
 * mirrored here. Any other value gets the generic line.
 */
type OAuthReturnError = 'access_denied' | 'state_invalid' | 'exchange_failed' | 'forbidden';

const OAUTH_ERROR: Record<OAuthReturnError, string> = {
  access_denied: 'The provider was not given access. Nothing changed.',
  state_invalid: 'That sign-in link had expired or was already used. Start again.',
  exchange_failed: 'The provider did not finish the connection. Try again in a few minutes.',
  forbidden: 'You are no longer an admin of this workspace, so nothing was saved.',
};

const isOAuthError = (v: string): v is OAuthReturnError => Object.hasOwn(OAUTH_ERROR, v);

export function oauthReturn(search: {
  connected?: string | undefined;
  error?: string | undefined;
}): OAuthReturn | undefined {
  if (search.connected) return { ok: true, accountId: search.connected };
  if (search.error) {
    return {
      ok: false,
      text: isOAuthError(search.error)
        ? OAUTH_ERROR[search.error]
        : 'The account could not be connected. Try again.',
    };
  }
  return undefined;
}
