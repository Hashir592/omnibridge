/**
 * MSW handlers for the T-0305 client preview screens. Every route here is a PROPOSED SHAPE
 * (docs/DECISIONS.md, PS for T-0305). Each one mirrors the server's checks: the tab must be
 * ticked (PERM-3), admin pages need an admin (PERM-4), and data covers permitted companies only.
 */
import { HttpResponse, http } from 'msw/http';
import { adsOverview } from './ads.ts';
import { connections, users } from './admin.ts';
import { auditPage } from './audit.ts';
import { expensePage, pnl, vatFor } from './finance.ts';
import { forecastPage } from './forecast.ts';
import { amazonHealth, ebayHealth } from './health.ts';
import {
  amazonConversations,
  amazonThread,
  conversations,
  feedback,
  patchAmazonConversation,
  patchConversation,
  type ConversationPatch,
  reviewRequests,
  thread,
} from './inbox.ts';
import { notificationsFor } from './notifications.ts';
import { profitSummary } from './profit.ts';
import { currentSession } from './session.ts';
import { skuDetail, skuPage } from './stock.ts';
import { notes, reminders } from './tools.ts';
import type { Tab } from './types.ts';

const forbidden = () => HttpResponse.json({ code: 'forbidden' }, { status: 403 });

/** The permitted company ids, or null when the user lacks the tab. */
function gate(tab: Tab | 'admin'): Set<string> | null {
  const s = currentSession();
  const ok = tab === 'admin' ? s.user.isAdmin : s.tabs.includes(tab);
  return ok ? new Set(s.companies.map((c) => c.id)) : null;
}

const params = (request: Request) => new URL(request.url).searchParams;

