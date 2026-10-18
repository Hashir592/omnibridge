/**
 * Usage example of the typed client (T-0102). S2 builds the real API layer in M03.
 */
import type { ApiClient, Health, Problem } from '@omnibridge/contract/client';

export type HealthResult = { ok: true; health: Health } | { ok: false; problem: Health | Problem };

/** Reads /healthz. A 503 still carries a Health body; other failures carry a Problem. */
export async function getHealth(api: ApiClient): Promise<HealthResult> {
  const { data, error } = await api.GET('/healthz');
  if (data) return { ok: true, health: data };
  return { ok: false, problem: error };
}
