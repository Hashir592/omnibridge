/**
 * The notification routes as the server answers them (T-0501, T-0502; screens T-0312: NTF-1 to
 * NTF-5), for the client preview. The shapes are the contract's (PS-030, PS-031). One notification
 * per type and record; read state is per user; a child sees only the tabs and companies they have
 * ticked, and the security types are admins only (NTF-2). Params are IDs, counts and flags, never
 * buyer text (NTF-3). Company IDs are the mock data's, until the real companies route exists.
 */
import { HttpResponse, http } from 'msw/http';
import type { EmailPreference, Notification } from '../auth/api.ts';
import { HOUR, ago } from './random.ts';
import { currentSession, getPersona, type Persona } from './session.ts';
import type { Session } from './types.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The contract's tab names: NOTIFICATION_TABS in @omnibridge/core. */
type Tab = string;
type Severity = Notification['severity'];

/** The registry rows the mock needs: the server's types (PRD section 6, SEC-12). */
interface MockType {
  title: string;
  severity: Severity;
  tab: Tab;
}

const TYPES: Record<string, MockType> = {
  'channel.auth_lost': {
    title: 'Channel authorisation lost: reconnect needed',
    severity: 'critical',
    tab: 'connections',
  },
  'tracking.unconfirmed': {
    title: 'Tracking not confirmed within 4 hours',
    severity: 'critical',
    tab: 'shipping',
  },
  'inventory.oversold': { title: 'Oversold', severity: 'critical', tab: 'stock-catalogue' },
  'health.band_changed': {
    title: 'Health metric changed band',
    severity: 'warning',
    tab: 'account-health',
  },
  'inventory.sync_failed': {
    title: 'Stock sync failed or drifted',
    severity: 'warning',
    tab: 'stock-catalogue',
  },
  'cs.negative_feedback': {
    title: 'Neutral or negative feedback',
    severity: 'warning',
    tab: 'customer-service',
  },
  'cs.ebay_message': { title: 'New eBay message', severity: 'info', tab: 'customer-service' },
  'forecast.low_stock': { title: 'Low stock: reorder', severity: 'info', tab: 'forecasting' },
  'finance.bill_due': { title: 'Unpaid bill due or overdue', severity: 'warning', tab: 'finance' },
  'ads.rule_changes': { title: 'Ads rule run made changes', severity: 'info', tab: 'advertising' },
  'reminders.due': { title: 'Reminder due', severity: 'info', tab: 'reminders' },
  'users.access_review_due': {
    title: 'Quarterly access review due',
    severity: 'info',
    tab: 'users',
  },
  'security.unusual_login': {
    title: 'Unusual sign-in activity',
    severity: 'warning',
    tab: 'users',
  },
  'security.mass_export': { title: 'Unusually many exports', severity: 'critical', tab: 'users' },
  'pii.erasure_failed': {
    title: 'Buyer data deletion failed: retry needed',
    severity: 'critical',
    tab: 'users',
  },
};

/** The tab the contract names, to the mock session's tab. Others are admin only. */
const SESSION_TAB: Record<string, string | undefined> = {
  home: 'home',
  orders: 'orders',
  shipping: 'shipping',
  'stock-catalogue': 'stock',
  'customer-service': 'customer_service',
  'account-health': 'account_health',
  advertising: 'advertising',
  'sales-profit': 'sales_profit',
  forecasting: 'forecasting',
  finance: 'finance',
  reminders: 'reminders',
  notes: 'notes',
};

/** NTF-2: security types and the admin tabs reach admins only. */
const adminOnly = (tab: Tab) => SESSION_TAB[tab] === undefined;

interface Seed {
  n: number;
  type: string;
  severity?: Severity;
  signal: Notification['signal'];
  companyId: string | null;
  record: Notification['record'];
  params?: Notification['params'];
  hoursAgo: number;
  /** Read by the demo users before the preview starts (the four locked screens show 4 unread). */
  read?: boolean;
  resolved?: boolean;
}

