import { Secret } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { createAdsAdapter } from '@omnibridge/provider-ads';
import { createAmazonAdapter } from '@omnibridge/provider-amazon';
import { createDpdAdapter } from '@omnibridge/provider-dpd';
import { createEbayAdapter } from '@omnibridge/provider-ebay';
import { createEvriAdapter } from '@omnibridge/provider-evri';
import {
  AuthFailed,
  ProviderHttp,
  ProviderRejected,
  RateLimited,
  type AccessToken,
} from '@omnibridge/provider-kit';
import { createWebsiteAdapter } from '@omnibridge/provider-website';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScenarioStore, type MockProvider, type Scenario } from './scenarios.ts';
import { buildMockServer } from './server.ts';

/**
 * Every adapter against the provider mocks (INT-1, INT-5): the mock answers go through the
 * adapters' own versioned parsers, buyer-like fields never come out, and every scenario switch
 * arrives at the adapter as its typed error.
 */
describe('adapters against provider-mocks (INT-1)', () => {
  const scenarios = new ScenarioStore();
  const mock = buildMockServer(createLogger({ service: 'mock', version: '0', level: 'silent' }), scenarios);
  let http: ProviderHttp;
  const id = new Secret('synthetic-client-id');
  const secret = new Secret('synthetic-client-secret');
  const since = new Date('2026-11-20T10:30:00.000Z');
  let n = 0;
  /** A fresh account key per test, so scenarios never leak between them. */
  const account = () => new Secret(`TOKENMARK-account-${String((n += 1))}`);
  const on = (provider: MockProvider, credential: Secret, scenario: Scenario, count?: number) =>
    scenarios.set(provider, credential.reveal(), scenario, count);

  beforeAll(async () => {
    const url = await mock.listen({ host: '127.0.0.1', port: 0 });
    http = new ProviderHttp({ mode: 'mock', mocksUrl: url });
  });
  afterAll(async () => {
    await mock.close();
  });

  const ebay = () => createEbayAdapter({ http, clientId: id, clientSecret: secret, pageSize: 2 });
  const amazon = () =>
    createAmazonAdapter({ http, clientId: id, clientSecret: secret, sellerId: 'MOCKSELLER' });

  it('[INT-1] eBay: token, the updated-since order read across pages, and the stock write', async () => {
    const adapter = ebay();
    const token = await adapter.authenticate(account());
    const first = await adapter.ordersUpdatedSince(token, since);
    expect(first.items.map((o) => o.externalId)).toEqual(['MOCK-1002', 'MOCK-1003']);
    expect(first.next).toBeUndefined();
    const all = await adapter.ordersUpdatedSince(token, new Date('2026-11-20T00:00:00.000Z'));
    expect(all.items).toHaveLength(2);
    expect(all.next).toBe('2');
    const rest = await adapter.ordersUpdatedSince(token, new Date('2026-11-20T00:00:00.000Z'), all.next);
    expect(rest.items.map((o) => o.externalId)).toEqual(['MOCK-1003']);
    // The parser dropped the buyer fields.
    expect(JSON.stringify([first, all, rest])).not.toContain('PIIMARK');
    expect(await adapter.pushStock(token, [{ sku: 'MOCK-SKU-1', quantity: 4 }])).toEqual({
      accepted: ['MOCK-SKU-1'],
      refused: [],
    });
  });

  it('[INT-1] eBay scenarios: invalid_grant and revoked are revocations; cap exhaustion is a daily limit', async () => {
    const adapter = ebay();
    const grant = account();
    on('ebay', grant, 'invalid_grant');
    await expect(adapter.authenticate(grant)).rejects.toMatchObject({ name: 'AuthFailed', revoked: true });

    const revoked = account();
    const token = await adapter.authenticate(revoked);
    on('ebay', revoked, 'revoked');
    await expect(adapter.ordersUpdatedSince(token, since)).rejects.toMatchObject({
      name: 'AuthFailed',
      revoked: false,
    });
    await expect(adapter.authenticate(revoked)).rejects.toMatchObject({ revoked: true });

    const capped = account();
    const capToken = await adapter.authenticate(capped);
    on('ebay', capped, 'ebay_cap_exhausted', 1);
    const err = await adapter.ordersUpdatedSince(capToken, since).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect((err as RateLimited).daily).toBe(true);
    // Count 1: the switch turns itself off.
    await expect(adapter.ordersUpdatedSince(capToken, since)).resolves.toBeDefined();
  });

  it('[INT-1] Amazon: LWA token, orders and the listings patch; a 429 storm carries the rate limit', async () => {
    const adapter = amazon();
    const credential = account();
    const token = await adapter.authenticate(credential);
    const orders = await adapter.ordersUpdatedSince(token, since);
    expect(orders.items.map((o) => o.externalId)).toEqual(['MOCK-1002', 'MOCK-1003']);
    expect(JSON.stringify(orders)).not.toContain('PIIMARK');
    expect(await adapter.pushStock(token, [{ sku: 'MOCK-SKU-1', quantity: 2 }])).toEqual({
      accepted: ['MOCK-SKU-1'],
      refused: [],
    });
    on('amazon', credential, 'rate_limit_storm');
    const err = await adapter.ordersUpdatedSince(token, since).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect((err as RateLimited).limitPerSecond).toBe(0.0167);

    const revoked = account();
    on('amazon', revoked, 'invalid_grant');
    await expect(adapter.authenticate(revoked)).rejects.toMatchObject({ revoked: true });
  });

  it('[INT-1] Evri: services, parcel, label and tracking; an INVALID parcel is a typed rejection', async () => {
    const adapter = createEvriAdapter({ http, clientId: id });
    const credential = account();
    const token: AccessToken = await adapter.authenticate(credential);
    expect((await adapter.listServices(token, 'GB', 'GB', [])).map((s) => s.code)).toContain('EVRI-48');
    const order = {
      reference: 'MOCK-1001',
      address: { name: 'PIIMARK-Name', line1: 'PIIMARK-1 Street', city: 'Testville', postcode: 'TE1 1ST', country: 'GB' },
    };
    const shipment = await adapter.createShipment(token, order, [{ weightGrams: 500 }], 'EVRI-48');
    expect(shipment).toEqual({
      trackingNumbers: ['H00MOCK0000001'],
      carrierShipmentRef: 'EVRI-P-1',
      labels: [{ format: 'pdf', ref: 'EVRI-L-1' }],
    });
    expect(Buffer.from(await adapter.getLabel(token, 'EVRI-L-1', 'pdf')).toString()).toContain('%PDF');
    expect(await adapter.tracking(token, 'H00MOCK0000001')).toHaveLength(1);

    on('evri', credential, 'invalid_parcel', 1);
    const err = await adapter
      .createShipment(token, order, [{ weightGrams: 500 }], 'EVRI-48')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRejected);
    expect((err as ProviderRejected).code).toBe('evri.invalid');
    expect(JSON.stringify(err)).not.toContain('PIIMARK');
  });

  it('[INT-1] DPD: login, services, shipment and label; an invalid parcel is a typed rejection', async () => {
    const adapter = createDpdAdapter({ http });
    const credential = account();
    const token = await adapter.authenticate(credential);
    expect((await adapter.listServices(token, 'GB', 'GB', [])).map((s) => s.code)).toContain('1^12');
    const order = {
      reference: 'MOCK-1002',
      address: { name: 'PIIMARK-Name', line1: 'PIIMARK-2 Street', city: 'Testville', postcode: 'TE1 1ST', country: 'GB' },
    };
    const shipment = await adapter.createShipment(token, order, [{ weightGrams: 900 }], '1^12');
    expect(shipment.trackingNumbers).toEqual(['15500000000001']);
    expect(Buffer.from(await adapter.getLabel(token, shipment.carrierShipmentRef, 'pdf')).toString()).toContain('%PDF');
    expect(await adapter.tracking(token, '15500000000001')).toHaveLength(1);
    on('dpd', credential, 'invalid_parcel', 1);
    await expect(
      adapter.createShipment(token, order, [{ weightGrams: 900 }], '1^12'),
    ).rejects.toMatchObject({ name: 'ProviderRejected', code: 'dpd.1008' });
  });

  it('[INT-1] website and Amazon Ads: one read and one write each', async () => {
    const site = createWebsiteAdapter({ http });
    const key = account();
    const token = await site.authenticate(key);
    const orders = await site.ordersUpdatedSince(token, since);
    expect(orders.items.map((o) => o.externalId)).toEqual(['MOCK-1002', 'MOCK-1003']);
    expect(JSON.stringify(orders)).not.toContain('PIIMARK');
    expect(await site.pushStock(token, [{ sku: 'MOCK-SKU-2', quantity: 1 }])).toEqual({
      accepted: ['MOCK-SKU-2'],
      refused: [],
    });
    on('website', key, 'revoked');
    await expect(site.ordersUpdatedSince(token, since)).rejects.toBeInstanceOf(AuthFailed);

    const ads = createAdsAdapter({ http, clientId: id, clientSecret: secret });
    const adsToken = await ads.authenticate(account());
    expect(await ads.profiles(adsToken)).toEqual([{ profileId: '1234567890', countryCode: 'UK' }]);
    expect(
      await ads.setCampaignStates(adsToken, '1234567890', [{ campaignId: 'C1', state: 'paused' }]),
    ).toEqual({ accepted: ['C1'], refused: [] });
  });

  it('[INT-3] a scenario switch is set and cleared over HTTP, as dev and CI use it', async () => {
    const set = await mock.inject({
      method: 'POST',
      url: '/_mock/scenarios',
      payload: { provider: 'ebay', account: 'x', scenario: 'revoked' },
    });
    expect(set.statusCode).toBe(204);
    const bad = await mock.inject({
      method: 'POST',
      url: '/_mock/scenarios',
      payload: { provider: 'ebay', scenario: 'scrape_everything' },
    });
    expect(bad.statusCode).toBe(400);
    expect((await mock.inject({ method: 'DELETE', url: '/_mock/scenarios' })).statusCode).toBe(204);
  });
});
