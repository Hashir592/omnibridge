import { Readable } from 'node:stream';
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import fastifySwagger from '@fastify/swagger';
import {
  ADMIN_ONLY_TABS,
  API_PREFIX,
  assertRouteMetadata,
  ContractError,
  FileDownloadSchema,
  OPENAPI_INFO,
  type FileDownload,
  isRootPath,
  mountedPath,
  PROBLEM_CONTENT_TYPE,
  ProblemSchema,
  type AnyRoute,
  type ModuleToggle,
  type Problem,
  type RouteInput,
  type RouteResult,
} from '@omnibridge/contract';
import {
  ApiError,
  type AccountActor,
  type ErrorCode,
  type MemberAccess,
  NotAMember,
  type PlatformActor,
  type SessionActor,
  type TenantContext,
  type TenantRunner,
} from '@omnibridge/core';
import { z } from 'zod';
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
  RawServerDefault,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { sendSpa, type SpaFiles } from './spa.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set only by registerRoutes; the onRoute guard refuses any route without it. */
    contract?: { routeId: string; validationStatus?: 400 | 422 };
  }
}

/** WEB-2: a signed website call's body as it arrived, the bytes its signature covers. */
const rawBodies = new WeakMap<FastifyRequest, Buffer>();
export function rawBodyOf(request: FastifyRequest): Buffer | undefined {
  return rawBodies.get(request);
}
/** A website's order may carry 500 lines (WEB-3); every other notice is small. */
const WEBSITE_BODY_LIMIT = 512 * 1024;

/**
 * What the route's `auth` kind adds to a handler's input (SEC-3): a session route gets the
 * signed-in user and a tenant context bound to the request's one transaction (invariant 3); a
 * platform route gets the operator, and opens tenant transactions itself for the workspace it
 * acts on.
 */
export type AuthInput<T extends AnyRoute> = T['auth'] extends 'session'
  ? { session: SessionActor; tenant: TenantContext; access: MemberAccess }
  : T['auth'] extends 'platform'
    ? { platform: PlatformActor }
    : T['auth'] extends 'pre-mfa' | 'signed-in' | 'any-session'
      ? { account: AccountActor }
      : unknown;

export type RouteHandler<T extends AnyRoute> = (
  input: RouteInput<T> & { request: FastifyRequest } & AuthInput<T>,
) => Promise<RouteResult<T>>;

/** Resolves the caller of one auth kind, or undefined (then 401). May throw an ApiError. */
export type Resolver<A> = (
  request: FastifyRequest,
  route: AnyRoute,
) => A | undefined | Promise<A | undefined>;

/** Who is calling, resolved before validation, so an anonymous caller learns nothing more. */
export interface AuthOptions {
  /** The signed-in user of a `session` route (T-0203). Without it, those routes answer 401. */
  resolveSession?: Resolver<SessionActor>;
  /** The operator of a `platform` route; without it, 401. */
  resolvePlatform?: Resolver<PlatformActor>;
  /** A `pre-mfa` caller: password checked, MFA not yet (ADR-048). */
  resolvePreMfa?: Resolver<AccountActor>;
  /** A `signed-in` caller: MFA done, no workspace needed (USR-2). */
  resolveSignedIn?: Resolver<AccountActor>;
  /** An `any-session` caller: a live session at any stage (ADR-062). */
  resolveAnySession?: Resolver<AccountActor>;
  /**
   * Runs first on every request to a state-changing route (SEC-1): the Origin check and the CSRF
   * token. Throws an ApiError to refuse.
   */
  checkRequest?: (request: FastifyRequest, route: AnyRoute) => void | Promise<void>;
  /**
   * The provider's signature check of a `signed-webhook` route, run once the body is parsed
   * (EBAY-2). Without it those routes answer 401; a false answer is 412.
   */
  verifyWebhook?: (request: FastifyRequest, route: AnyRoute) => Promise<boolean>;
  /**
   * ADR-059: whether a module of the caller's workspace is on, read in the request's transaction.
   * A session route that names a module answers 404 while it is off, and when this is missing.
   */
  moduleOn?: (tenant: TenantContext, module: ModuleToggle) => Promise<boolean>;
  /**
   * Opens the request's one tenant transaction (required with resolveSession). Session routes
   * run through runMember, so the member's role and ticks are checked in that transaction.
   */
  tenancy?: TenantRunner;
}

/** One handler per route id. A missing handler is a type error and a startup failure. */
export type Handlers<R extends readonly AnyRoute[]> = {
  [T in R[number] as T['id']]: RouteHandler<T>;
};

export interface RegisterOptions<R extends readonly AnyRoute[]> {
  /** Per-route log level, e.g. quiet health checks. Keys must be route ids. */
  logLevels?: Readonly<Partial<Record<R[number]['id'], 'warn' | 'error'>>>;
  auth?: AuthOptions;
}

