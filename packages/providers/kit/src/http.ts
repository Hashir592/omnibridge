import type { Provider, ProviderMode } from '@omnibridge/core';
import { EgressRefused, ProviderUnavailable } from './errors.ts';

/**
 * Provider hosts per mode (invariant 17). The only place real provider hostnames are written.
 * Evri (M12) has its production host only: its test environment's host is not in its documents,
 * so a sandbox call is refused until the client gives it (a verify-live task). DPD comes in M13. A website is called at its own base URL (`site`, M11). Production hosts
 * are confirmed in M22.
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
    // EVRI-1: the Evri Business Accounts (myHermes) API.
    evri: { api: 'api.myhermes.co.uk' },
  },
};

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** HTTPS to a dotted host name that is not an IP address or a local name (a website, WEB-4). */
function publicHttps(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    host.includes('.') &&
    !host.startsWith('[') &&
    !/^[\d.]+$/.test(host) &&
    !/\.(localhost|local|internal|lan)$/.test(host) &&
    !LOOPBACK.includes(host)
  );
}

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

  /**
   * WEB-4: a seller's own website, at the base URL its admin set (WEB-1). Under the mocks in mock
   * mode, whatever the setting; else only HTTPS to a named host (no IP address, no localhost, no
   * single-label internal name), so a setting can never point a call at an internal service.
   */
  site(baseUrl: string): URL {
    if (this.#mocks !== undefined) return new URL('website/', this.#mocks);
    const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (!publicHttps(url)) throw new EgressRefused('website', url.host);
    return url;
  }

  #hosts(provider: Provider): Readonly<Record<string, string>> {
    return HOSTS[this.#mode === 'live' ? 'live' : 'sandbox'][provider] ?? {};
  }

  #allowed(provider: Provider, url: URL): boolean {
    if (this.#mode === 'mock') {
      return url.host === this.#mocks?.host || LOOPBACK.includes(url.hostname);
    }
    if (provider === 'website') return publicHttps(url);
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

/**
 * EVRI-2 step 1: the Evri page where the admin signs in and is sent back with a single-use code
 * in the address bar (the page may show an error; the code is in the URL). In mock mode the
 * provider-mocks page, which answers at once with a mock code.
 */
export function evriAuthoriseUrl(
  mode: ProviderMode,
  clientId: string,
  redirectUri: string,
  mocksPublicUrl?: string,
): URL | undefined {
  let page: URL;
  if (mode === 'mock') {
    if (mocksPublicUrl === undefined) return undefined;
    page = new URL(
      'evri/customer/authorize',
      mocksPublicUrl.endsWith('/') ? mocksPublicUrl : `${mocksPublicUrl}/`,
    );
  } else if (mode === 'live') {
    page = new URL('https://www.myhermes.co.uk/customer/authorize');
  } else {
    return undefined;
  }
  page.searchParams.set('response_type', 'code');
  page.searchParams.set('client_id', clientId);
  page.searchParams.set('redirect_uri', redirectUri);
  return page;
}
