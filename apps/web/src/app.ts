import { randomUUID } from 'node:crypto';
import { contractRoutes, type Company, type Health, type JobProgress } from '@omnibridge/contract';
import {
  ApiError,
  type PlatformActor,
  type SessionActor,
  type TenantContext,
  type TenantRunner,
} from '@omnibridge/core';
import type { CompanyRepository, WorkspaceRepository } from '@omnibridge/db';
import { FileNotReadable, verifyFileLink, type FileStore } from '@omnibridge/files';
import type { Logger } from '@omnibridge/logger';
import fastifyHelmet from '@fastify/helmet';
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

/** Workspaces and companies, for the platform routes and the company switcher (TEN-2, TEN-5). */
export interface TenantDirectory {
  workspaces: Pick<WorkspaceRepository, 'create' | 'get'>;
  companies: Pick<CompanyRepository, 'create' | 'list'>;
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
  /** Encrypted files and the file-link HMAC key, for GET /files/:id (NFR-5). */
  files?: { store: FileStore; linkKey: Buffer };
  /** Opens each request's one tenant transaction (TEN-1, invariant 3). */
  tenancy?: TenantRunner;
  directory?: TenantDirectory;
  /**
   * The signed-in user of `session` routes. Sessions arrive in T-0203; until then production
   * passes nothing, so every session route answers 401 and none is open.
   */
  resolveSession?: (request: FastifyRequest) => SessionActor | undefined;
  /** The operator of `platform` routes; nothing in production until T-0203, so 401. */
  resolvePlatform?: (request: FastifyRequest) => PlatformActor | undefined;
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
  files,
  tenancy,
  directory,
  resolveSession,
  resolvePlatform,
}: WebAppOptions) {
  const app = Fastify({ loggerInstance: logger, trustProxy: trustedProxies ?? false });
  installContract(app, { openapi: openapi ?? false });
  // Baseline security headers on every response, errors included (SEC-2). Strict CSP: only our
  // own origin, no inline script or style, no eval, and the app can never be framed.
  void app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
  });

  function needTenancy(): TenantRunner {
    if (tenancy === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
    return tenancy;
  }

  function needDirectory(): TenantDirectory {
    if (directory === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
    return directory;
  }

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
    getJob: async ({ params, tenant }) => {
      if (jobs === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
      const job = await jobs.get(tenant, params.id);
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
    getFile: async ({ params, query, session, tenant }) => {
      if (files === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
      const verdict = verifyFileLink(
        { fileId: params.id, sessionId: session.sessionId, exp: query.exp, sig: query.sig },
        files.linkKey,
      );
      if (verdict !== 'ok') {
        throw new ApiError({
          status: 403,
          code: 'forbidden',
          detail: `The download link is ${verdict}`,
        });
      }
      try {
        const file = await files.store.get(tenant, params.id);
        return {
          status: 200,
          body: {
            stream: file.stream,
            contentType: file.meta.contentType,
            sizeBytes: file.meta.sizeBytes,
          },
        };
      } catch (err) {
        // Missing, another workspace's, or not clean: all look the same from outside.
        if (err instanceof FileNotReadable) throw new ApiError({ status: 404, code: 'not_found' });
        throw err;
      }
    },
    listCompanies: async ({ tenant }) => {
      // RLS returns only the companies in the context's explicit list (invariant 4).
      const items: Company[] = (await needDirectory().companies.list(tenant)).map((c) => ({
        id: c.id,
        legal_name: c.legalName,
        trading_name: c.tradingName,
        company_number: c.companyNumber,
        vat_number: c.vatNumber,
        vat_period: c.vatPeriod,
        is_fulfilment_provider: c.isFulfilmentProvider,
        is_purchasing_company: c.isPurchasingCompany,
        badge_colour: c.badgeColour,
      }));
      return { status: 200, body: { items } };
    },
    createWorkspace: async ({ body, platform }) => {
      const { workspaces } = needDirectory();
      const id = randomUUID();
      // The new workspace's own tenant transaction: RLS lets it insert this id and no other.
      await needTenancy().run({ workspaceId: id, companyIds: [] }, (ctx) =>
        workspaces.create(ctx, {
          name: body.name,
          maxChannelAccounts: body.max_channel_accounts ?? null,
          maxUsers: body.max_users ?? null,
        }),
      );
      logger.info(
        { event: 'workspace.created', workspaceId: id, userId: platform.userId },
        'workspace created',
      );
      return { status: 201, body: { id } };
    },
    createCompany: async ({ params, body, platform }) => {
      const { workspaces, companies } = needDirectory();
      const address = body.registered_address;
      const id = await needTenancy().runWorkspace(
        { workspaceId: params.workspaceId },
        async (ctx) => {
          // An unknown workspace, and one this transaction cannot see, both look missing.
          if ((await workspaces.get(ctx)) === undefined) return undefined;
          return companies.create(ctx, {
            legalName: body.legal_name,
            tradingName: body.trading_name,
            companyNumber: body.company_number ?? null,
            vatNumber: body.vat_number ?? null,
            registeredAddress: {
              line1: address.line1,
              city: address.city,
              postcode: address.postcode,
              ...(address.line2 === undefined ? {} : { line2: address.line2 }),
              ...(address.country === undefined ? {} : { country: address.country }),
            },
            ...(body.vat_period === undefined ? {} : { vatPeriod: body.vat_period }),
            ...(body.is_fulfilment_provider === undefined
              ? {}
              : { isFulfilmentProvider: body.is_fulfilment_provider }),
            ...(body.is_purchasing_company === undefined
              ? {}
              : { isPurchasingCompany: body.is_purchasing_company }),
            ...(body.badge_colour === undefined ? {} : { badgeColour: body.badge_colour }),
          });
        },
      );
      if (id === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      logger.info(
        {
          event: 'company.created',
          workspaceId: params.workspaceId,
          companyId: id,
          userId: platform.userId,
        },
        'company created',
      );
      return { status: 201, body: { id } };
    },
  };

  // A contract error rejects app.ready(), so the server never starts (invariant 4).
  // /healthz is polled every few seconds by Docker and the edge; only problems are logged.
  void app.register(
    contractRoutesPlugin(contractRoutes, handlers, {
      logLevels: { getHealth: 'warn' },
      auth: {
        ...(resolveSession === undefined ? {} : { resolveSession }),
        ...(resolvePlatform === undefined ? {} : { resolvePlatform }),
        ...(tenancy === undefined ? {} : { tenancy }),
      },
    }),
  );

  return app;
}