type Actor =
  | { kind: 'public' }
  | { kind: 'session'; session: SessionActor }
  | { kind: 'platform'; platform: PlatformActor }
  | { kind: 'account'; account: AccountActor }
  | { kind: 'webhook' };

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A route the website calls, signed (WEB-2, WEB-3). */
const website = (route: AnyRoute) =>
  route.auth === 'signed-webhook' && route.module === 'website_connector';

/** May this member call this route? (PERM-3, PERM-4, PERM-5) */
export function allowed(route: AnyRoute, access: MemberAccess): boolean {
  if (access.role === 'admin') return true;
  if (route.adminOnly) return false;
  if ((ADMIN_ONLY_TABS as readonly string[]).includes(route.tab)) return false;
  return route.tab === 'none' || (access.tabs !== 'all' && access.tabs.includes(route.tab));
}
const WEBHOOK_BODY_LIMIT = 64 * 1024;

/** The caller of each request, set by the route's onRequest hook. */
const actors = new WeakMap<FastifyRequest, Actor>();

/**
 * Resolves the caller for the route's auth kind, or throws 401 (SEC-3). `service` and
 * `signed-webhook` have no check yet, so they fail closed until the module that needs them
 * builds one.
 */
async function authenticate(
  route: AnyRoute,
  request: FastifyRequest,
  auth: AuthOptions,
): Promise<Actor> {
  const unauthorized = () => new ApiError({ status: 401, code: 'unauthorized' });
  // A signed webhook comes from the provider's servers, not a browser: its signature, checked
  // once the body is parsed, stands in for the Origin check and CSRF token.
  if (!SAFE_METHODS.has(route.method) && route.auth !== 'signed-webhook') {
    await auth.checkRequest?.(request, route);
  }
  switch (route.auth) {
    case 'public':
      return { kind: 'public' };
    case 'session': {
      const session = await auth.resolveSession?.(request, route);
      if (session === undefined) throw unauthorized();
      return { kind: 'session', session };
    }
    case 'platform': {
      const platform = await auth.resolvePlatform?.(request, route);
      if (platform === undefined) throw unauthorized();
      return { kind: 'platform', platform };
    }
    case 'pre-mfa':
    case 'signed-in':
    case 'any-session': {
      const resolve =
        route.auth === 'pre-mfa'
          ? auth.resolvePreMfa
          : route.auth === 'signed-in'
            ? auth.resolveSignedIn
            : auth.resolveAnySession;
      const account = await resolve?.(request, route);
      if (account === undefined) throw unauthorized();
      return { kind: 'account', account };
    }
    case 'signed-webhook':
      if (auth.verifyWebhook === undefined) throw unauthorized();
      return { kind: 'webhook' };
    default:
      throw unauthorized();
  }
}

export interface InstallOptions {
  /** Collect the OpenAPI document (`app.swagger()`). Only the generator and tests need it. */
  openapi?: boolean;
  /** The built SPA (ADR-060); without it every unknown path answers the JSON 404. */
  spa?: SpaFiles;
}

/** The body of a file download in the OpenAPI document. */
const BinaryBody = z.string().meta({ format: 'binary', description: 'File bytes' });

/** Every route answers problems as RFC 9457 problem+json. */
const problemResponse = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema } },
});

/**
 * Fastify picks a response schema by exact status before `4xx`/`5xx`, so a declared error status
 * (e.g. /healthz 503) also accepts a problem body, chosen by content type.
 */
function responseSchemas(responses: AnyRoute['responses']) {
  const out: Record<string, unknown> = {
    '4xx': problemResponse('Client error (RFC 9457 problem)'),
    '5xx': problemResponse('Server error (RFC 9457 problem)'),
  };
  for (const [status, schema] of Object.entries(responses)) {
    if (schema === FileDownloadSchema) {
      out[status] = {
        description: 'File content',
        // Described for OpenAPI only: Fastify never serialises a stream payload.
        content: { 'application/octet-stream': { schema: BinaryBody } },
      };
      continue;
    }
    out[status] =
      Number(status) >= 400
        ? {
            description: 'Declared response, or an RFC 9457 problem',
            content: {
              'application/json': { schema },
              [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema },
            },
          }
        : schema;
  }
  return out;
}

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  503: 'service_unavailable',
};

const LOCATIONS = {
  body: 'body',
  params: 'params',
  querystring: 'query',
  headers: 'headers',
} as const;

/** Any Fastify app, whatever logger it was built with. */
type App<L extends FastifyBaseLogger> = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  L
>;

