import { describe, expect, it } from 'vitest';
import { EgressRefused } from './errors.ts';
import { ProviderHttp } from './http.ts';

const ok = () => Promise.resolve(new Response('{"ok":true}', { status: 200 }));

describe('provider HTTP client: the egress allowlist (invariant 17)', () => {
  it('[INT-3] in mock mode only the provider-mocks host and loopback are reachable', async () => {
    const seen: string[] = [];
    const http = new ProviderHttp({
      mode: 'mock',
      mocksUrl: 'http://provider-mocks:8080',
      fetch: (url) => {
        seen.push(String(url));
        return ok();
      },
    });
    await http.request('ebay', { url: 'http://provider-mocks:8080/ebay/x' });
    await http.request('ebay', { url: 'http://127.0.0.1:4010/ebay/x' });
    expect(seen).toHaveLength(2);
    // A host outside the allowlist is refused before anything is sent.
    await expect(
      http.request('ebay', { url: 'https://example.com/steal' }),
    ).rejects.toBeInstanceOf(EgressRefused);
    await expect(
      http.request('ebay', { url: 'https://api.ebay.com/sell/x' }),
    ).rejects.toBeInstanceOf(EgressRefused);
    expect(seen).toHaveLength(2);
  });

  it('[INT-3] a live provider host is refused unless PROVIDER_MODE=live, and only over https', async () => {
    const sent: string[] = [];
    const fetchSpy = (url: string | URL | Request) => {
      sent.push(String(url));
      return ok();
    };
    const sandbox = new ProviderHttp({ mode: 'sandbox', fetch: fetchSpy });
    await expect(
      sandbox.request('ebay', { url: 'https://api.ebay.com/sell/fulfillment/v1/order' }),
    ).rejects.toBeInstanceOf(EgressRefused);
    await sandbox.request('ebay', {
      url: 'https://api.sandbox.ebay.com/sell/fulfillment/v1/order',
    });

    const live = new ProviderHttp({ mode: 'live', fetch: fetchSpy });
    await live.request('ebay', { url: 'https://api.ebay.com/sell/fulfillment/v1/order' });
    // Another provider's host is not this provider's: an eBay call cannot go to Amazon.
    await expect(
      live.request('ebay', { url: 'https://sellingpartnerapi-eu.amazon.com/orders/v0/orders' }),
    ).rejects.toBeInstanceOf(EgressRefused);
    await expect(
      live.request('ebay', { url: 'http://api.ebay.com/sell/fulfillment/v1/order' }),
    ).rejects.toBeInstanceOf(EgressRefused);
    expect(sent).toEqual([
      'https://api.sandbox.ebay.com/sell/fulfillment/v1/order',
      'https://api.ebay.com/sell/fulfillment/v1/order',
    ]);
  });

  it('[INT-3] mock mode needs the mocks URL, and each provider base sits under it', () => {
    expect(() => new ProviderHttp({ mode: 'mock' })).toThrow(/PROVIDER_MOCKS_URL/);
    const http = new ProviderHttp({ mode: 'mock', mocksUrl: 'http://provider-mocks:8080' });
    expect(http.base('ebay', 'api').href).toBe('http://provider-mocks:8080/ebay/');
    expect(new ProviderHttp({ mode: 'live' }).base('ebay', 'api').href).toBe(
      'https://api.ebay.com/',
    );
  });

  it('[INT-3] a redirect is never followed, so it cannot lead to another host', async () => {
    const http = new ProviderHttp({
      mode: 'mock',
      mocksUrl: 'http://provider-mocks:8080',
      fetch: (_url, init) => {
        expect(init?.redirect).toBe('manual');
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
        );
      },
    });
    const res = await http.request('ebay', { url: 'http://provider-mocks:8080/ebay/x' });
    expect(res.status).toBe(302);
  });
});
