import type { Logger } from '@omnibridge/logger';
import Fastify from 'fastify';

export interface VaultAppOptions {
  logger: Logger;
  version: string;
  /** db-pii answers as vault_app. */
  dbPii: () => Promise<boolean>;
}

/**
 * pii-vault: the only db-pii client (invariant 5). T-0101 has only /healthz; the capability-scoped
 * API (ingest, read-full, mask, search, delete) arrives in M04.
 */
export function buildVaultApp({ logger, version, dbPii }: VaultAppOptions) {
  const app = Fastify({ loggerInstance: logger });

  // Polled every few seconds by Docker and the edge; only problems are logged.
  app.get('/healthz', { logLevel: 'warn' }, async (_request, reply) => {
    let healthy = false;
    try {
      healthy = await dbPii();
    } catch {
      healthy = false;
    }
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'degraded', db_pii: healthy ? 'ok' : 'error', version });
  });

  return app;
}
