import type { Logger } from '@omnibridge/logger';
import Fastify from 'fastify';

/**
 * One mock server for every provider (ADR-011): the only provider endpoints dev and CI may call.
 * T-0101 has a single placeholder route; real routes are written from the official specs in M07+.
 */
export function buildMockServer(logger: Logger) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/_mock/health', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  // Placeholder for the Amazon SP-API mock.
  app.get('/amazon/ping', () => ({ ok: true, provider: 'amazon', mock: true }));

  return app;
}
