import { contractRoutes, type Health, type JobProgress } from '@omnibridge/contract';
import { ApiError, type TenantContext } from '@omnibridge/core';
import type { Logger } from '@omnibridge/logger';
import Fastify, { type FastifyRequest } from 'fastify';
import { contractRoutesPlugin, installContract, type Handlers } from './contract.ts';

export interface HealthChecks {
  /** db-main answers as ob_app. */
  dbMain: () => Promise<boolean>;
  /** pii-vault reports db-pii healthy. web never connects to db-pii itself (invariant 5). */
  dbPii: () => Promise<boolean>;
}

/** Reads a job's progress inside the caller's workspace (packages/db JobRecordRepository). */
export interface JobProgressReader {
  get(
    ctx: TenantContext,
    id: string,
  ): Promise<
    | {
        id: string;
        type: string;
        state: JobProgress['state'];
        attempt: number;
        percent: number;
        result: Record<string, unknown> | null;
        errorCode: string | null;
        createdAt: Date;
        updatedAt: Date;
      }
    | undefined
  >;
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
  /** Job progress for GET /jobs/:id (NFR-4). */
  jobs?: JobProgressReader;
  /**
   * The signed-in user's workspace for `session` routes. Sessions arrive in M02; until then
   * production passes nothing, so every session route answers 401 and none is ever open.
   */
  resolveTenant?: (request: FastifyRequest) => TenantContext | undefined;
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

export function buildWebApp({
  logger,
  version,
  checks,
  trustedProxies,
  openapi,
  jobs,
  resolveTenant,
}: WebAppOptions) {
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
    getJob: async ({ params, request }) => {
      const ctx = resolveTenant?.(request);
      if (ctx === undefined) throw new ApiError({ status: 401, code: 'unauthorized' });
      if (jobs === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
      const job = await jobs.get(ctx, params.id);
      // Another workspace's job looks exactly like a missing one (RLS hides it).
      if (job === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      const body: JobProgress = {
        id: job.id,
        type: job.type,
        state: job.state,
        attempt: job.attempt,
        percent: job.percent,
        result: job.result,
        error_code: job.errorCode,
        created_at: job.createdAt.toISOString(),
        updated_at: job.updatedAt.toISOString(),
      };
      return { status: 200, body };
    },
  };

  // A contract error rejects app.ready(), so the server never starts (invariant 4).
  // /healthz is polled every few seconds by Docker and the edge; only problems are logged.
  void app.register(
    contractRoutesPlugin(contractRoutes, handlers, { logLevels: { getHealth: 'warn' } }),
  );

  return app;
}
