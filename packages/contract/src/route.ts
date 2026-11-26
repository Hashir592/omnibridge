import { z } from 'zod';
import {
  ADMIN_ONLY_TABS,
  AUTH_KINDS,
  MODULE_TOGGLES,
  TABS,
  type RouteMetadata,
} from './metadata.ts';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A route in the contract: its HTTP shape plus its permission metadata. */
export interface RouteDefinition extends RouteMetadata {
  /** Unique camelCase id; becomes the OpenAPI operationId and the handler's key. */
  id: string;
  method: HttpMethod;
  /** Fastify-style path, e.g. `/orders/:orderId`. */
  path: string;
  summary?: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Success and expected non-problem responses by status code. Problems are added by the server. */
  responses: Readonly<Record<number, z.ZodType>>;
}

/** Any route, as the server and the route walker see it. */
export type AnyRoute = RouteDefinition;

const Shape = z.object({
  id: z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'must be a camelCase identifier'),
  method: z.enum(HTTP_METHODS),
  path: z.string().regex(/^\/[A-Za-z0-9_\-/:.]*$/, 'must be an absolute Fastify-style path'),
  auth: z.enum(AUTH_KINDS),
  tab: z.enum(TABS),
  adminOnly: z.boolean(),
  companyScoped: z.boolean(),
  module: z.enum(MODULE_TOGGLES).optional(),
});

const adminOnlyTabs: ReadonlySet<string> = new Set(ADMIN_ONLY_TABS);

function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? '');
}

/**
 * Everything wrong with a route's metadata, as readable lines. Empty means the route may be
 * registered. Checked at runtime because a route can reach the server without the type checker
 * (JavaScript, a cast, a bad merge).
 */
export function routeMetadataProblems(route: AnyRoute): string[] {
  const parsed = Shape.safeParse(route);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  }
  const { auth, tab, adminOnly, companyScoped, path } = parsed.data;
  const problems: string[] = [];
  if (adminOnlyTabs.has(tab) && !adminOnly) {
    problems.push(`adminOnly: tab "${tab}" is admin-only (PERM-4), so adminOnly must be true`);
  }
  if (
    (auth === 'public' || auth === 'pre-mfa' || auth === 'signed-in' || auth === 'any-session') &&
    (tab !== 'none' || companyScoped || adminOnly)
  ) {
    problems.push(
      `auth: a ${auth} route must have tab "none", adminOnly false, companyScoped false`,
    );
  }
  const declared = Object.keys(route.params?.shape ?? {});
  const inPath = pathParams(path);
  for (const name of inPath) {
    if (!declared.includes(name)) problems.push(`params: path parameter "${name}" has no schema`);
  }
  for (const name of declared) {
    if (!inPath.includes(name)) problems.push(`params: "${name}" is not in the path`);
  }
  if (Object.keys(route.responses).length === 0) problems.push('responses: none declared');
  if (path === '/api' || path.startsWith('/api/')) {
    problems.push('path: leave out /api; the server adds it (ADR-060)');
  }
  return problems;
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

/** Throws a ContractError naming the route and every problem. */
export function assertRouteMetadata(route: AnyRoute): void {
  const problems = routeMetadataProblems(route);
  if (problems.length > 0) {
    const name = typeof route.id === 'string' ? route.id : '(no id)';
    throw new ContractError(`Route ${name} is invalid: ${problems.join('; ')}`);
  }
}

/** Declares a contract route. Fails at import time if the metadata is incomplete. */
export function defineRoute<const T extends RouteDefinition>(route: T): T {
  assertRouteMetadata(route);
  return route;
}

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

/** What a handler receives: validated, typed request parts. */
export interface RouteInput<T extends AnyRoute> {
  params: Out<T['params']>;
  query: Out<T['query']>;
  body: Out<T['body']>;
}

/** What a handler returns: one of the route's declared statuses with its body. */
export type RouteResult<T extends AnyRoute> = {
  [S in keyof T['responses'] & number]: {
    status: S;
    body: z.output<T['responses'][S]>;
    /** Extra response headers, e.g. Set-Cookie or Cache-Control (T-0203). */
    headers?: Readonly<Record<string, string | readonly string[]>>;
  };
}[keyof T['responses'] & number];