const SEEDS: Seed[] = [
  {
    n: 1,
    type: 'channel.auth_lost',
    signal: 'native',
    companyId: 'co_2',
    record: { kind: 'channel_account', id: uuid(7001) },
    hoursAgo: 0.6,
  },
  {
    n: 2,
    type: 'inventory.oversold',
    signal: 'derived',
    companyId: null,
    record: { kind: 'sku', id: uuid(7002) },
    params: { count: 3 },
    hoursAgo: 1.2,
  },
  {
    n: 3,
    type: 'tracking.unconfirmed',
    signal: 'derived',
    companyId: 'co_1',
    record: { kind: 'order', id: uuid(7003) },
    params: { count: 2 },
    hoursAgo: 2,
  },
  {
    n: 4,
    type: 'health.band_changed',
    signal: 'native',
    companyId: 'co_2',
    record: { kind: 'channel_account', id: uuid(7004) },
    hoursAgo: 5,
  },
  {
    n: 5,
    type: 'cs.negative_feedback',
    signal: 'native',
    companyId: 'co_1',
    record: { kind: 'feedback', id: uuid(7005) },
    hoursAgo: 9,
    read: true,
  },
  {
    n: 6,
    type: 'inventory.sync_failed',
    signal: 'derived',
    companyId: null,
    record: { kind: 'listing', id: uuid(7006) },
    params: { count: 10 },
    hoursAgo: 14,
    read: true,
  },
  {
    n: 7,
    type: 'finance.bill_due',
    severity: 'info',
    signal: 'derived',
    companyId: 'co_1',
    record: { kind: 'expense', id: uuid(7007) },
    params: { count: 7 },
    hoursAgo: 20,
    read: true,
  },
  {
    n: 8,
    type: 'cs.ebay_message',
    signal: 'native',
    companyId: 'co_3',
    record: { kind: 'message', id: uuid(7008) },
    hoursAgo: 26,
    read: true,
    resolved: true,
  },
  {
    n: 9,
    type: 'ads.rule_changes',
    signal: 'derived',
    companyId: 'co_1',
    record: { kind: 'ads_rule', id: '2026-11-19T06' },
    params: { count: 17 },
    hoursAgo: 30,
    read: true,
  },
  {
    n: 10,
    type: 'pii.erasure_failed',
    signal: 'derived',
    companyId: null,
    record: { kind: 'erasure_request', id: uuid(905) },
    hoursAgo: 3,
    read: true,
  },
  {
    n: 11,
    type: 'security.unusual_login',
    signal: 'derived',
    companyId: null,
    record: { kind: 'user', id: uuid(7011) },
    params: { failures: 12, newNetwork: true },
    hoursAgo: 7,
    read: true,
  },
  {
    n: 12,
    type: 'reminders.due',
    signal: null,
    companyId: null,
    record: { kind: 'reminder', id: '2026-11-20T09' },
    hoursAgo: 11,
    read: true,
  },
];

const stamp = (hoursAgo: number) => ago(hoursAgo * HOUR);

const build = (): Notification[] =>
  SEEDS.map((s) => {
    const t = TYPES[s.type];
    if (!t) throw new Error(`mock type ${s.type}`);
    const at = stamp(s.hoursAgo);
    return {
      id: uuid(s.n),
      type: s.type,
      title: t.title,
      severity: s.severity ?? t.severity,
      signal: s.signal,
      tab: t.tab,
      companyId: s.companyId,
      channelAccountId: null,
      record: s.record,
      params: s.params ?? {},
      state: s.resolved ? 'resolved' : s.read ? 'read' : 'unread',
      createdAt: at,
      updatedAt: at,
      resolvedAt: s.resolved ? at : null,
    };
  });

let all = build();
/** Per user (persona): the notifications they have read. */
let readBy = new Map<Persona, Set<string>>();
let preferences = new Map<Persona, Map<string, boolean>>();

/** Back to the seed, so one test does not see another's reads. */
export function resetNotificationsMock(): void {
  all = build();
  readBy = new Map();
  preferences = new Map();
}

const readSet = (p: Persona): Set<string> => {
  let set = readBy.get(p);
  if (!set) {
    set = new Set(SEEDS.filter((x) => x.read).map((x) => uuid(x.n)));
    readBy.set(p, set);
  }
  return set;
};

