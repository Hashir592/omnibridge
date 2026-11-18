import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  contractRoutes,
  type AuditEvent as AuditEventBody,
  type AuditFilters,
  type Company,
  type Health,
  type JobProgress,
} from '@omnibridge/contract';
import {
  ApiError,
  type PlatformActor,
  type SessionActor,
  type TenantContext,
  type TenantRunner,
} from '@omnibridge/core';
import {
  isAuditCursor,
  type AuditCursor,
  type AuditFilter,
  type AuditLog,
  type CompanyRepository,
  type WorkspaceRepository,
  type ChannelAccountRepository,
  type DeletionLog,
} from '@omnibridge/db';
import { FileNotReadable, verifyFileLink, type FileStore } from '@omnibridge/files';
import type { Logger } from '@omnibridge/logger';
import fastifyHelmet from '@fastify/helmet';
import Fastify, { type FastifyRequest } from 'fastify';
import { AUDIT_CSV_HEADER, auditCsvRows } from './audit-csv.ts';
import { deletionCertificateText } from './deletion-certificate.ts';
import { authHandlers } from './auth/routes.ts';
import { ebayHandlers, webhookVerifier, type EbayWebhook } from './webhooks/ebay.ts';
import { peopleHandlers, type PeopleOptions } from './users.ts';
import { privacyHandlers, type PrivacyOptions } from './privacy.ts';
import type { AuthService } from './auth/service.ts';
import { contractRoutesPlugin, installContract, type Handlers } from './contract.ts';
import type { SpaFiles } from './spa.ts';

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

/**
 * The most one audit export may hold (AUD-4); more is a 400 asking for a narrower range. It is
 * read and written page by page, so the bytes cap is what bounds memory (web heap 288 MB).
 */
