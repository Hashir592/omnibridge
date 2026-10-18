import { contractRoutes, type Health } from '@omnibridge/contract';
import type { Logger } from '@omnibridge/logger';
import Fastify from 'fastify';
import { contractRoutesPlugin, installContract, type Handlers } from './contract.ts';

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
  /** Collect the OpenAPI document; set by the contract generator and tests only. */
  openapi?: boolean;
}

async function check(fn: () => Promise<boolean>): Promise<Health['db_main']> {
  try {
    return (await fn()) ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

export function buildWebApp({ logger, version, checks, trustedProxies, openapi }: WebAppOptions) {
  const app = Fastify({ loggerInstance: logger, trustProxy: trustedProxies ?? false });
  installContract(app, { openapi: openapi ?? false });

  const handlers: Handlers<typeof contractRoutes> = {
    getHealth: async () => {
      const [dbMain, dbPii] = await Promise.all([check(checks.dbMain), check(checks.dbPii)]);
      const healthy = dbMain === 'ok' && dbPii === 'ok';
      const body: Health = {
        status: healthy ? 'ok' : 'degraded',
        db_main: dbMain,
        db_pii: dbPii,
        version,
      };
      return healthy ? { status: 200, body } : { status: 503, body };
    },
  };

  // A contract error rejects app.ready(), so the server never starts (invariant 4).
  // /healthz is polled every few seconds by Docker and the edge; only problems are logged.
  void app.register(
    contractRoutesPlugin(contractRoutes, handlers, { logLevels: { getHealth: 'warn' } }),
  );

  return app;
}
