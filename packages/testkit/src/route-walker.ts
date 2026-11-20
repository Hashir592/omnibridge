import {
  mountedPath,
  routeMetadataProblems,
  type AnyRoute,
  type RouteMetadata,
} from '@omnibridge/contract';

/**
 * Route walker (ARCHITECTURE.md §5 invariant 4, ADR-006, AT-1).
 *
 * `walkRoutes` enumerates the registry and checks every route's permission metadata.
 * `walkIsolation` calls every route as an anonymous caller and as a user of workspace A aimed at
 * workspace B's data, and checks that nothing of B comes back. The child user with no ticked tabs
 * (AT-2) joins with T-0204.
 */
export interface WalkedRoute extends RouteMetadata {
  id: string;
  method: AnyRoute['method'];
  path: string;
  /** How the route pages a list (ADR-040), so the walker can walk every page shape. */
  pagination: 'page' | 'cursor' | 'none';
}

function paginationOf(route: AnyRoute): WalkedRoute['pagination'] {
  const keys = Object.keys(route.query?.shape ?? {});
  if (keys.includes('page')) return 'page';
  if (keys.includes('cursor')) return 'cursor';
  return 'none';
}

/** Returns every route with its metadata, or throws listing every route that lacks it. */
export function walkRoutes(routes: readonly AnyRoute[]): WalkedRoute[] {
  const failures = routes
    .map((route) => ({ route, problems: routeMetadataProblems(route) }))
    .filter(({ problems }) => problems.length > 0)
    .map(({ route, problems }) => `${route.id}: ${problems.join('; ')}`);
  if (failures.length > 0) {
    throw new Error(`Routes without valid permission metadata:\n${failures.join('\n')}`);
  }
  return routes.map((route) => ({
    id: route.id,
    method: route.method,
    path: route.path,
    auth: route.auth,
    tab: route.tab,
    adminOnly: route.adminOnly,
    companyScoped: route.companyScoped,
    pagination: paginationOf(route),
  }));
}

/** One call of a route: path parameters, query and body, all pointing at workspace B. */
export interface WalkCall {
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | number>>;
  body?: unknown;
  /**
   * The body is search text the caller typed (a buyer's identifiers, T-0404), not an id of B's,
   * so it cannot aim at B: any status is allowed and the leak check still runs on the answer.
   */
  searchText?: true;
}

export interface InjectRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload?: unknown;
}

export interface IsolationWalk {
  routes: readonly AnyRoute[];
  /** Sends one request to the app under test (Fastify `inject`). */
  inject: (request: InjectRequest) => Promise<{ statusCode: number; body: string }>;
  /** Headers of a caller with no session. */
  anonymous: Record<string, string>;
  /** Headers of a signed-in user of workspace A. */
  workspaceA: Record<string, string>;
  /**
   * For every route id, a call aimed at workspace B's rows. A route with no entry fails the walk,
   * so a new route is walked from the day it is added.
   */
  againstB: Readonly<Record<string, WalkCall>>;
  /** Values of workspace B (ids, marker names) that must never appear in an answer. */
  markers: readonly string[];
}

export interface WalkOutcome {
  route: string;
  caller: 'anonymous' | 'workspace-a';
  status: number;
  expected: string;
  leaked: string[];
  ok: boolean;
}

/** The URL the server answers on: under /api unless the PRD fixes the path (ADR-060). */
function urlOf(route: AnyRoute, call: WalkCall): string {
  const path = mountedPath(route.path).replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = call.params?.[name];
    if (value === undefined) throw new Error(`${route.id}: no value for path parameter ${name}`);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams(
    Object.entries(call.query ?? {}).map(([key, value]): [string, string] => [key, String(value)]),
  ).toString();
  return query === '' ? path : `${path}?${query}`;
}

/**
 * What a status must be. Anonymous: 401 on every route that is not public. Workspace A: 401 or
 * 403 on platform and internal routes; 403 or 404 on a session route given anything of B's (path,
 * query or body); any status only where the call carries nothing (a plain list), because the leak
 * check covers it. A public route may answer anything; its body is still checked for leaks.
 */
