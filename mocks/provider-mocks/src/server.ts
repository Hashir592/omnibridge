import type { Logger } from '@omnibridge/logger';
import { EBAY_SDK_SAMPLE } from '@omnibridge/provider-ebay';
import Fastify from 'fastify';

/**
 * One mock server for every provider (ADR-011): the only provider endpoints dev and CI may call.
 * T-0101 has a single placeholder route; real routes are written from the official specs in M07+.
 */
export function buildMockServer(logger: Logger) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/_mock/health', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  // OAuth token endpoints take form bodies; the mocks only need them to arrive.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  // Placeholder for the Amazon SP-API mock.
  app.get('/amazon/ping', () => ({ ok: true, provider: 'amazon', mock: true }));

  // eBay (T-0602): the application token and the Notification API public key the account
  // deletion endpoint fetches to check X-EBAY-SIGNATURE. The key is eBay's own SDK sample, so
  // eBay's sample signature verifies against it.
  app.post('/ebay/identity/v1/oauth2/token', (request, reply) => {
    if (!(request.headers.authorization ?? '').startsWith('Basic ')) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    return { access_token: 'mock-ebay-application-token', expires_in: 7200, token_type: 'Bearer' };
  });
  app.get<{ Params: { kid: string } }>(
    '/ebay/commerce/notification/v1/public_key/:kid',
    (request, reply) => {
      if (request.headers.authorization !== 'Bearer mock-ebay-application-token') {
        return reply.code(401).send({ errors: [{ message: 'Invalid access token' }] });
      }
      if (request.params.kid !== EBAY_SDK_SAMPLE.kid) {
        return reply.code(404).send({ errors: [{ message: 'Public key not found' }] });
      }
      return { algorithm: 'ECDSA', digest: 'SHA1', key: EBAY_SDK_SAMPLE.key };
    },
  );

  return app;
}
