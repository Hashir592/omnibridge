import type { Logger } from '@omnibridge/logger';
import Fastify from 'fastify';

export interface HealthChecks {
  /** db-main answers as ob_app. */
  dbMain: () => Promise<boolean>;
  /** pii-vault reports db-pii healthy. web never connects to db-pii itself (invariant 5). */
  dbPii: () => Promise<boolean>;
}

export interface WebAppOptions {
  logger: Logger;
  version: string;
  checks: HealthChecks;
  /**
   * Proxy addresses or CIDRs whose X-Forwarded-For is believed (Fastify trustProxy). Default:
   * none, so request.ip is the direct peer and cannot be set by a client header.
   */
  trustedProxies?: string;
}

type Status = 'ok' | 'error';

export interface HealthBody {
  status: 'ok' | 'degraded';
  db_main: Status;
  db_pii: Status;
  version: string;
}

async function check(fn: () => Promise<boolean>): Promise<Status> {
  try {
    return (await fn()) ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

export function buildWebApp({ logger, version, checks, trustedProxies }: WebAppOptions) {
  const app = Fastify({ loggerInstance: logger, trustProxy: trustedProxies ?? false });

  // Polled every few seconds by Docker and the edge; only problems are logged.
  app.get('/healthz', { logLevel: 'warn' }, async (_request, reply) => {
    const [dbMain, dbPii] = await Promise.all([check(checks.dbMain), check(checks.dbPii)]);
    const healthy = dbMain === 'ok' && dbPii === 'ok';
    const body: HealthBody = {
      status: healthy ? 'ok' : 'degraded',
      db_main: dbMain,
      db_pii: dbPii,
      version,
    };
    return reply.code(healthy ? 200 : 503).send(body);
  });

  return app;
}