function expectedFor(route: AnyRoute, caller: WalkOutcome['caller'], call: WalkCall): number[] {
  if (route.auth === 'public') return [];
  if (caller === 'anonymous') return [401];
  if (route.auth !== 'session') return [401, 403];
  const aimed =
    Object.keys(call.params ?? {}).length > 0 ||
    Object.keys(call.query ?? {}).length > 0 ||
    (call.body !== undefined && call.searchText !== true);
  return aimed ? [403, 404] : [];
}

/** Calls every route as anonymous and as workspace A against B; returns one outcome per call. */
export async function walkIsolation(walk: IsolationWalk): Promise<WalkOutcome[]> {
  walkRoutes(walk.routes);
  const missing = walk.routes.filter((route) => walk.againstB[route.id] === undefined);
  if (missing.length > 0) {
    throw new Error(`Routes with no walker call: ${missing.map((r) => r.id).join(', ')}`);
  }
  const outcomes: WalkOutcome[] = [];
  for (const route of walk.routes) {
    const call = walk.againstB[route.id] ?? {};
    for (const caller of ['anonymous', 'workspace-a'] as const) {
      const res = await walk.inject({
        method: route.method,
        url: urlOf(route, call),
        headers: caller === 'anonymous' ? walk.anonymous : walk.workspaceA,
        ...(call.body === undefined ? {} : { payload: call.body }),
      });
      const allowed = expectedFor(route, caller, call);
      const leaked = walk.markers.filter((marker) => res.body.includes(marker));
      outcomes.push({
        route: route.id,
        caller,
        status: res.statusCode,
        expected: allowed.length === 0 ? 'any' : allowed.join('|'),
        leaked,
        ok: leaked.length === 0 && (allowed.length === 0 || allowed.includes(res.statusCode)),
      });
    }
  }
  return outcomes;
}

export interface PlatformWalk {
  routes: readonly AnyRoute[];
  inject: IsolationWalk['inject'];
  /** Headers of a signed-in platform admin in the console. */
  platform: Record<string, string>;
  /** The same calls as the isolation walk: each platform route aimed at workspace B. */
  calls: Readonly<Record<string, WalkCall>>;
  /**
   * Workspace B's business data (company names, users, orders, customers, finance, messages):
   * never in a console answer. Workspace names and ids may appear; the console lists workspaces.
   */
  businessMarkers: readonly string[];
  /**
   * A route whose walked call is meant to answer something other than a 2xx (a refused archive
   * is 409, a missing job 404): its declared statuses. Every other route must answer a 2xx, so a
   * route refused by mistake (a gate or CSRF change) fails the walk instead of passing it.
   */
  expected?: Readonly<Record<string, readonly number[]>>;
}

export interface PlatformOutcome {
  route: string;
  status: number;
  /** `2xx`, or the declared statuses joined with `|`. */
  expected: string;
  leaked: string[];
  ok: boolean;
}

/**
 * PLAT-3: calls every platform route as a platform admin, aimed at workspace B, and checks that
 * no answer holds B's business data. Each route must answer a 2xx, or one of the statuses
 * declared for it in `expected` (ADR-076), so the walk proves the console really answered.
 */
export async function walkPlatform(walk: PlatformWalk): Promise<PlatformOutcome[]> {
  const routes = walk.routes.filter((route) => route.auth === 'platform');
  const missing = routes.filter((route) => walk.calls[route.id] === undefined);
  if (missing.length > 0) {
    throw new Error(`Platform routes with no walker call: ${missing.map((r) => r.id).join(', ')}`);
  }
  const outcomes: PlatformOutcome[] = [];
  for (const route of routes) {
    const call = walk.calls[route.id] ?? {};
    const res = await walk.inject({
      method: route.method,
      url: urlOf(route, call),
      headers: walk.platform,
      ...(call.body === undefined ? {} : { payload: call.body }),
    });
    const leaked = walk.businessMarkers.filter((marker) => res.body.includes(marker));
    const declared = walk.expected?.[route.id];
    const statusOk =
      declared === undefined
        ? res.statusCode >= 200 && res.statusCode < 300
        : declared.includes(res.statusCode);
    outcomes.push({
      route: route.id,
      status: res.statusCode,
      expected: declared === undefined ? '2xx' : declared.join('|'),
      leaked,
      ok: leaked.length === 0 && statusOk,
    });
  }
  return outcomes;
}
