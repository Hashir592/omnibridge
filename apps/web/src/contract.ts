import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import fastifySwagger from '@fastify/swagger';
import {
  assertRouteMetadata,
  ContractError,
  OPENAPI_INFO,
  PROBLEM_CONTENT_TYPE,
  ProblemSchema,
  type AnyRoute,
  type Problem,
  type RouteInput,
  type RouteResult,
} from '@omnibridge/contract';
import { ApiError, type ErrorCode } from '@omnibridge/core';
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

export type RouteHandler<T extends AnyRoute> = (
  input: RouteInput<T> & { request: FastifyRequest },
) => Promise<RouteResult<T>>;

/** One handler per route id. A missing handler is a type error and a startup failure. */
export type Handlers<R extends readonly AnyRoute[]> = {
  [T in R[number] as T['id']]: RouteHandler<T>;
};

export interface RegisterOptions<R extends readonly AnyRoute[]> {
  /** Per-route log level, e.g. quiet health checks. Keys must be route ids. */
  logLevels?: Readonly<Partial<Record<R[number]['id'], 'warn' | 'error'>>>;
}

export interface InstallOptions {
  /** Collect the OpenAPI document (`app.swagger()`). Only the generator and tests need it. */
  openapi?: boolean;
}

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
  { logLevels }: RegisterOptions<R> = {},
): void {
  const levels: Readonly<Record<string, 'warn' | 'error' | undefined>> = logLevels ?? {};
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
      handler: async (request, reply) => {
        const result = await handler({
          params: route.params ? request.params : undefined,
          query: route.query ? request.query : undefined,
          body: route.body ? request.body : undefined,
          request,
        } as RouteInput<AnyRoute> & { request: FastifyRequest });
        return reply.code(result.status).send(result.body);
      },
    });
  }
}
