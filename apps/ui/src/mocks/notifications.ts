/**
 * The notification centre (bell) for the client preview (T-0305). PROPOSED SHAPE (mock only),
 * NTF-1..5. A child only gets notifications whose tab and company they have (NTF-2); admins also
 * get the admin ones. Notification text never carries buyer PII (NTF-3).
 */
import { HOUR, ago } from './random.ts';
import type { Session, Tab } from './types.ts';

export interface Notification {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  signal: 'Native' | 'Derived' | 'Estimate' | null;
  companyId: string | null;
  at: string;
  state: 'unread' | 'read' | 'resolved';
  to: string;
  search?: Record<string, string>;
  need: Tab | 'admin';
}

const ALL: Notification[] = [
  {
    id: 'ntf_1',
    severity: 'critical',
    title: 'Amazon UK · Harbour needs re-authorisation',
    detail: 'Orders and stock updates for this account are paused until it is re-authorised.',
    signal: 'Native',
    companyId: 'co_2',
    at: ago(0.6 * HOUR),
    state: 'unread',
    to: '/connections',
    need: 'admin',
  },
  {
    id: 'ntf_2',
    severity: 'critical',
    title: '3 SKUs oversold',
    detail: 'Orders reserve more than you have on hand. Count the shelf before packing.',
    signal: 'Derived',
    companyId: null,
    at: ago(1.2 * HOUR),
    state: 'unread',
    to: '/stock',
    search: { view: 'oversold' },
    need: 'stock',
  },
  {
    id: 'ntf_3',
    severity: 'critical',
    title: 'Tracking not confirmed after 4 hours',
    detail: '2 eBay orders still show no tracking on eBay.',
    signal: 'Derived',
    companyId: 'co_1',
    at: ago(2 * HOUR),
    state: 'unread',
    to: '/orders',
    search: { flag: 'tracking_unconfirmed' },
    need: 'orders',
  },
  {
    id: 'ntf_4',
    severity: 'warning',
    title: 'Valid Tracking Rate is red for Amazon UK · Harbour',
    detail: '93.8% over the last 30 days; the target is above 95%.',
    signal: 'Native',
    companyId: 'co_2',
    at: ago(5 * HOUR),
    state: 'unread',
    to: '/account-health',
    need: 'account_health',
  },
  {
    id: 'ntf_5',
    severity: 'warning',
    title: 'Negative eBay feedback',
    detail: 'eBay · northfield-trading received negative feedback. Reply from Customer Service.',
    signal: 'Native',
    companyId: 'co_1',
    at: ago(9 * HOUR),
    state: 'read',
    to: '/customer-service',
    search: { section: 'feedback' },
    need: 'customer_service',
  },
  {
    id: 'ntf_6',
    severity: 'warning',
    title: 'Stock sync failed on 10 listings',
    detail: 'The last push failed after every retry. It retries on the next change.',
    signal: 'Derived',
    companyId: null,
    at: ago(14 * HOUR),
    state: 'read',
    to: '/stock',
    search: { view: 'sync' },
    need: 'stock',
  },
  {
    id: 'ntf_7',
    severity: 'info',
    title: '7 bills are overdue',
    detail: '£6,338.23 unpaid past the due date.',
    signal: 'Derived',
    companyId: 'co_1',
    at: ago(20 * HOUR),
    state: 'read',
    to: '/finance',
    search: { section: 'expenses', status: 'overdue' },
    need: 'finance',
  },
  {
    id: 'ntf_8',
    severity: 'info',
    title: 'New eBay message',
    detail: 'A buyer asked about order delivery on eBay · kestrel-home.',
    signal: 'Native',
    companyId: 'co_3',
    at: ago(26 * HOUR),
    state: 'resolved',
    to: '/customer-service',
    need: 'customer_service',
  },
  {
    id: 'ntf_9',
    severity: 'info',
    title: 'Ads rule made 17 changes',
    detail: 'Cut bids on expensive keywords ran at 06:00.',
    signal: 'Derived',
    companyId: 'co_1',
    at: ago(30 * HOUR),
    state: 'read',
    to: '/advertising',
    search: { section: 'rules' },
    need: 'advertising',
  },
];

export function notificationsFor(s: Session): Notification[] {
  const companies = new Set(s.companies.map((c) => c.id));
  return ALL.filter(
    (n) =>
      (n.need === 'admin' ? s.user.isAdmin : s.user.isAdmin || s.tabs.includes(n.need)) &&
      (n.companyId === null || companies.has(n.companyId)),
  );
}
