/**
 * Typed API client for apps/ui (ADR-004). Types come from `schema.ts`, which `pnpm contract:gen`
 * generates from openapi.json, so a server change that is not regenerated fails the gate.
 *
 * Browser-safe: no Zod, no server code, no Node built-ins.
 *
 *   const api = createApiClient();
 *   const { data, error } = await api.GET('/users');   // sends GET /api/users
 */
import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import { API_PREFIX, isRootPath } from '../mount.ts';
import type { components, operations, paths } from './schema.ts';

export type { components, operations, paths };
export { API_PREFIX };

export type ApiClient = Client<paths>;

/** RFC 9457 problem body of every 4xx/5xx response; branch on `code`. */
export type Problem = components['schemas']['Problem'];
export type ErrorCode = Problem['code'];
export type Health = components['schemas']['Health'];

/**
 * `baseUrl` is the app's origin and defaults to '' (same origin as the SPA). Every call goes to
 * `<origin>/api/<path>` (ADR-060); the few routes the PRD keeps outside /api (/healthz, webhooks,
 * OAuth returns) go to `<origin>/<path>`. Pass `fetch` to stub it in tests.
 */
export function createApiClient({ baseUrl = '', ...options }: ClientOptions = {}): ApiClient {
  const origin = baseUrl.replace(/\/+$/, '');
  const client = createClient<paths>({ ...options, baseUrl: `${origin}${API_PREFIX}` });
  client.use({
    onRequest({ request, schemaPath }) {
      if (!isRootPath(schemaPath)) return undefined;
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(`${API_PREFIX}/`, '/');
      return new Request(url, request);
    },
  });
  return client;
}