function visibleTo(s: Session): Notification[] {
  const companies = new Set(s.companies.map((c) => c.id));
  const read = readSet(getPersona());
  return all
    .filter((n) => {
      const tab = n.tab;
      if (tab === null) return false;
      const allowed =
        s.user.isAdmin ||
        (!adminOnly(tab) && (s.tabs as string[]).includes(SESSION_TAB[tab] ?? ''));
      return allowed && (n.companyId === null || companies.has(n.companyId));
    })
    .map((n): Notification => ({
      ...n,
      state: n.resolvedAt ? 'resolved' : read.has(n.id) ? 'read' : 'unread',
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const problem = (status: number, code: string, detail?: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: '', status, code, ...(detail ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const STATES = ['unread', 'read', 'resolved'];
const SEVERITIES = ['critical', 'warning', 'info'];

/** PS-031: one line per type this user can receive. Critical on by default, locked for admins. */
function preferencesFor(s: Session): EmailPreference[] {
  const chosen = preferences.get(getPersona());
  return Object.entries(TYPES)
    .filter(
      ([, t]) =>
        s.user.isAdmin ||
        (!adminOnly(t.tab) && (s.tabs as string[]).includes(SESSION_TAB[t.tab] ?? '')),
    )
    .map(([type, t]) => ({
      type,
      title: t.title,
      severity: t.severity,
      email: chosen?.get(type) ?? t.severity === 'critical',
      locked: s.user.isAdmin && t.severity === 'critical',
    }));
}

export const notificationHandlers = [
  http.get('*/api/notifications', ({ request }) => {
    const q = new URL(request.url).searchParams;
    const state = q.get('state');
    const severity = q.get('severity');
    if ((state && !STATES.includes(state)) || (severity && !SEVERITIES.includes(severity)))
      return problem(400, 'validation_failed');
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
    const start = Number(q.get('cursor') ?? 0) || 0;
    const rows = visibleTo(currentSession()).filter(
      (n) => (!state || n.state === state) && (!severity || n.severity === severity),
    );
    const items = rows.slice(start, start + limit);
    return HttpResponse.json({
      items,
      next_cursor: start + limit < rows.length ? String(start + limit) : null,
    });
  }),

  http.get('*/api/notifications/unread-count', () =>
    HttpResponse.json({
      unread: visibleTo(currentSession()).filter((n) => n.state === 'unread').length,
    }),
  ),

  http.post('*/api/notifications/read-all', () => {
    const read = readSet(getPersona());
    const open = visibleTo(currentSession()).filter((n) => n.state === 'unread');
    for (const n of open) read.add(n.id);
    return HttpResponse.json({ marked: open.length });
  }),

  http.post('*/api/notifications/:id/read', ({ params }) => {
    const n = visibleTo(currentSession()).find((x) => x.id === params.id);
    if (!n) return problem(404, 'not_found');
    const read = readSet(getPersona());
    const marked = n.state === 'unread' ? 1 : 0;
    read.add(n.id);
    return HttpResponse.json({ marked });
  }),

  http.get('*/api/me/notification-email-preferences', () =>
    HttpResponse.json({ items: preferencesFor(currentSession()) }),
  ),

  http.put('*/api/me/notification-email-preferences', async ({ request }) => {
    const s = currentSession();
    const body = (await request.json()) as { items?: Array<{ type: string; email: boolean }> };
    const items = body.items ?? [];
    if (items.length < 1 || items.length > 100) return problem(400, 'validation_failed');
    const offered = new Map(preferencesFor(s).map((p) => [p.type, p]));
    for (const i of items) {
      const p = offered.get(i.type);
      if (!p) return problem(400, 'validation_failed', 'This notification type is not available.');
      if (p.locked && !i.email)
        return problem(400, 'validation_failed', 'Critical alerts stay on for admins.');
    }
    const chosen = preferences.get(getPersona()) ?? new Map<string, boolean>();
    for (const i of items) chosen.set(i.type, i.email);
    preferences.set(getPersona(), chosen);
    return HttpResponse.json({ items: preferencesFor(s) });
  }),
];
