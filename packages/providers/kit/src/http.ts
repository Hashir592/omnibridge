import type { Provider, ProviderMode } from '@omnibridge/core';
import { EgressRefused, ProviderUnavailable } from './errors.ts';

/**
 * Provider hosts per mode (invariant 17). The only place real provider hostnames are written.
 * Carrier and website hosts are added with their modules (M11, M12, M13); until then a live call
 * to them is refused. Production hosts are confirmed in M22.
 */
type Hosts = Readonly<Partial<Record<Provider, Readonly<Record<string, string>>>>>;
const HOSTS: Readonly<Record<'sandbox' | 'live', Hosts>> = {
  sandbox: {
    amazon: { api: 'sandbox.sellingpartnerapi-eu.amazon.com', lwa: 'api.amazon.com' },
    amazon_ads: { api: 'advertising-api-test.amazon.com', lwa: 'api.amazon.co.uk' },
    ebay: { api: 'api.sandbox.ebay.com' },
  },
  live: {
    amazon: { api: 'sellingpartnerapi-eu.amazon.com', lwa: 'api.amazon.com' },
    amazon_ads: { api: 'advertising-api-eu.amazon.com', lwa: 'api.amazon.co.uk' },
    ebay: { api: 'api.ebay.com' },
  },
};

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export interface ProviderHttpOptions {
  mode: ProviderMode;
  /** mock mode: the provider-mocks base URL (PROVIDER_MOCKS_URL). */
  mocksUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ProviderRequest {
  url: string | URL;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The one HTTP client provider adapters use: allowlisted hosts only, no redirects, a timeout. */
export class ProviderHttp {
  readonly #mode: ProviderMode;
  readonly #mocks: URL | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ProviderHttpOptions) {
    this.#mode = options.mode;
    if (options.mode === 'mock') {
      if (options.mocksUrl === undefined) throw new Error('mock mode needs PROVIDER_MOCKS_URL');
      this.#mocks = new URL(options.mocksUrl);
    }
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * A provider's base URL for one of its services (`api`, `lwa`): under the mocks in mock mode,
   * else the host this mode lists for it.
   */
  base(provider: Provider, service: string): URL {
    if (this.#mocks !== undefined) return new URL(`${provider}/`, this.#mocks);
    const host = this.#hosts(provider)[service];
    if (host === undefined) throw new EgressRefused(provider, `(no ${service} host)`);
    return new URL(`https://${host}/`);
  }

  #hosts(provider: Provider): Readonly<Record<string, string>> {
    return HOSTS[this.#mode === 'live' ? 'live' : 'sandbox'][provider] ?? {};
  }

  #allowed(provider: Provider, url: URL): boolean {
    if (this.#mode === 'mock') {
      return url.host === this.#mocks?.host || LOOPBACK.includes(url.hostname);
    }
    return url.protocol === 'https:' && Object.values(this.#hosts(provider)).includes(url.hostname);
  }

  async request(provider: Provider, req: ProviderRequest): Promise<Response> {
    const url = new URL(req.url);
    if (!this.#allowed(provider, url)) throw new EgressRefused(provider, url.host);
    try {
      return await this.#fetch(url.href, {
        method: req.method ?? 'GET',
        ...(req.headers === undefined ? {} : { headers: req.headers }),
        ...(req.body === undefined ? {} : { body: req.body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // A refused connection, a reset or the timeout: retry later. The cause is dropped, as it
      // may carry the URL with its query.
      throw new ProviderUnavailable(provider);
    }
  }
}

/**
 * Where the seller's browser goes to grant access (a page, not an API call): live and sandbox
 * consent pages per OAuth provider. In mock mode the provider-mocks consent page, which answers at
 * once with a mock code. Amazon Ads (M19) has none yet.
 */
const CONSENT: Readonly<Record<'sandbox' | 'live', Readonly<Partial<Record<Provider, string>>>>> = {
  sandbox: {
    ebay: 'https://auth.sandbox.ebay.com/oauth2/authorize',
    amazon: 'https://sellercentral.amazon.co.uk/apps/authorize/consent',
  },
  live: {
    ebay: 'https://auth.ebay.com/oauth2/authorize',
    amazon: 'https://sellercentral.amazon.co.uk/apps/authorize/consent',
  },
};

export function consentUrl(
  mode: ProviderMode,
  provider: Provider,
  mocksPublicUrl?: string,
): URL | undefined {
  if (mode === 'mock') {
    if (mocksPublicUrl === undefined || !(provider in CONSENT.live)) return undefined;
    return new URL(
      `${provider}/oauth2/authorize`,
      mocksPublicUrl.endsWith('/') ? mocksPublicUrl : `${mocksPublicUrl}/`,
    );
  }
  const page = CONSENT[mode === 'live' ? 'live' : 'sandbox'][provider];
  return page === undefined ? undefined : new URL(page);
}
