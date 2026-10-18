/**
 * MOCK-ONLY data access for the T-0301 mock-ups. These routes are PROPOSED SHAPES that the
 * contract does not have yet, so the typed client cannot reach them. Each function is replaced by
 * an `api.GET(...)` call from @omnibridge/contract/client once S3 builds the real route.
 */
import type { HomeSummary } from './home.ts';
import type { OrderDetail, OrderPage, Session } from './types.ts';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} returned ${String(res.status)}`);
  return (await res.json()) as T;
}

export const mockApi = {
  session: () => getJson<Session>('/api/mock/session'),
  orders: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== '') qs.set(k, String(v));
    return getJson<OrderPage>(`/api/mock/orders?${qs.toString()}`);
  },
  home: (company: string) =>
    getJson<HomeSummary>(`/api/mock/home?company=${encodeURIComponent(company)}`),
  order: (id: string) => getJson<OrderDetail>(`/api/mock/orders/${encodeURIComponent(id)}`),
};
