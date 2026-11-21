/**
 * The one provider call web makes (INT-2, invariant 15): the OAuth code exchange when a seller
 * comes back from a provider's consent page. Named in the dependency-cruiser exception; nothing
 * else in web imports a provider package. Everything goes through the provider HTTP client and its
 * egress allowlist (invariant 17).
 */
import type { OAuthProvider, ProviderMode } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import { createAmazonAdapter } from '@omnibridge/provider-amazon';
import { createEbayAdapter, EBAY_USER_SCOPES } from '@omnibridge/provider-ebay';
import { consentUrl, ProviderHttp, type TokenGrant } from '@omnibridge/provider-kit';

export type { TokenGrant };

/** App secrets of the platform (PLAT-4), read when a connect happens. */
export type SecretReader = (
  name:
    'ebay.client_id' | 'ebay.client_secret' | 'amazon.lwa_client_id' | 'amazon.lwa_client_secret',
) => Promise<Secret | undefined>;

export interface OAuthFlows {
  /** The consent page with our state on it, or undefined when this provider cannot connect yet. */
  consent(provider: OAuthProvider, state: string, redirectUri: string): Promise<string | undefined>;
  exchange(provider: OAuthProvider, code: string, redirectUri: string): Promise<TokenGrant>;
}

export class OAuthNotConfigured extends Error {
  constructor() {
    super('The provider app credentials are not set');
    this.name = 'OAuthNotConfigured';
  }
}

export function createOAuthFlows(options: {
  mode: ProviderMode;
  mocksUrl?: string;
  /** The provider-mocks address a browser can reach (dev only); consent is unavailable without it. */
  mocksPublicUrl?: string;
  /** eBay's RuName names the redirect in production; the mocks take the URL itself. */
  ebayRuName?: string;
  secrets: SecretReader;
}): OAuthFlows {
  const http = new ProviderHttp({
    mode: options.mode,
    ...(options.mocksUrl === undefined ? {} : { mocksUrl: options.mocksUrl }),
  });
  const need = async (name: Parameters<SecretReader>[0]) => {
    const value = await options.secrets(name);
    if (value === undefined) throw new OAuthNotConfigured();
    return value;
  };
  const ebayRedirect = (uri: string) =>
    options.mode === 'mock' ? uri : (options.ebayRuName ?? uri);

  return {
    async consent(provider, state, redirectUri) {
      const page = consentUrl(options.mode, provider, options.mocksPublicUrl);
      if (page === undefined) return undefined;
      if (provider === 'ebay') {
        page.searchParams.set('client_id', (await need('ebay.client_id')).reveal());
        page.searchParams.set('redirect_uri', ebayRedirect(redirectUri));
        page.searchParams.set('response_type', 'code');
        page.searchParams.set('scope', EBAY_USER_SCOPES.join(' '));
      } else {
        page.searchParams.set('application_id', (await need('amazon.lwa_client_id')).reveal());
        page.searchParams.set('redirect_uri', redirectUri);
      }
      page.searchParams.set('state', state);
      return page.href;
    },

    async exchange(provider, code, redirectUri) {
      if (provider === 'ebay') {
        return createEbayAdapter({
          http,
          clientId: await need('ebay.client_id'),
          clientSecret: await need('ebay.client_secret'),
          ruName: ebayRedirect(redirectUri),
        }).exchangeCode(code);
      }
      if (provider === 'amazon') {
        return createAmazonAdapter({
          http,
          clientId: await need('amazon.lwa_client_id'),
          clientSecret: await need('amazon.lwa_client_secret'),
          sellerId: '',
        }).exchangeCode(code);
      }
      throw new OAuthNotConfigured();
    },
  };
}
