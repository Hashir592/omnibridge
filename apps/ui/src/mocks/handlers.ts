/**
 * MSW handlers (T-0301). Everything under /api/mock/* is a PROPOSED SHAPE (mock only); /healthz
 * matches the real contract route. Lists page at 50 rows, as the server will (DIRECTION §5).
 */
import type { Health } from '@omnibridge/contract/client';
import { HttpResponse, http } from 'msw/http';
import { authHandlers } from './auth.ts';
import { orders } from './data.ts';
import { orderDetail } from './detail.ts';
import { previewHandlers } from './preview-handlers.ts';
import { homeSummary } from './home.ts';
import { currentSession } from './session.ts';
import type { OrderCounts, OrderPage, OrderRow } from './types.ts';

/** Mock of the ORD-5 audit: every full PII view is recorded (user, order, time). */
export const piiViewLog: Array<{ user: string; orderId: string; at: string }> = [];
import { daysFromToday } from '../lib/format.ts';

const SIZES = [20, 50, 100];

const isOverdue = (o: OrderRow, now: number) =>
  o.status === 'awaiting_dispatch' && Date.parse(o.shipBy) < now;
const isDueToday = (o: OrderRow, now: number) =>
  o.status === 'awaiting_dispatch' && !isOverdue(o, now) && daysFromToday(o.shipBy) === 0;
const isFlagged = (o: OrderRow) => o.flags.some((f) => f !== 'fba');

function permitted(companyParam: string | null): OrderRow[] {
  const allowed = new Set(currentSession().companies.map((c) => c.id));
  // "Combined" means the user's permitted companies only (invariant 4).
  return orders.filter(
    (o) =>
      allowed.has(o.companyId) &&
      (!companyParam || companyParam === 'all' || o.companyId === companyParam),
  );
}

function counts(rows: OrderRow[], now: number): OrderCounts {
  return {
    all: rows.length,
    awaiting: rows.filter((o) => o.status === 'awaiting_dispatch').length,
    overdue: rows.filter((o) => isOverdue(o, now)).length,
    dueToday: rows.filter((o) => isDueToday(o, now)).length,
    flagged: rows.filter(isFlagged).length,
  };
}

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

export const handlers = [
  ...authHandlers,
  ...previewHandlers,

  http.get('*/healthz', () =>
    HttpResponse.json<Health>({ status: 'ok', db_main: 'ok', db_pii: 'ok', version: 'mock' }),
  ),

  http.get('*/api/mock/session', () => HttpResponse.json(currentSession())),

  http.get('*/api/mock/home', ({ request }) =>
    HttpResponse.json(
      homeSummary(permitted(new URL(request.url).searchParams.get('company')), currentSession()),
    ),
  ),

  http.get('*/api/mock/orders', ({ request }) => {
    const url = new URL(request.url);
    const p = url.searchParams;
    const now = Date.now();
    const base = permitted(p.get('company'));

    const view = p.get('view') ?? 'all';
    const q = (p.get('q') ?? '').trim().toLowerCase();
    const channels = list(p.get('channel'));
    const statuses = list(p.get('status'));
    const flags = list(p.get('flag'));

    let rows = base.filter((o) => {
      if (view === 'awaiting' && o.status !== 'awaiting_dispatch') return false;
      if (view === 'overdue' && !isOverdue(o, now)) return false;
      if (view === 'today' && !isDueToday(o, now)) return false;
      if (view === 'flagged' && !isFlagged(o)) return false;
      if (channels.length && !channels.includes(o.channelAccountId)) return false;
      if (statuses.length && !statuses.includes(o.status)) return false;
      if (flags.length && !flags.some((f) => o.flags.includes(f as OrderRow['flags'][number])))
        return false;
      if (q && !o.ref.toLowerCase().includes(q)) return false;
      return true;
    });
    if (view === 'awaiting' || view === 'overdue' || view === 'today') {
      rows = [...rows].sort((a, b) => a.shipBy.localeCompare(b.shipBy));
    }

    const limit = SIZES.includes(Number(p.get('limit'))) ? Number(p.get('limit')) : 50;
    const cursor = Number(p.get('cursor') ?? 0);
    const items = rows.slice(cursor, cursor + limit);
    const body: OrderPage = {
      items,
      nextCursor: cursor + limit < rows.length ? cursor + limit : null,
      total: rows.length,
      counts: counts(base, now),
    };
    return HttpResponse.json(body);
  }),

  // Full detail incl. buyer PII: only for users with the Orders or Shipping tab on a permitted company.
  http.get('*/api/mock/orders/:id', ({ params }) => {
    const session = currentSession();
    const o = orders.find((x) => x.id === params.id);
    const allowedTab = session.tabs.includes('orders') || session.tabs.includes('shipping');
    if (!o || !allowedTab || !session.companies.some((c) => c.id === o.companyId)) {
      return HttpResponse.json({ code: 'not_found' }, { status: 404 });
    }
    piiViewLog.push({ user: session.user.name, orderId: o.id, at: new Date().toISOString() });
    return HttpResponse.json(orderDetail(o));
  }),
];
