/**
 * Where contract routes are served (ADR-060). Every route is served under API_PREFIX, so the SPA
 * owns every other path, except the few the PRD fixes for outside callers: Docker and the edge
 * (/healthz), provider webhooks (/webhooks/**, EBAY-2) and OAuth redirects
 * (/connect/<channel>/callback and /declined). Route files keep their own paths; this is the one place
 * the prefix is applied.
 *
 * Browser-safe: no imports, used by the server, the typed client and the route walker.
 */
export const API_PREFIX = '/api';

const CONNECT_RETURN = /^\/connect\/.+\/(?:callback|declined)$/;

/** True for a route path the PRD fixes outside /api. */
export function isRootPath(path: string): boolean {
  return path === '/healthz' || path.startsWith('/webhooks/') || CONNECT_RETURN.test(path);
}

/** The URL path a route is served at: its own path, under /api unless the PRD fixes it. */
export function mountedPath(path: string): string {
  return isRootPath(path) ? path : `${API_PREFIX}${path}`;
}
