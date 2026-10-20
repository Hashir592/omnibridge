import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import fastifySwagger from '@fastify/swagger';
import {
  assertRouteMetadata,
  ContractError,
  FileDownloadSchema,
  OPENAPI_INFO,
  type FileDownload,
  PROBLEM_CONTENT_TYPE,
  ProblemSchema,
  type AnyRoute,
  type Problem,
  type RouteInput,
  type RouteResult,
} from '@omnibridge/contract';
import {
  ApiError,
  type ErrorCode,
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

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set only by registerRoutes; the onRoute guard refuses any route without it. */
    contract?: { routeId: string };
  }
}

/**
 * What the route's `auth` kind adds to a handler's input (SEC-3): a session route gets the
 * signed-in user and a tenant context bound to the request's one transaction (invariant 3); a
 * platform route gets the operator, and opens tenant transactions itself for the workspace it
 * acts on.
 */
export type AuthInput<T extends AnyRoute> = T['auth'] extends 'session'
  ? { session: SessionActor; tenant: TenantContext }
  : T['auth'] extends 'platform'
    ? { platform: PlatformActor }
    : unknown;

export type RouteHandler<T extends AnyRoute> = (
  input: RouteInput<T> & { request: FastifyRequest } & AuthInput<T>,
) => Promise<RouteResult<T>>;

/** Who is calling, resolved before validation, so an anonymous caller learns nothing more. */
export interface AuthOptions {
  /**
   * The signed-in user of a `session` route. Until T-0203 production passes none, so every
   * session route answers 401: closed, never open.
   */
  resolveSession?: (request: FastifyRequest) => SessionActor | undefined;
  /** The operator of a `platform` route; none in production until T-0203, so 401. */
  resolvePlatform?: (request: FastifyRequest) => PlatformActor | undefined;
  /** Opens the request's one tenant transaction (required with resolveSession). */
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
  | { kind: 'platform'; platform: PlatformActor };

/** The caller of each request, set by the route's onRequest hook. */
const actors = new WeakMap<FastifyRequest, Actor>();

/**
 * Resolves the caller for the route's auth kind, or throws 401 (SEC-3). `service` and
 * `signed-webhook` have no check yet, so they fail closed until the module that needs them
 * builds one.
 */
function authenticate(route: AnyRoute, request: FastifyRequest, auth: AuthOptions): Actor {
  const unauthorized = () => new ApiError({ status: 401, code: 'unauthorized' });
  switch (route.auth) {
    case 'public':
      return { kind: 'public' };
    case 'session': {
      const session = auth.resolveSession?.(request);
      if (session === undefined) throw unauthorized();
      return { kind: 'session', session };
    }
    case 'platform': {
      const platform = auth.resolvePlatform?.(request);
      if (platform === undefined) throw unauthorized();
      return { kind: 'platform', platform };
    }
    default:
      throw unauthorized();
  }
}

export interface InstallOptions {
  /** Collect the OpenAPI document (`app.swagger()`). Only the generator and tests need it. */
  openapi?: boolean;
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
    return sendProblem(reply, 400, 'validation_failed', { errors });
  }
  if (error instanceof ApiError) {
    return sendProblem(
      reply,
      error.status,
      error.code,
      error.detail ? { detail: error.detail } : {},
    );
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
  { openapi = false }: InstallOptions = {},
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
      openapi: { openapi: '3.1.0', info: { ...OPENAPI_INFO } },
      transform: jsonSchemaTransform,
      transformObject: jsonSchemaTransformObject,
    });
  }
  app.setErrorHandler(handleError);
  app.setNotFoundHandler((_request, reply) => sendProblem(reply, 404, 'not_found'));
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
      url: route.path,
      ...(level ? { logLevel: level } : {}),
      config: { contract: { routeId: route.id } },
      schema: {
        operationId: route.id,
        ...(route.summary ? { summary: route.summary } : {}),
        // Permission metadata in openapi.json, so client authors see it too.
        'x-permissions': {
          auth: route.auth,
          tab: route.tab,
          adminOnly: route.adminOnly,
          companyScoped: route.companyScoped,
        },
        ...(route.params ? { params: route.params } : {}),
        ...(route.query ? { querystring: route.query } : {}),
        ...(route.body ? { body: route.body } : {}),
        response: responseSchemas(route.responses),
      },
      // Before validation: an anonymous caller gets 401, never a field-by-field 400.
      onRequest: (request, _reply, done) => {
        try {
          actors.set(request, authenticate(route, request, auth));
          done();
        } catch (err) {
          done(err as Error);
        }
      },
      handler: async (request, reply) => {
        const input = {
          params: route.params ? request.params : undefined,
          query: route.query ? request.query : undefined,
          body: route.body ? request.body : undefined,
          request,
        };
        const actor = actors.get(request) ?? { kind: 'public' };
        const call = handler as (input: object) => Promise<RouteResult<AnyRoute>>;
        let result: RouteResult<AnyRoute>;
        if (actor.kind === 'session') {
          // One tenant transaction for the whole request (invariant 3), committed before the
          // response is sent; the handler's errors roll it back.
          if (tenancy === undefined) throw new ApiError({ status: 401, code: 'unauthorized' });
          const { session } = actor;
          result = await tenancy.runWorkspace(
            { workspaceId: session.workspaceId, userId: session.userId },
            (tenant) => call({ ...input, session, tenant }),
          );
        } else if (actor.kind === 'platform') {
          result = await call({ ...input, platform: actor.platform });
        } else {
          result = await call(input);
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
