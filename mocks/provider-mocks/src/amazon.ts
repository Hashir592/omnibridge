import type { FastifyReply } from 'fastify';
import {
  accessToken,
  accountOf,
  form,
  MOCK_ORDERS,
  type MockProvider,
  type MockApp,
  type ScenarioStore,
} from './scenarios.ts';

/*
 * Amazon, from the official docs:
 * - Login with Amazon token: auth/o2/token, grants refresh_token and authorization_code with
 *   client_id and client_secret; errors { error, error_description } (invalid_grant).
 * - SP-API Orders v0 getOrders: GET orders/v0/orders?MarketplaceIds=&LastUpdatedAfter=&NextToken=,
 *   header x-amz-access-token; { payload: { Orders[], NextToken? } }; 429 { errors: [{ code:
 *   'QuotaExceeded' }] } with x-amzn-RateLimit-Limit.
 * - Listings Items 2021-08-01 patchListingsItem: PATCH listings/2021-08-01/items/{sellerId}/{sku};
 *   { sku, status: 'ACCEPTED', submissionId, issues[] }.
 * - Amazon Ads (amazon_ads): the same LWA grants; GET v2/profiles; PUT sp/campaigns (v3).
 */
export function lwaToken(app: MockApp, scenarios: ScenarioStore, provider: MockProvider) {
  app.post(`/${provider}/auth/o2/token`, (request, reply) => {
    const body = form(request.body);
    if (body.get('client_id') === null || body.get('client_secret') === null) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    const grant = body.get('grant_type');
    const account = grant === 'refresh_token' ? body.get('refresh_token') : body.get('code');
    if (account === null || (grant !== 'refresh_token' && grant !== 'authorization_code')) {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    if (
      grant === 'refresh_token' &&
      (scenarios.take(provider, account, 'invalid_grant') ||
        scenarios.on(provider, account, 'revoked'))
    ) {
      return reply
        .code(400)
        .send({ error: 'invalid_grant', error_description: 'The request has an invalid grant parameter' });
    }
    return {
      access_token: accessToken(provider, account),
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: account,
    };
  });
}

/** The account of an SP-API call, or undefined when a refusal was sent. */
function spApiAccount(
  scenarios: ScenarioStore,
  token: string | undefined,
  reply: FastifyReply,
): string | undefined {
  const account = accountOf('amazon', token);
  if (account === undefined || scenarios.on('amazon', account, 'revoked')) {
    void reply.code(403).send({ errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] });
    return undefined;
  }
  if (scenarios.take('amazon', account, 'rate_limit_storm')) {
    void reply
      .code(429)
      .header('x-amzn-RateLimit-Limit', '0.0167')
      .send({ errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota for the requested resource.' }] });
    return undefined;
  }
  return account;
}

export function amazonRoutes(app: MockApp, scenarios: ScenarioStore): void {
  lwaToken(app, scenarios, 'amazon');

  app.get<{ Querystring: { LastUpdatedAfter?: string; NextToken?: string } }>(
    '/amazon/orders/v0/orders',
    (request, reply) => {
      const token = request.headers['x-amz-access-token'];
      if (spApiAccount(scenarios, typeof token === 'string' ? token : undefined, reply) === undefined) {
        return reply;
      }
      const after = request.query.LastUpdatedAfter;
      const orders = MOCK_ORDERS.filter((o) => after === undefined || o.updatedAt >= after);
      return {
        payload: {
          Orders: orders.map((o) => ({
            AmazonOrderId: o.id,
            PurchaseDate: o.updatedAt,
            LastUpdateDate: o.updatedAt,
            OrderStatus: 'Unshipped',
            BuyerInfo: { BuyerEmail: 'PIIMARK-buyer@marketplace.amazon.co.uk' },
            NumberOfItemsUnshipped: o.quantity,
          })),
        },
      };
    },
  );

  app.patch<{ Params: { sellerId: string; sku: string } }>(
    '/amazon/listings/2021-08-01/items/:sellerId/:sku',
    (request, reply) => {
      const token = request.headers['x-amz-access-token'];
      if (spApiAccount(scenarios, typeof token === 'string' ? token : undefined, reply) === undefined) {
        return reply;
      }
      return { sku: request.params.sku, status: 'ACCEPTED', submissionId: 'mock-submission', issues: [] };
    },
  );
}

export function adsRoutes(app: MockApp, scenarios: ScenarioStore): void {
  lwaToken(app, scenarios, 'amazon_ads');
  const account = (authorization: string | undefined, reply: FastifyReply) => {
    const found = accountOf('amazon_ads', authorization?.replace(/^Bearer /, ''));
    if (found === undefined || scenarios.on('amazon_ads', found, 'revoked')) {
      void reply.code(401).send({ code: 'UNAUTHORIZED', details: 'Not authorized' });
      return undefined;
    }
    if (scenarios.take('amazon_ads', found, 'rate_limit_storm')) {
      void reply.code(429).header('retry-after', '1').send({ code: 'THROTTLED' });
      return undefined;
    }
    return found;
  };
  app.get('/amazon_ads/v2/profiles', (request, reply) => {
    if (account(request.headers.authorization, reply) === undefined) return reply;
    return [
      { profileId: 1234567890, countryCode: 'UK', currencyCode: 'GBP', accountInfo: { type: 'seller' } },
    ];
  });
  app.put<{ Body: { campaigns?: { campaignId?: string }[] } }>(
    '/amazon_ads/sp/campaigns',
    (request, reply) => {
      if (account(request.headers.authorization, reply) === undefined) return reply;
      const success = (request.body.campaigns ?? []).map((c, index) => ({
        campaignId: c.campaignId ?? '',
        index,
      }));
      return { campaigns: { success, error: [] } };
    },
  );
}
