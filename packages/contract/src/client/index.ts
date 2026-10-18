/**
 * Typed API client for apps/ui (ADR-004). Types come from `schema.ts`, which `pnpm contract:gen`
 * generates from openapi.json, so a server change that is not regenerated fails the gate.
 *
 * Browser-safe: no Zod, no server code, no Node built-ins.
 *
 *   const api = createApiClient();
 *   const { data, error } = await api.GET('/healthz');
 */
import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { components, operations, paths } from './schema.ts';

export type { components, operations, paths };

export type ApiClient = Client<paths>;

/** RFC 9457 problem body of every 4xx/5xx response; branch on `code`. */
export type Problem = components['schemas']['Problem'];
export type ErrorCode = Problem['code'];
export type Health = components['schemas']['Health'];

/** `baseUrl` defaults to '' (same origin as the SPA). Pass `fetch` to stub it in tests. */
export function createApiClient(options: ClientOptions = {}): ApiClient {
  return createClient<paths>({ baseUrl: '', ...options });
}
