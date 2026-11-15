/**
 * MOCK-ONLY data access for the T-0301 mock-ups. These routes are PROPOSED SHAPES that the
 * contract does not have yet, so the typed client cannot reach them. Each function is replaced by
 * an `api.GET(...)` call from @omnibridge/contract/client once S3 builds the real route.
 */
import type { AdsOverview } from './ads.ts';
import type { Connection } from './admin.ts';
import type { AuditPage } from './audit.ts';
import type { ForecastPage } from './forecast.ts';
import type {
  AmazonInbox,
  AmazonThread,
  Conversation,
  Feedback,
  FeedbackSummary,
  ReviewRequests,
  Thread,
} from './inbox.ts';
import type { Notification } from './notifications.ts';
import type { Note, Reminder } from './tools.ts';
import type { ExpensePage, Pnl, VatCompany } from './finance.ts';
import type { AmazonHealth, EbayHealth } from './health.ts';
import type { HomeSummary } from './home.ts';
import type { ProfitSummary } from './profit.ts';
import type { SkuDetail, SkuPage, UnmappedPage } from './stock.ts';
import type { Channel, OrderDetail, OrderPage, OrderStatus, Session } from './types.ts';

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

  // T-0305 client preview (PROPOSED SHAPES).
  skus: (params: Params) => getJson<SkuPage | UnmappedPage>(`/api/mock/stock/skus?${qs(params)}`),
  sku: (id: string) => getJson<SkuDetail>(`/api/mock/stock/skus/${encodeURIComponent(id)}`),
  salesProfit: (params: Params) => getJson<ProfitSummary>(`/api/mock/sales-profit?${qs(params)}`),
  vat: (companyId: string) =>
    getJson<VatCompany>(`/api/mock/finance/vat/${encodeURIComponent(companyId)}`),
  expenses: (params: Params) => getJson<ExpensePage>(`/api/mock/finance/expenses?${qs(params)}`),
  pnl: (params: Params) => getJson<Pnl>(`/api/mock/finance/pnl?${qs(params)}`),
  amazonHealth: (company: string) =>
    getJson<AmazonHealth[]>(
      `/api/mock/account-health/amazon?company=${encodeURIComponent(company)}`,
    ),
  ebayHealth: (company: string) =>
    getJson<EbayHealth[]>(`/api/mock/account-health/ebay?company=${encodeURIComponent(company)}`),
  connections: () => getJson<Connection[]>('/api/mock/connections'),
  conversations: (params: Params) =>
    getJson<{
      items: Conversation[];
      counts: { open: number; unread: number; archived: number };
    }>(`/api/mock/customer-service/conversations?${qs(params)}`),
  thread: (id: string) =>
    getJson<Thread>(`/api/mock/customer-service/conversations/${encodeURIComponent(id)}`),
  feedback: (company: string) =>
    getJson<{ items: Feedback[]; ebaySummary: FeedbackSummary[] }>(
      `/api/mock/customer-service/feedback?${qs({ company })}`,
    ),
  reviewRequests: (company: string) =>
    getJson<ReviewRequests>(`/api/mock/customer-service/review-requests?${qs({ company })}`),
  ads: (params: Params) => getJson<AdsOverview>(`/api/mock/advertising?${qs(params)}`),
  forecast: (params: Params) => getJson<ForecastPage>(`/api/mock/forecasting?${qs(params)}`),
  reminders: () => getJson<Reminder[]>('/api/mock/reminders'),
  notes: () => getJson<Note[]>('/api/mock/notes'),
  notifications: () => getJson<Notification[]>('/api/mock/notifications'),
  audit: (params: Params) => getJson<AuditPage>(`/api/mock/audit-log?${qs(params)}`),

  // T-0306 client changes (PROPOSED SHAPES).
  todayOrders: (channel: Channel, company: string) =>
    getJson<TodayOrders>(`/api/mock/home/today-orders?${qs({ channel, company })}`),
  amazonInbox: (params: Params) =>
    getJson<AmazonInbox>(`/api/mock/customer-service/amazon/conversations?${qs(params)}`),
  amazonThread: (id: string) =>
    getJson<AmazonThread>(
      `/api/mock/customer-service/amazon/conversations/${encodeURIComponent(id)}`,
    ),
  patchConversation: (
    channel: 'ebay' | 'amazon',
    id: string,
    patch: { unread?: boolean; state?: 'open' | 'archived' | 'done' },
  ) =>
    send<undefined>(
      'POST',
      `/api/mock/customer-service/${channel === 'amazon' ? 'amazon/' : ''}conversations/${encodeURIComponent(id)}`,
      patch,
    ),
  testBuyerMessages: (connectionId: string) =>
    send<{ ok: boolean; receivedAt?: string; detail?: string }>(
      'POST',
      `/api/mock/connections/${encodeURIComponent(connectionId)}/buyer-messages/test`,
    ),
  removeFromGroup: (groupId: string, orderId: string, reason: string) =>
    send<undefined>(
      'POST',
      `/api/mock/order-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(orderId)}/remove`,
      { reason },
    ),
  dismissGroup: (groupId: string, reason: string) =>
    send<undefined>('POST', `/api/mock/order-groups/${encodeURIComponent(groupId)}/dismiss`, {
      reason,
    }),
};

/** C1 (HOME-3): the latest orders placed today on one channel. No buyer details. */
export interface TodayOrders {
  total: number;
  channelAccountIds: string[];
  items: Array<{
    id: string;
    ref: string;
    placedAt: string;
    companyId: string;
    totalPence: number;
    status: OrderStatus;
  }>;
}

type Params = Record<string, string | number | undefined>;

function qs(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
}

/** A mock POST answer: the parsed body (JSON or problem+json) plus status and headers. */
export interface MockReply<T> {
  ok: boolean;
  status: number;
  body: T | MockProblem | undefined;
  retryAfter: number | undefined;
}

export interface MockProblem {
  code: string;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}

async function send<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<MockReply<T>> {
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  const retry = Number(res.headers.get('retry-after'));
  return {
    ok: res.ok,
    status: res.status,
    body: text ? (JSON.parse(text) as T | MockProblem) : undefined,
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
  };
}