export const AUDIT_EXPORT_LIMITS = { rows: 100_000, bytes: 16 * 1024 * 1024 } as const;
const AUDIT_EXPORT_PAGE = 1_000;

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
  /** The audit log (AUD-1, AUD-4). */
  audit?: Pick<AuditLog, 'record' | 'list'>;
  /** Deletion certificates (DEL-3, T-0403): the run log and the workspace's channel accounts. */
  deletion?: {
    log: Pick<DeletionLog, 'certificate'>;
    accounts: Pick<ChannelAccountRepository, 'list'>;
  };
  /** Overrides AUDIT_EXPORT_LIMITS; tests only. */
  auditExportLimits?: { rows: number; bytes: number };
  /**
   * Sign-in, MFA and sessions (T-0203). It resolves every auth kind and runs the Origin and CSRF
   * check (SEC-1); it replaces resolveSession and resolvePlatform when given.
   */
  auth?: AuthService;
  /** Tests only: a stand-in session resolver (packages/testkit stubAuth). */
  resolveSession?: (request: FastifyRequest) => SessionActor | undefined;
  /** Tests only: a stand-in platform resolver. */
  resolvePlatform?: (request: FastifyRequest) => PlatformActor | undefined;
  /**
   * The eBay account deletion endpoint (EBAY-2). Without it the challenge answers 503 and a
   * notice 401: nothing is accepted unverified.
   */
  ebay?: EbayWebhook;
  /** Users, invites and the access review (T-0204). Without it those routes answer 503. */
  people?: PeopleOptions;
  /** Erasure and subject access requests (T-0404). Without it those routes answer 503. */
  privacy?: PrivacyOptions;
  /** Collect the OpenAPI document; set by the contract generator and tests only. */
  openapi?: boolean;
  /** The built SPA, served for every page path (ADR-060). */
  spa?: SpaFiles;
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
  spa,
  jobs,
  files,
  tenancy,
  directory,
  audit,
  auditExportLimits,
  deletion,
  auth,
  resolveSession,
  resolvePlatform,
  ebay,
  people,
  privacy,
}: WebAppOptions) {
  const app = Fastify({ loggerInstance: logger, trustProxy: trustedProxies ?? false });
  installContract(app, { openapi: openapi ?? false, ...(spa === undefined ? {} : { spa }) });
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

  function needAudit(): NonNullable<WebAppOptions['audit']> {
    if (audit === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
    return audit;
  }

  // The last /healthz answer, so a degraded state is logged when it starts, not on every poll.
  let lastHealthy = true;
  const handlers: Handlers<typeof contractRoutes> = {
    ...authHandlers(auth),
    ...ebayHandlers(ebay),
    ...peopleHandlers(people, auth),
    ...privacyHandlers(privacy),
    getHealth: async () => {
      const [dbMain, dbPii] = await Promise.all([check(checks.dbMain), check(checks.dbPii)]);
      const healthy = dbMain === 'ok' && dbPii === 'ok';
      const body: Health = {
        status: healthy ? 'ok' : 'degraded',
        db_main: dbMain,
        db_pii: dbPii,
        version,
      };
      const changed = healthy !== lastHealthy;
      lastHealthy = healthy;
      if (healthy || !changed) return healthy ? { status: 200, body } : { status: 503, body };
      // R2-01: say which dependency failed, once per change (healthz is polled every few
      // seconds). Names only: no error text, host or credential.
      const failing = Object.entries({ db_main: dbMain, db_pii: dbPii })
        .filter(([, state]) => state !== 'ok')
        .map(([name]) => name);
      logger.warn(
        { event: 'health.degraded', statusCode: 503, db_main: dbMain, db_pii: dbPii },
        `healthz 503: ${failing.join(', ')} failing`,
      );
      return { status: 503, body };
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
    listAuditEvents: async ({ query, tenant }) => {
      const page = await needAudit().list(tenant, auditFilter(query), {
        limit: query.limit,
        after: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      });
      return {
        status: 200,
        body: {
          items: page.items.map(auditBody),
          next_cursor: page.next === null ? null : encodeCursor(page.next),
        },
      };
    },
    getDeletionCertificate: async ({ params, tenant }) => {
      if (deletion === undefined) throw new ApiError({ status: 503, code: 'service_unavailable' });
      const accounts = await deletion.accounts.list(tenant);
      const account = accounts.find((a) => a.id === params.id);
      if (account === undefined) throw new ApiError({ status: 404, code: 'not_found' });
      const cert = await deletion.log.certificate(tenant, account.id);
      const text = Buffer.from(deletionCertificateText(cert, account.provider), 'utf8');
      return {
        status: 200,
        body: {
          stream: Readable.from([text]),
          contentType: 'text/plain; charset=utf-8',
          sizeBytes: text.length,
        },
      };
    },
    exportAuditEvents: async ({ query, session, tenant, request }) => {
      const log = needAudit();
      const limits = auditExportLimits ?? AUDIT_EXPORT_LIMITS;
      const filter = auditFilter(query);
      // Page by page inside the request's transaction, so only one page of rows is held at once.
      const header = Buffer.from(AUDIT_CSV_HEADER, 'utf8');
      const chunks = [header];
      let bytes = header.length;
      let rows = 0;
      let after: AuditCursor | undefined;
      do {
        const page = await log.list(tenant, filter, { limit: AUDIT_EXPORT_PAGE, after });
        const chunk = Buffer.from(auditCsvRows(page.items), 'utf8');
        rows += page.items.length;
        bytes += chunk.length;
        if (rows > limits.rows || bytes > limits.bytes) {
          // The filters ask for too much: a validation problem the caller fixes (ADR-049).
          throw new ApiError({
            status: 400,
            code: 'validation_failed',
            detail: 'Too many audit events match for one export. Narrow the date range.',
            errors: [{ location: 'query', path: 'from', message: 'Narrow the date range' }],
          });
        }
        chunks.push(chunk);
        after = page.next ?? undefined;
      } while (after !== undefined);
      // The export is itself audited (AUD-4), in the same transaction as the read.
      await log.record(tenant, {
        action: 'audit_log.exported',
        actor: { kind: 'user', userId: session.userId },
        after: { ...query, row_count: rows },
        ip: request.ip,
      });
      return {
        status: 200,
        body: {
          stream: Readable.from(chunks),
          contentType: 'text/csv; charset=utf-8',
          sizeBytes: bytes,
        },
      };
    },
  };

  // A contract error rejects app.ready(), so the server never starts (invariant 4).
  // /healthz is polled every few seconds by Docker and the edge; only problems are logged.
  void app.register(
    contractRoutesPlugin(contractRoutes, handlers, {
      logLevels: { getHealth: 'warn' },
      auth: {
        ...(auth === undefined
          ? {
              ...(resolveSession === undefined ? {} : { resolveSession }),
              ...(resolvePlatform === undefined ? {} : { resolvePlatform }),
            }
          : {
              resolveSession: auth.resolveSession,
              resolvePlatform: auth.resolvePlatform,
              resolvePreMfa: auth.resolvePreMfa,
              resolveSignedIn: auth.resolveSignedIn,
              resolveAnySession: auth.resolveAnySession,
              checkRequest: auth.checkRequest,
            }),
        ...(tenancy === undefined ? {} : { tenancy }),
        ...(ebay === undefined ? {} : { verifyWebhook: webhookVerifier(ebay) }),
      },
    }),
  );

  return app;
}

/** Contract filters → repository filters; times are parsed to instants. */
function auditFilter(query: AuditFilters): AuditFilter {
  return {
    ...(query.user_id === undefined ? {} : { userId: query.user_id }),
    ...(query.action === undefined ? {} : { action: query.action }),
    ...(query.entity_type === undefined ? {} : { entityType: query.entity_type }),
    ...(query.entity_id === undefined ? {} : { entityId: query.entity_id }),
    ...(query.from === undefined ? {} : { from: new Date(query.from) }),
    ...(query.to === undefined ? {} : { to: new Date(query.to) }),
  };
}

function auditBody(e: Awaited<ReturnType<AuditLog['list']>>['items'][number]): AuditEventBody {
  return {
    id: e.id,
    occurred_at: e.occurredAt.toISOString(),
    actor_kind: e.actorKind,
    user_id: e.userId,
    user_name: e.userName,
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId,
    before: e.before,
    after: e.after,
    reason: e.reason,
    ip: e.ip,
  };
}

/** The list cursor is opaque to clients: the last event's time and id, base64url-encoded. */
function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(text: string): AuditCursor {
  const [at = '', id = '', ...rest] = Buffer.from(text, 'base64url').toString('utf8').split('|');
  const cursor = { at, id };
  if (rest.length > 0 || !isAuditCursor(cursor)) {
    throw new ApiError({ status: 400, code: 'bad_request', detail: 'The cursor is not valid' });
  }
  return cursor;
}
