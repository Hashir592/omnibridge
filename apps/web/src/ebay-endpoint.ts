/**
 * The eBay account deletion endpoint on its own (EBAY-2, T-0602), for the early public deploy
 * (T-0604): the same routes and handlers as web, with no database and no other route. It runs
 * from the web image as `node dist/ebay-endpoint.js`. Once the full app is live, web serves the
 * same path and this server is retired.
 */
import { requireEnv } from '@omnibridge/core';
import { webhookRoutes } from '@omnibridge/contract';
import { createLogger } from '@omnibridge/logger';
import Fastify from 'fastify';
import { contractRoutesPlugin, installContract } from './contract.ts';
import { ebayWebhookFromEnv, webhookVerifier } from './webhooks/ebay.ts';

const logger = createLogger({
  service: 'ebay-endpoint',
  version: process.env.APP_VERSION ?? '0.0.0-dev',
});
const ebay = ebayWebhookFromEnv(logger);
if (ebay === undefined) throw new Error('EBAY_VERIFICATION_TOKEN_FILE must be set');

const app = Fastify({
  loggerInstance: logger,
  // Only the HTTPS edge may name the client address (for the per-address limit).
  trustProxy: process.env.TRUSTED_PROXIES ?? false,
});
installContract(app);
void app.register(
  contractRoutesPlugin(webhookRoutes, ebay.handlers, {
    auth: { verifyWebhook: webhookVerifier(ebay) },
  }),
);

await app.listen({ host: '0.0.0.0', port: Number(requireEnv('PORT')) });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
