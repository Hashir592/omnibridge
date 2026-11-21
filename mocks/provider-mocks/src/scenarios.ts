import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@omnibridge/logger';
import type { FastifyInstance, RawServerDefault } from 'fastify';

/** The mock server, typed with OmniBridge's logger. */
export type MockApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

/** The failures a test can switch on (ARCHITECTURE 6.5). */
export const SCENARIOS = [
  /** Every call answers 429 (Amazon: with x-amzn-RateLimit-Limit). */
  'rate_limit_storm',
  /** A carrier refuses the parcel: INVALID. */
  'invalid_parcel',
  /** Refreshing the token answers invalid_grant. */
  'invalid_grant',
  /** The seller revoked access: refresh fails and calls answer 401. */
  'revoked',
  /** eBay's daily call limit is spent: 429 with error 2001. */
  'ebay_cap_exhausted',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const MOCK_PROVIDERS = ['amazon', 'amazon_ads', 'ebay', 'website', 'evri', 'dpd'] as const;
export type MockProvider = (typeof MOCK_PROVIDERS)[number];

/** Any account of the provider. */
export const ANY_ACCOUNT = '*';

interface Entry {
  scenario: Scenario;
  /** Calls left before it switches itself off; Infinity until cleared. */
  remaining: number;
}

/**
 * Scenario switches per provider and account. The account is the mock's own key for a seller: the
 * refresh token or API key the test stored, which every access token the mock issues carries.
 */
export class ScenarioStore {
  readonly #entries = new Map<string, Entry>();

  set(provider: MockProvider, account: string, scenario: Scenario, count?: number): void {
    this.#entries.set(`${provider}|${account}`, { scenario, remaining: count ?? Infinity });
  }

  clear(): void {
    this.#entries.clear();
  }

  /** True (and one call used up) when `scenario` is on for this account or for any account. */
  take(provider: MockProvider, account: string, scenario: Scenario): boolean {
    for (const key of [`${provider}|${account}`, `${provider}|${ANY_ACCOUNT}`]) {
      const entry = this.#entries.get(key);
      if (entry?.scenario !== scenario || entry.remaining <= 0) continue;
      entry.remaining -= 1;
      return true;
    }
    return false;
  }

  /** Like take, for scenarios that hold for the whole flow (a revocation): nothing is used up. */
  on(provider: MockProvider, account: string, scenario: Scenario): boolean {
    return [`${provider}|${account}`, `${provider}|${ANY_ACCOUNT}`].some((key) => {
      const entry = this.#entries.get(key);
      return entry?.scenario === scenario && entry.remaining > 0;
    });
  }
}

/** POST /_mock/scenarios and DELETE /_mock/scenarios: tests and the dev UI switch failures. */
export function scenarioRoutes(app: MockApp, store: ScenarioStore): void {
  app.post<{
    Body: { provider?: string; account?: string; scenario?: string; count?: number };
  }>('/_mock/scenarios', (request, reply) => {
    const { provider, account, scenario, count } = request.body;
    if (
      !(MOCK_PROVIDERS as readonly string[]).includes(provider ?? '') ||
      !(SCENARIOS as readonly string[]).includes(scenario ?? '') ||
      (count !== undefined && (!Number.isInteger(count) || count < 1))
    ) {
      return reply.code(400).send({ error: 'provider, scenario and an optional count >= 1' });
    }
    store.set(provider as MockProvider, account ?? ANY_ACCOUNT, scenario as Scenario, count);
    return reply.code(204).send();
  });
  app.delete('/_mock/scenarios', (_request, reply) => {
    store.clear();
    return reply.code(204).send();
  });
}

/** Access tokens the mock issues carry the account they were issued for. */
export function accessToken(provider: MockProvider, account: string): string {
  return `mock-${provider}-access.${Buffer.from(account).toString('base64url')}`;
}

/** The account an access token was issued for, or undefined for a token the mock never issued. */
export function accountOf(provider: MockProvider, token: string | undefined): string | undefined {
  const prefix = `mock-${provider}-access.`;
  if (token?.startsWith(prefix) !== true) return undefined;
  return Buffer.from(token.slice(prefix.length), 'base64url').toString('utf8');
}

/** The value of a form body (OAuth token endpoints post application/x-www-form-urlencoded). */
export function form(body: unknown): URLSearchParams {
  return new URLSearchParams(typeof body === 'string' ? body : '');
}

/**
 * The fixed synthetic orders every channel mock serves: IDs, times and quantities, plus buyer-like
 * fields that carry the PIIMARK- marker, so a test can prove they never get past a parser.
 */
export const MOCK_ORDERS = [
  { id: 'MOCK-1001', updatedAt: '2026-11-20T10:00:00.000Z', sku: 'MOCK-SKU-1', quantity: 1 },
  { id: 'MOCK-1002', updatedAt: '2026-11-20T11:00:00.000Z', sku: 'MOCK-SKU-2', quantity: 2 },
  { id: 'MOCK-1003', updatedAt: '2026-11-20T12:00:00.000Z', sku: 'MOCK-SKU-1', quantity: 3 },
] as const;

/**
 * The fixed synthetic listings every channel mock serves (CAT-5): two that match the seeded
 * Master SKU codes exactly, one that matches nothing (the Unmapped queue), and on Amazon one FBA
 * listing (INV-9). Quantities let reconciliation compare (INV-7).
 */
export const MOCK_LISTINGS = [
  { sku: 'MOCK-SKU-1', id: 'MOCK-L-1', title: 'Mock bamboo bowl', quantity: 5, fba: false },
  { sku: 'MOCK-SKU-2', id: 'MOCK-L-2', title: 'Mock bamboo spoon', quantity: 8, fba: false },
  { sku: 'MOCK-UNMATCHED-1', id: 'MOCK-L-3', title: 'Mock odd item', quantity: 1, fba: false },
  { sku: 'MOCK-SKU-1-FBA', id: 'MOCK-L-4', title: 'Mock bamboo bowl FBA', quantity: 12, fba: true },
] as const;