export const previewHandlers = [
  http.get('*/api/mock/stock/skus', ({ request }) => {
    const allowed = gate('stock');
    return allowed ? HttpResponse.json(skuPage(allowed, params(request))) : forbidden();
  }),
  http.get('*/api/mock/stock/skus/:id', ({ params: p }) => {
    const allowed = gate('stock');
    if (!allowed) return forbidden();
    const d = skuDetail(allowed, String(p.id));
    return d ? HttpResponse.json(d) : HttpResponse.json({ code: 'not_found' }, { status: 404 });
  }),

  http.get('*/api/mock/sales-profit', ({ request }) => {
    const allowed = gate('sales_profit');
    return allowed ? HttpResponse.json(profitSummary(allowed, params(request))) : forbidden();
  }),

  http.get('*/api/mock/finance/vat/:companyId', ({ params: p }) => {
    const allowed = gate('finance');
    if (!allowed) return forbidden();
    const v = vatFor(allowed, String(p.companyId));
    return v ? HttpResponse.json(v) : HttpResponse.json({ code: 'not_found' }, { status: 404 });
  }),
  http.get('*/api/mock/finance/expenses', ({ request }) => {
    const allowed = gate('finance');
    return allowed ? HttpResponse.json(expensePage(allowed, params(request))) : forbidden();
  }),
  http.get('*/api/mock/finance/pnl', ({ request }) => {
    const allowed = gate('finance');
    return allowed ? HttpResponse.json(pnl(allowed, params(request))) : forbidden();
  }),

  http.get('*/api/mock/account-health/amazon', ({ request }) => {
    const allowed = gate('account_health');
    return allowed
      ? HttpResponse.json(amazonHealth(allowed, params(request).get('company')))
      : forbidden();
  }),
  http.get('*/api/mock/account-health/ebay', ({ request }) => {
    const allowed = gate('account_health');
    return allowed
      ? HttpResponse.json(ebayHealth(allowed, params(request).get('company')))
      : forbidden();
  }),

  // Wave 2
  http.get('*/api/mock/customer-service/conversations', ({ request }) => {
    const allowed = gate('customer_service');
    return allowed ? HttpResponse.json(conversations(allowed, params(request))) : forbidden();
  }),
  // Message bodies are buyer PII (CS-2): every read is logged, as for order detail (ORD-5).
  http.get('*/api/mock/customer-service/conversations/:id', ({ params: p }) => {
    const allowed = gate('customer_service');
    if (!allowed) return forbidden();
    const t = thread(allowed, String(p.id));
    return t ? HttpResponse.json(t) : HttpResponse.json({ code: 'not_found' }, { status: 404 });
  }),
  // C6 (CS-6): Amazon buyer messages, one inbox per Amazon account. Bodies are buyer PII.
  http.get('*/api/mock/customer-service/amazon/conversations', ({ request }) => {
    const allowed = gate('customer_service');
    return allowed ? HttpResponse.json(amazonConversations(allowed, params(request))) : forbidden();
  }),
  http.get('*/api/mock/customer-service/amazon/conversations/:id', ({ params: p }) => {
    const allowed = gate('customer_service');
    if (!allowed) return forbidden();
    const t = amazonThread(allowed, String(p.id));
    return t ? HttpResponse.json(t) : HttpResponse.json({ code: 'not_found' }, { status: 404 });
  }),
  // C6 setup check: Amazon relays a test message to the account's inbound address.
  http.post('*/api/mock/connections/:id/buyer-messages/test', async ({ params: p }) => {
    if (!gate('admin')) return forbidden();
    await new Promise((r) => setTimeout(r, 900));
    const c = connections.find((x) => x.id === String(p.id));
    if (!c?.buyerMessages) return HttpResponse.json({ code: 'not_found' }, { status: 404 });
    return HttpResponse.json(
      c.buyerMessages.lastTest === 'failed'
        ? {
            ok: false,
            detail: 'No test message arrived within 2 minutes. Check step 1 in Seller Central.',
          }
        : { ok: true, receivedAt: new Date().toISOString() },
    );
  }),
  http.post('*/api/mock/customer-service/conversations/:id', async ({ params: p, request }) => {
    const allowed = gate('customer_service');
    if (!allowed) return forbidden();
    const patch = (await request.json()) as ConversationPatch;
    return patchConversation(allowed, String(p.id), patch)
      ? new HttpResponse(null, { status: 204 })
      : HttpResponse.json({ code: 'not_found' }, { status: 404 });
  }),
  http.post(
    '*/api/mock/customer-service/amazon/conversations/:id',
    async ({ params: p, request }) => {
      const allowed = gate('customer_service');
      if (!allowed) return forbidden();
      const patch = (await request.json()) as ConversationPatch;
      return patchAmazonConversation(allowed, String(p.id), patch)
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json({ code: 'not_found' }, { status: 404 });
    },
  ),
  http.get('*/api/mock/customer-service/feedback', ({ request }) => {
    const allowed = gate('customer_service');
    return allowed
      ? HttpResponse.json(feedback(allowed, params(request).get('company')))
      : forbidden();
  }),
  http.get('*/api/mock/customer-service/review-requests', ({ request }) => {
    const allowed = gate('customer_service');
    return allowed
      ? HttpResponse.json(reviewRequests(allowed, params(request).get('company')))
      : forbidden();
  }),
  http.get('*/api/mock/advertising', ({ request }) => {
    const allowed = gate('advertising');
    return allowed ? HttpResponse.json(adsOverview(allowed, params(request))) : forbidden();
  }),
  http.get('*/api/mock/forecasting', ({ request }) =>
    gate('forecasting') ? HttpResponse.json(forecastPage(params(request))) : forbidden(),
  ),
  http.get('*/api/mock/reminders', () =>
    gate('reminders') ? HttpResponse.json(reminders) : forbidden(),
  ),
  http.get('*/api/mock/notes', () => (gate('notes') ? HttpResponse.json(notes) : forbidden())),
  http.get('*/api/mock/notifications', () => HttpResponse.json(notificationsFor(currentSession()))),
  http.get('*/api/mock/audit-log', ({ request }) =>
    gate('admin') ? HttpResponse.json(auditPage(params(request))) : forbidden(),
  ),

  http.get('*/api/mock/users', () => (gate('admin') ? HttpResponse.json(users) : forbidden())),
  http.get('*/api/mock/connections', () =>
    gate('admin') ? HttpResponse.json(connections) : forbidden(),
  ),
];