function sendProblem(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  extra: Pick<Problem, 'detail' | 'errors'> = {},
) {
  const body: Problem = {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    code,
    request_id: reply.request.id,
    ...extra,
  };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(body);
}

function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (hasZodFastifySchemaValidationErrors(error)) {
    const location = LOCATIONS[error.validationContext ?? 'body'];
    const errors = error.validation.map((issue) => ({
      location,
      path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
      message: issue.message ?? 'Invalid value',
    }));
    // WEB-3: a website's call answers 422 with the same field errors; every other route 400.
    const status = request.routeOptions.config.contract?.validationStatus ?? 400;
    return sendProblem(reply, status, 'validation_failed', { errors });
  }
  if (error instanceof ApiError) {
    if (error.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(error.retryAfterSeconds));
    }
    return sendProblem(reply, error.status, error.code, {
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.errors ? { errors: [...error.errors] } : {}),
    });
  }
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return sendProblem(reply, status, CODE_BY_STATUS[status] ?? 'bad_request');
  }
  // Anything else is our fault: log it, and tell the client nothing about it.
  request.log.error({ err: error }, 'unhandled error');
  return sendProblem(reply, 500, 'internal_error');
}

/**
 * Prepares a Fastify app for contract routes: Zod validation and serialisation, the OpenAPI
 * collector, problem+json errors, and a guard that refuses any route not registered through
 * `registerRoutes` (invariant 4, SEC-3). Call it before any route is added.
 */
export function installContract<L extends FastifyBaseLogger>(
  app: App<L>,
  { openapi = false, spa }: InstallOptions = {},
): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onRoute', (route) => {
    if (!route.config?.contract) {
      throw new ContractError(
        `Route ${String(route.method)} ${route.url} is not in the contract; ` +
          'add it to packages/contract and register it with registerRoutes',
      );
    }
  });
  if (openapi) {
    void app.register(fastifySwagger, {
      // Paths stay the route files' own; the server URL carries the /api prefix (ADR-060).
      openapi: { openapi: '3.1.0', info: { ...OPENAPI_INFO }, servers: [{ url: API_PREFIX }] },
      transform: jsonSchemaTransform,
      transformObject: jsonSchemaTransformObject,
    });
  }
  app.setErrorHandler(handleError);
  // Hardening 2 (S5-20261118, ADR-068): no API answer is ever cached, errors included. A route
  // that sets its own (file downloads: private, no-store) keeps it.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.startsWith(`${API_PREFIX}/`) && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });
  // Not a route, so the guard above still holds: a page path gets the SPA, anything else
  // (unknown /api/**, other methods) the JSON 404 envelope (ADR-060).
  app.setNotFoundHandler((request, reply) =>
    spa !== undefined && sendSpa(spa, request, reply)
      ? reply
      : sendProblem(reply, 404, 'not_found'),
  );
}

/**
 * A plugin that registers contract routes; a contract error rejects `app.ready()`, so the server
 * never starts. Register it after `installContract`.
 */
export function contractRoutesPlugin<const R extends readonly AnyRoute[]>(
  routes: R,
  handlers: Handlers<R>,
  options: RegisterOptions<R> = {},
): FastifyPluginCallback {
  return (scope, _opts, done) => {
    try {
      registerRoutes(scope, routes, handlers, options);
      done();
    } catch (error) {
      done(error as Error);
    }
  };
}

/**
 * Registers contract routes with their handlers. Throws (so the server never starts) when a route
 * lacks permission metadata, an id repeats, or a handler is missing. Prefer
 * `contractRoutesPlugin`, which also makes sure the OpenAPI collector sees every route.
 */
