import { routeMetadataProblems, type AnyRoute, type RouteMetadata } from '@omnibridge/contract';

/**
 * Route walker (ARCHITECTURE.md §5 invariant 4, ADR-006).
 *
 * T-0102 stub: enumerates the registry and checks every route's permission metadata.
 * T-0201 adds the calls: every route as workspace A against workspace B's data, and as a child
 * user with no ticked tabs (AT-1, AT-2).
 */
export interface WalkedRoute extends RouteMetadata {
  id: string;
  method: AnyRoute['method'];
  path: string;
  /** How the route pages a list (ADR-040), so T-0201 can walk every page shape. */
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
