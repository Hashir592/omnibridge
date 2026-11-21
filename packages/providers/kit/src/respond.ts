import type { Provider } from '@omnibridge/core';
import { AuthFailed, ProviderRejected, ProviderUnavailable, RateLimited } from './errors.ts';

/** Retry-After in seconds or an HTTP date, as milliseconds; undefined when absent or unreadable. */
export function retryAfterMs(res: Response, now = Date.now()): number | undefined {
  const value = res.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * The common reading of a provider answer: 2xx gives the JSON body; 401 and 403 are auth
 * failures; 429 is a rate limit; 5xx is unavailable; any other 4xx is a rejection with a stable
 * code. Adapters check provider-specific answers (invalid_grant, eBay's daily cap) first.
 */
export async function readJson(provider: Provider, res: Response): Promise<unknown> {
  if (res.ok) {
    const text = await res.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  }
  // The body is never read into an error: it may hold provider text or buyer data.
  await res.body?.cancel();
  if (res.status === 401 || res.status === 403) throw new AuthFailed(provider, false);
  if (res.status === 429) {
    const after = retryAfterMs(res);
    throw new RateLimited(provider, after === undefined ? {} : { retryAfterMs: after });
  }
  if (res.status >= 500) throw new ProviderUnavailable(provider, res.status);
  throw new ProviderRejected(provider, `http_${String(res.status)}`);
}
