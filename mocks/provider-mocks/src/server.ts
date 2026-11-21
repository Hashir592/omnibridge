import { randomUUID } from 'node:crypto';
import type { Logger } from '@omnibridge/logger';
import Fastify from 'fastify';
import { adsRoutes, amazonRoutes } from './amazon.ts';
import { dpdRoutes, evriRoutes, websiteRoutes } from './carriers.ts';
import { ebayRoutes } from './ebay.ts';
import { ScenarioStore, scenarioRoutes } from './scenarios.ts';

/**
 * One mock server for every provider (ADR-011): the only provider endpoints dev and CI may call.
 * Each provider has a token or key check, one cursor read and one write (M07); later modules add
 * the endpoints their adapters use. Failures are switched on per account with /_mock/scenarios.
 */
export function buildMockServer(logger: Logger, scenarios: ScenarioStore = new ScenarioStore()) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/_mock/health', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  // OAuth token endpoints take form bodies.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  // Amazon Ads v3 sends a vendor JSON type.
  app.addContentTypeParser(
    /^application\/vnd\.[a-z0-9.]+\+json$/,
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(typeof body === 'string' ? body : body.toString()) as unknown);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Placeholder from T-0101, kept for the walking-skeleton stub adapter.
  app.get('/amazon/ping', () => ({ ok: true, provider: 'amazon', mock: true }));

  scenarioRoutes(app, scenarios);
  // The consent page of an OAuth provider: the seller "agrees" at once and the browser goes back
  // to redirect_uri with a mock code and the state it was given.
  app.get<{ Params: { provider: string }; Querystring: { redirect_uri?: string; state?: string } }>(
    '/:provider/oauth2/authorize',
    (request, reply) => {
      const { redirect_uri: redirect, state } = request.query;
      if (redirect === undefined || state === undefined || !/^https?:\/\//.test(redirect)) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const back = new URL(redirect);
      back.searchParams.set(
        request.params.provider === 'amazon' ? 'spapi_oauth_code' : 'code',
        `mock-code-${randomUUID()}`,
      );
      back.searchParams.set('state', state);
      return reply.redirect(back.href, 302);
    },
  );
  amazonRoutes(app, scenarios);
  adsRoutes(app, scenarios);
  ebayRoutes(app, scenarios);
  evriRoutes(app, scenarios);
  dpdRoutes(app, scenarios);
  websiteRoutes(app, scenarios);

  return app;
}
