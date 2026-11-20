import type { Provider, ProviderMode } from '@omnibridge/core';
import { EgressRefused } from './errors.ts';

/**
 * Provider hosts per mode (invariant 17). The only place real provider hostnames are written.
 * Carrier and website hosts are added with their modules (M11, M12, M13); until then a live call
 * to them is refused. Production hosts are confirmed in M22.
 */
const HOSTS: Readonly<Record<'sandbox' | 'live', Readonly<Record<Provider, readonly string[]>>>> = {
  sandbox: {
    amazon: ['sandbox.sellingpartnerapi-eu.amazon.com', 'api.amazon.com'],
    amazon_ads: ['advertising-api-test.amazon.com', 'api.amazon.co.uk'],
    ebay: ['api.sandbox.ebay.com'],
    website: [],
    evri: [],
    dpd: [],
  },
  live: {
    amazon: ['sellingpartnerapi-eu.amazon.com', 'api.amazon.com'],
    amazon_ads: ['advertising-api-eu.amazon.com', 'api.amazon.co.uk'],
    ebay: ['api.ebay.com'],
    website: [],
    evri: [],
    dpd: [],
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

  /** A provider's base URL: under the mocks in mock mode, else its first host for this mode. */
  base(provider: Provider, _service: string): URL {
    if (this.#mocks !== undefined) return new URL(`${provider}/`, this.#mocks);
    const host = HOSTS[this.#mode === 'live' ? 'live' : 'sandbox'][provider][0];
    if (host === undefined) throw new EgressRefused(provider, '(none configured)');
    return new URL(`https://${host}/`);
  }

  #allowed(provider: Provider, url: URL): boolean {
    if (this.#mode === 'mock') {
      return url.host === this.#mocks?.host || LOOPBACK.includes(url.hostname);
    }
    const hosts = HOSTS[this.#mode === 'live' ? 'live' : 'sandbox'][provider];
    return url.protocol === 'https:' && hosts.includes(url.hostname);
  }

  async request(provider: Provider, req: ProviderRequest): Promise<Response> {
    const url = new URL(req.url);
    if (!this.#allowed(provider, url)) throw new EgressRefused(provider, url.host);
    return this.#fetch(url.href, {
      method: req.method ?? 'GET',
      ...(req.headers === undefined ? {} : { headers: req.headers }),
      ...(req.body === undefined ? {} : { body: req.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }
}