export function registerRoutes<const R extends readonly AnyRoute[], L extends FastifyBaseLogger>(
  app: App<L>,
  routes: R,
  handlers: Handlers<R>,
  { logLevels, auth = {} }: RegisterOptions<R> = {},
): void {
  const levels: Readonly<Record<string, 'warn' | 'error' | undefined>> = logLevels ?? {};
  const { tenancy } = auth;
  if (auth.resolveSession !== undefined && tenancy === undefined) {
    throw new ContractError('Session routes need a tenancy to open their tenant transaction');
  }
  const seen = new Set<string>();
  const byId = handlers as unknown as Readonly<Record<string, RouteHandler<AnyRoute> | undefined>>;
  for (const route of routes) {
    assertRouteMetadata(route);
    if (seen.has(route.id)) throw new ContractError(`Route id ${route.id} is used twice`);
    seen.add(route.id);
    const handler = byId[route.id];
    if (typeof handler !== 'function') {
      throw new ContractError(`Route ${route.id} has no handler`);
    }
    const level = levels[route.id];
    app.route({
      method: route.method,
      // Under /api, except the paths the PRD fixes (ADR-060).
      url: mountedPath(route.path),
      ...(level ? { logLevel: level } : {}),
      config: {
        contract: {
          routeId: route.id,
          ...(website(route) ? { validationStatus: 422 as const } : {}),
        },
      },
      schema: {
        operationId: route.id,
        // A route outside /api overrides the document's server URL.
        ...(isRootPath(route.path) ? { servers: [{ url: '/' }] } : {}),
        ...(route.summary ? { summary: route.summary } : {}),
        // Permission metadata in openapi.json, so client authors see it too.
        'x-permissions': {
          auth: route.auth,
          tab: route.tab,
          adminOnly: route.adminOnly,
          companyScoped: route.companyScoped,
          ...(route.module === undefined ? {} : { module: route.module }),
        },
        ...(route.params ? { params: route.params } : {}),
        ...(route.query ? { querystring: route.query } : {}),
        ...(route.body ? { body: route.body } : {}),
        response: responseSchemas(route.responses),
      },
      // Before validation: an anonymous caller gets 401, never a field-by-field 400.
      onRequest: async (request) => {
        actors.set(request, await authenticate(route, request, auth));
      },
      ...(route.auth === 'signed-webhook'
        ? {
            // A provider notice is small; anything bigger is refused before it is read.
            bodyLimit: website(route) ? WEBSITE_BODY_LIMIT : WEBHOOK_BODY_LIMIT,
            // WEB-2: the signature covers the bytes as sent, so they are kept before parsing.
            ...(website(route)
              ? {
                  preParsing: async (
                    request: FastifyRequest,
                    _reply: FastifyReply,
                    payload: Readable,
                  ) => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of payload) {
                      chunks.push(
                        typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer),
                      );
                    }
                    const raw = Buffer.concat(chunks);
                    rawBodies.set(request, raw);
                    return Readable.from([raw]);
                  },
                }
              : {}),
            preValidation: async (request: FastifyRequest) => {
              if (!(await auth.verifyWebhook?.(request, route))) {
                throw new ApiError({ status: 412, code: 'precondition_failed' });
              }
            },
          }
        : {}),
      handler: async (request, reply) => {
        const input = {
          params: route.params ? request.params : undefined,
          query: route.query ? request.query : undefined,
          body: route.body ? request.body : undefined,
          request,
        };
        // No actor means the auth hook did not run: refuse anything but a public route.
        const actor: Actor | undefined =
          actors.get(request) ?? (route.auth === 'public' ? { kind: 'public' } : undefined);
        if (actor === undefined) throw new ApiError({ status: 401, code: 'unauthorized' });
        const call = handler as (input: object) => Promise<RouteResult<AnyRoute>>;
        let result: RouteResult<AnyRoute>;
        if (actor.kind === 'session') {
          // One tenant transaction for the whole request (invariant 3), committed before the
          // response is sent; the handler's errors roll it back.
          if (tenancy === undefined) throw new ApiError({ status: 401, code: 'unauthorized' });
          const { session } = actor;
          try {
            result = await tenancy.runMember(
              { workspaceId: session.workspaceId, userId: session.userId },
              async (tenant, access) => {
                // Role and ticks come from the same transaction (PERM-3, PERM-5, AUD-4): an
                // admin-only route needs an admin, a tab route needs that tab ticked, and the
                // companies in scope are already only the permitted ones (invariant 4).
                if (!allowed(route, access)) throw new ApiError({ status: 403, code: 'forbidden' });
                if (
                  route.module !== undefined &&
                  (await auth.moduleOn?.(tenant, route.module)) !== true
                ) {
                  throw new ApiError({ status: 404, code: 'not_found' });
                }
                return call({ ...input, session, tenant, access });
              },
            );
          } catch (error) {
            // Removed from the workspace: refused on the very next request (USR-8).
            if (error instanceof NotAMember) {
              throw new ApiError({ status: 401, code: 'unauthorized' });
            }
            throw error;
          }
        } else if (actor.kind === 'platform') {
          result = await call({ ...input, platform: actor.platform });
        } else if (actor.kind === 'account') {
          result = await call({ ...input, account: actor.account });
        } else {
          result = await call(input);
        }
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          void reply.header(name, typeof value === 'string' ? value : [...value]);
        }
        if (route.responses[result.status] === FileDownloadSchema) {
          // A file stream (NFR-5): sent as is, never cached, never sniffed by the browser.
          const file = result.body as FileDownload;
          return reply
            .code(result.status)
            .header('content-type', file.contentType)
            .header('content-length', String(file.sizeBytes))
            .header('content-disposition', 'attachment')
            .header('cache-control', 'private, no-store')
            .header('x-content-type-options', 'nosniff')
            .send(file.stream);
        }
        return reply.code(result.status).send(result.body);
      },
    });
  }
}
