import { EBAY_SDK_SAMPLE } from '@omnibridge/provider-ebay/testing';
import {
  accessToken,
  accountOf,
  form,
  MOCK_ORDERS,
  type MockApp,
  type ScenarioStore,
} from './scenarios.ts';

/*
 * eBay, from the official REST docs (developer.ebay.com):
 * - OAuth token: identity/v1/oauth2/token, grants client_credentials, authorization_code and
 *   refresh_token; errors are { error, error_description } (invalid_grant for a revoked token).
 * - Sell Fulfillment v1 getOrders: GET sell/fulfillment/v1/order?filter=lastmodifieddate:[from..]
 *   with limit and offset; { href, total, limit, offset, next?, orders[] }.
 * - Sell Inventory v1 bulkUpdatePriceQuantity: POST sell/inventory/v1/bulk_update_price_quantity,
 *   { requests: [{ sku, shipToLocationAvailability: { quantity } }] } -> { responses[] }.
 * - Commerce Notification v1 getPublicKey (T-0602), served with eBay's SDK sample key.
 * - Rate limits: HTTP 429 with errorId 2001 when a daily call limit is spent.
 */
const APP_TOKEN = 'mock-ebay-application-token';
const PAGE = 2;

export function ebayRoutes(app: MockApp, scenarios: ScenarioStore): void {
  app.post('/ebay/identity/v1/oauth2/token', (request, reply) => {
    if (!(request.headers.authorization ?? '').startsWith('Basic ')) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    const body = form(request.body);
    const grant = body.get('grant_type');
    if (grant === 'client_credentials') {
      return { access_token: APP_TOKEN, expires_in: 7200, token_type: 'Bearer' };
    }
    const account = grant === 'refresh_token' ? body.get('refresh_token') : body.get('code');
    if (account === null || (grant !== 'refresh_token' && grant !== 'authorization_code')) {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    if (
      grant === 'refresh_token' &&
      (scenarios.take('ebay', account, 'invalid_grant') || scenarios.on('ebay', account, 'revoked'))
    ) {
      return reply.code(400).send({
        error: 'invalid_grant',
        error_description: 'the provided authorization refresh token is invalid',
      });
    }
    return {
      access_token: accessToken('ebay', account),
      expires_in: 7200,
      token_type: 'User Access Token',
      ...(grant === 'authorization_code'
        ? { refresh_token: account, refresh_token_expires_in: 47_304_000 }
        : {}),
    };
  });

  /** The account of a user call, or a reply already sent for a refused one. */
  const callAccount = (
    authorization: string | undefined,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): string | undefined => {
    const account = accountOf('ebay', authorization?.replace(/^Bearer /, ''));
    if (account === undefined || scenarios.on('ebay', account, 'revoked')) {
      reply.code(401).send({
        errors: [
          { errorId: 1001, domain: 'OAuth', category: 'REQUEST', message: 'Invalid access token' },
        ],
      });
      return undefined;
    }
    if (scenarios.take('ebay', account, 'ebay_cap_exhausted')) {
      reply.code(429).send({
        errors: [
          { errorId: 2001, domain: 'ACCESS', category: 'REQUEST', message: 'Too many requests' },
        ],
      });
      return undefined;
    }
    if (scenarios.take('ebay', account, 'rate_limit_storm')) {
      reply.code(429).send({
        errors: [
          { errorId: 2001, domain: 'ACCESS', category: 'REQUEST', message: 'Too many requests' },
        ],
      });
      return undefined;
    }
    return account;
  };

  app.get<{ Querystring: { filter?: string; limit?: string; offset?: string } }>(
    '/ebay/sell/fulfillment/v1/order',
    (request, reply) => {
      if (callAccount(request.headers.authorization, reply) === undefined) return reply;
      const from = /lastmodifieddate:\[([^\].]+\.\d{3}Z)\.\./.exec(request.query.filter ?? '')?.[1];
      const offset = Number(request.query.offset ?? '0');
      const limit = Math.min(Number(request.query.limit ?? String(PAGE)), PAGE);
      const all = MOCK_ORDERS.filter((o) => from === undefined || o.updatedAt >= from);
      const page = all.slice(offset, offset + limit);
      return {
        href: 'mock',
        total: all.length,
        limit,
        offset,
        ...(offset + limit < all.length ? { next: `mock?offset=${String(offset + limit)}` } : {}),
        orders: page.map((o) => ({
          orderId: o.id,
          legacyOrderId: o.id,
          creationDate: o.updatedAt,
          lastModifiedDate: o.updatedAt,
          orderFulfillmentStatus: 'NOT_STARTED',
          orderPaymentStatus: 'PAID',
          buyer: { username: 'PIIMARK-ebay-buyer' },
          fulfillmentStartInstructions: [
            { shippingStep: { shipTo: { fullName: 'PIIMARK-Buyer Name' } } },
          ],
          lineItems: [
            { lineItemId: `${o.id}-1`, sku: o.sku, quantity: o.quantity, title: 'Mock item' },
          ],
        })),
      };
    },
  );

  app.post<{ Body: { requests?: { sku?: string }[] } }>(
    '/ebay/sell/inventory/v1/bulk_update_price_quantity',
    (request, reply) => {
      if (callAccount(request.headers.authorization, reply) === undefined) return reply;
      return {
        responses: (request.body.requests ?? []).map((r) => ({
          statusCode: 200,
          sku: r.sku ?? '',
        })),
      };
    },
  );

  // T-0602: the Notification API public key the account deletion endpoint fetches to check
  // X-EBAY-SIGNATURE. The key is eBay's own SDK sample, so eBay's sample signature verifies.
  app.get<{ Params: { kid: string } }>(
    '/ebay/commerce/notification/v1/public_key/:kid',
    (request, reply) => {
      if (request.headers.authorization !== `Bearer ${APP_TOKEN}`) {
        return reply.code(401).send({ errors: [{ message: 'Invalid access token' }] });
      }
      if (request.params.kid !== EBAY_SDK_SAMPLE.kid) {
        return reply.code(404).send({ errors: [{ message: 'Public key not found' }] });
      }
      return { algorithm: 'ECDSA', digest: 'SHA1', key: EBAY_SDK_SAMPLE.key };
    },
  );
}
