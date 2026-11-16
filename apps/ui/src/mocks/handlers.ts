/**
 * MSW handlers (T-0301). Everything under /api/mock/* is a PROPOSED SHAPE (mock only); /healthz
 * matches the real contract route. Lists page at 50 rows, as the server will (DIRECTION §5).
 */
import type { Health } from '@omnibridge/contract/client';
import { passthrough } from 'msw';
import { HttpResponse, http } from 'msw/http';
import { daysFromToday } from '../lib/format.ts';
import { authHandlers } from './auth.ts';
import { orders } from './data.ts';
import { orderDetail } from './detail.ts';
import { computeGroups, dismissGroup, removeFromGroup } from './groups.ts';
import { homeSummary } from './home.ts';
import { orderPage } from './orderList.ts';
import { previewHandlers } from './preview-handlers.ts';
import { channelOn, currentSession } from './session.ts';
import type { Channel, OrderRow } from './types.ts';

/** Mock of the ORD-5 audit: every full PII view is recorded (user, order, time). */
export const piiViewLog: Array<{ user: string; orderId: string; at: string }> = [];

function permitted(companyParam: string | null): OrderRow[] {
  const allowed = new Set(currentSession().companies.map((c) => c.id));
  // "Combined" means the user's permitted companies only (invariant 4).
  return orders.filter(
    (o) =>
      allowed.has(o.companyId) &&
      channelOn(o.channel) &&
      (!companyParam || companyParam === 'all' || o.companyId === companyParam),
  );
}

const hasOrdersTab = () => {
  const s = currentSession();
  return s.tabs.includes('orders') || s.tabs.includes('shipping');
};

export const handlers = [
  // A page load (the browser asking for a document) is never an API call: Vite serves the SPA.
  // Without this, typing /users or /users/access-reviews into the address bar would get the
  // mock's JSON for GET /users or GET /access-reviews once the service worker is in control.
  http.all('*', ({ request }) =>
    request.mode === 'navigate' || (request.headers.get('accept') ?? '').includes('text/html')
      ? passthrough()
      : undefined,
  ),
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

  // C1 (HOME-3): the latest 10 orders placed today (London day) on one channel. No buyer details.
  http.get('*/api/mock/home/today-orders', ({ request }) => {
    if (!currentSession().tabs.includes('orders'))
      return HttpResponse.json({ code: 'forbidden' }, { status: 403 });
    const p = new URL(request.url).searchParams;
    const channel = p.get('channel') as Channel | null;
    const today = permitted(p.get('company')).filter(
      (o) => o.channel === channel && daysFromToday(o.placedAt) === 0,
    );
    return HttpResponse.json({
      total: today.length,
      channelAccountIds: [...new Set(today.map((o) => o.channelAccountId))],
      items: today.slice(0, 10).map((o) => ({
        id: o.id,
        ref: o.ref,
        placedAt: o.placedAt,
        companyId: o.companyId,
        totalPence: o.totalPence,
        status: o.status,
      })),
    });
  }),

  http.get('*/api/mock/orders', ({ request }) => {
    const p = new URL(request.url).searchParams;
    return HttpResponse.json(orderPage(permitted(p.get('company')), p));
  }),

  // Full detail incl. buyer PII: only for users with the Orders or Shipping tab on a permitted company.
  http.get('*/api/mock/orders/:id', ({ params }) => {
    const session = currentSession();
    const o = orders.find((x) => x.id === params.id);
    if (!o || !hasOrdersTab() || !session.companies.some((c) => c.id === o.companyId)) {
      return HttpResponse.json({ code: 'not_found' }, { status: 404 });
    }
    piiViewLog.push({ user: session.user.name, orderId: o.id, at: new Date().toISOString() });
    const scope = permitted(null);
    const group = computeGroups(scope).find((g) => g.memberIds.includes(o.id));
    const sameBuyer = (group?.memberIds ?? [])
      .filter((id) => id !== o.id)
      .flatMap((id) => {
        const m = scope.find((x) => x.id === id);
        return m ? [{ id: m.id, ref: m.ref, placedAt: m.placedAt, totalPence: m.totalPence }] : [];
      });
    return HttpResponse.json({ ...orderDetail(o), sameBuyer });
  }),

  // C3 addition: take one order out of its group (it then ships on its own).
  http.post('*/api/mock/order-groups/:id/members/:orderId/remove', async ({ params, request }) => {
    if (!hasOrdersTab()) return HttpResponse.json({ code: 'forbidden' }, { status: 403 });
    const body = (await request.json()) as { reason?: string };
    return removeFromGroup(
      permitted(null),
      String(params.id),
      String(params.orderId),
      body.reason?.trim() || 'Ships separately',
    )
      ? new HttpResponse(null, { status: 204 })
      : HttpResponse.json({ code: 'not_found' }, { status: 404 });
  }),

  // C3: "Not the same buyer" dismisses a group for good; the reason goes to the audit log.
  http.post('*/api/mock/order-groups/:id/dismiss', async ({ params, request }) => {
    if (!hasOrdersTab()) return HttpResponse.json({ code: 'forbidden' }, { status: 403 });
    const body = (await request.json()) as { reason?: string };
    if (!body.reason?.trim())
      return HttpResponse.json(
        { code: 'validation_failed', errors: [{ path: 'reason', message: 'required' }] },
        { status: 422 },
      );
    return dismissGroup(permitted(null), String(params.id), body.reason)
      ? new HttpResponse(null, { status: 204 })
      : HttpResponse.json({ code: 'not_found' }, { status: 404 });
  }),
];
