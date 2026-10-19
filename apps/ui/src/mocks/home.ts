/**
 * Home summary (HOME-1) for the mock-ups. PROPOSED SHAPE (mock only). Figures come from the
 * same synthetic orders as the list, so the tiles and the lists they link to agree.
 * Items the user's tabs do not cover are removed here, as the server will do (HOME-2, PERM-3).
 */
import { daysFromToday } from '../lib/format.ts';
import type { Channel, OrderRow, Session, Tab } from './types.ts';

export type Severity = 'critical' | 'warning' | 'info';
type Need = Tab | 'admin';

export interface HomeAlert {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  action: string;
  to: string;
  search?: Record<string, string>;
  need: Need;
}

export interface HomeSummary {
  asOf: string;
  todayByChannel: Array<{ channel: Channel; orders: number }> | null;
  dispatch: { awaiting: number; overdue: number; today: number; tomorrow: number } | null;
  sales: Array<{
    period: 'Today' | 'Last 7 days' | 'Last 30 days';
    orders: number;
    units: number;
    grossPence: number;
  }> | null;
  alerts: HomeAlert[];
  reminders: Array<{ id: string; time: string; text: string }> | null;
  tasks: Array<{
    id: string;
    label: string;
    count: number;
    to: string;
    search?: Record<string, string> | undefined;
  }>;
}

const DAY = 86_400_000;

export function homeSummary(rows: OrderRow[], session: Session): HomeSummary {
  const now = Date.now();
  const has = (n: Need) => (n === 'admin' ? session.user.isAdmin : session.tabs.includes(n));
  const live = rows.filter((o) => o.status !== 'cancelled');
  const awaiting = rows.filter((o) => o.status === 'awaiting_dispatch');
  const overdue = awaiting.filter((o) => Date.parse(o.shipBy) < now);
  const notLate = awaiting.filter((o) => Date.parse(o.shipBy) >= now);

  const period = (days: number) =>
    live.filter((o) =>
      days === 0 ? daysFromToday(o.placedAt) === 0 : now - Date.parse(o.placedAt) < days * DAY,
    );
  const sum = (xs: OrderRow[]) => ({
    orders: xs.length,
    units: xs.reduce((a, o) => a + o.itemCount, 0),
    grossPence: xs.reduce((a, o) => a + o.totalPence, 0),
  });
  const today = period(0);
  const count = (f: OrderRow['flags'][number]) =>
    rows.filter((o) => o.flags.includes(f) && o.status !== 'cancelled').length;
  const unconfirmed = count('tracking_unconfirmed');
  const oversold = count('oversold');
  const shortened = rows.filter(
    (o) => o.flags.includes('address_shortened') && o.status === 'awaiting_dispatch',
  ).length;

  const alerts: HomeAlert[] = [
    {
      id: 'auth',
      severity: 'critical' as const,
      title: 'Amazon UK, Harbour: authorisation lost',
      detail: 'Orders and stock stopped syncing at 06:12. Sign in to Amazon again to restore it.',
      action: 'Reconnect',
      to: '/connections',
      need: 'admin' as const,
    },
    {
      id: 'oversold',
      severity: 'critical' as const,
      title: `${String(oversold)} order${oversold === 1 ? '' : 's'} oversold`,
      detail: 'Stock went below zero. Check the shelf before these are packed.',
      action: 'View orders',
      to: '/orders',
      search: { flag: 'oversold' },
      need: 'orders' as const,
    },
    {
      id: 'health',
      severity: 'warning' as const,
      title: 'eBay, kestrel-home: late shipment rate amber',
      detail: '3.1% over the last 90 days. eBay sets the limit at 3%.',
      action: 'See account health',
      to: '/account-health',
      need: 'account_health' as const,
    },
    {
      id: 'tracking',
      severity: 'warning' as const,
      title: `${String(unconfirmed)} tracking number${unconfirmed === 1 ? '' : 's'} not confirmed`,
      detail: 'The channel has not accepted them yet. OmniBridge keeps retrying.',
      action: 'View orders',
      to: '/orders',
      search: { flag: 'tracking_unconfirmed' },
      need: 'orders' as const,
    },
    {
      id: 'lowstock',
      severity: 'warning' as const,
      title: '7 SKUs low on stock',
      detail: 'Below their reorder point. 2 will run out within 5 days at the current rate.',
      action: 'View stock',
      to: '/stock',
      need: 'stock' as const,
    },
    {
      id: 'stale',
      severity: 'info' as const,
      title: '12 eBay listings not updated for 30 days',
      detail: 'Prices or quantity may be out of date on eBay.',
      action: 'View listings',
      to: '/stock',
      need: 'stock' as const,
    },
  ].filter((a) => has(a.need) && !/^0 /.test(a.title));

  const tasks = [
    {
      id: 'shortened',
      label: 'Address-shortened orders to check',
      count: shortened,
      to: '/orders',
      search: { flag: 'address_shortened', view: 'awaiting' },
      need: 'orders' as Need,
    },
    {
      id: 'voided',
      label: 'Voided labels to reconcile',
      count: 2,
      to: '/shipping',
      need: 'shipping' as Need,
    },
    {
      id: 'access',
      label: 'Quarterly access review due',
      count: 1,
      to: '/users',
      need: 'admin' as Need,
    },
  ]
    .filter((t) => has(t.need) && t.count > 0)
    .map((t) => ({ id: t.id, label: t.label, count: t.count, to: t.to, search: t.search }));

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return {
    asOf: new Date(now - 2 * 60_000).toISOString(),
    todayByChannel: has('orders')
      ? (['amazon', 'ebay', 'website'] as const).map((c) => ({
          channel: c,
          orders: today.filter((o) => o.channel === c).length,
        }))
      : null,
    dispatch:
      has('shipping') || has('orders')
        ? {
            awaiting: awaiting.length,
            overdue: overdue.length,
            today: notLate.filter((o) => daysFromToday(o.shipBy) === 0).length,
            tomorrow: notLate.filter((o) => daysFromToday(o.shipBy) === 1).length,
          }
        : null,
    sales: has('sales_profit')
      ? [
          { period: 'Today', ...sum(today) },
          { period: 'Last 7 days', ...sum(period(7)) },
          { period: 'Last 30 days', ...sum(period(30)) },
        ]
      : null,
    alerts: alerts.sort((a, b) => rank[a.severity] - rank[b.severity]),
    reminders: has('reminders')
      ? [
          { id: 'r1', time: '10:00', text: 'Send the VAT figures for Q3 to the accountant' },
          { id: 'r2', time: '14:30', text: 'Book the DPD collection for the bulk Harbour order' },
          { id: 'r3', time: '16:00', text: 'Recount the oak chopping boards on shelf B4' },
        ]
      : null,
    tasks,
  };
}
