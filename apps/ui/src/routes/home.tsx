import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  BellRing,
  ChevronDown,
  ChevronRight,
  Info,
  OctagonAlert,
  TriangleAlert,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanySwatch, STATUS } from '../components/badges.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatInt, formatPence, formatTime } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import type { HomeSummary, Severity } from '../mocks/home.ts';
import type { Channel } from '../mocks/types.ts';

// Placeholder tabs are registered from NAV at runtime, so their paths are plain strings.
const SALES_PATH: string = '/sales-profit';
const REMINDERS_PATH: string = '/reminders';

const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long' });

/** Home (HOME-1): what needs action first, then today's numbers. Tiles follow the user's tabs (HOME-2). */
export function HomePage() {
  const { session, persona, companyId, company } = useAppState();
  const { data } = useQuery({
    queryKey: ['home', persona, companyId],
    queryFn: () => mockApi.home(companyId),
    enabled: !!session,
  });
  const scope =
    companyId === 'all'
      ? `Combined, ${String(session?.companies.length ?? 0)} companies`
      : company(companyId)?.tradingName;
  const now = new Date().toISOString();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">Home</h1>
        <p className="num mt-0.5 text-13 text-ink-muted">
          {weekday.format(new Date())} {formatDate(now)}, {scope}
          {data && <span>. Updated {formatTime(data.asOf)}</span>}
        </p>

        {data && (
          <div className="mt-5 grid gap-5 lg:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
              <NeedsAction alerts={data.alerts} />
              {(data.todayByChannel || data.sales) && (
                <div className="grid gap-5 md:grid-cols-2">
                  {data.todayByChannel && <OrdersToday rows={data.todayByChannel} />}
                  {data.sales && <Sales rows={data.sales} />}
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              {data.dispatch && <Dispatch d={data.dispatch} />}
              {data.tasks.length > 0 && <Tasks tasks={data.tasks} />}
              {data.reminders && <Reminders items={data.reminders} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ title, link, children }: { title: string; link?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-card border border-border bg-card shadow-card">
      <header className="flex items-center gap-3 border-b border-divider px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {link && <div className="ml-auto text-13">{link}</div>}
      </header>
      {children}
    </section>
  );
}

const SEV: Record<Severity, { icon: LucideIcon; tone: string; label: string }> = {
  critical: { icon: OctagonAlert, tone: 'text-danger', label: 'Critical' },
  warning: { icon: TriangleAlert, tone: 'text-warning', label: 'Warning' },
  info: { icon: Info, tone: 'text-ink-muted', label: 'Info' },
};

function NeedsAction({ alerts }: { alerts: HomeSummary['alerts'] }) {
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  return (
    <Card
      title="Needs action"
      link={
        alerts.length > 0 && (
          <span className="num text-ink-muted">
            {critical > 0 && <span className="font-medium text-danger">{critical} critical, </span>}
            {alerts.length} open
          </span>
        )
      }
    >
      {alerts.length === 0 ? (
        <p className="px-5 py-8 text-center text-13 text-ink-muted">
          Nothing needs action. New alerts appear here as soon as they happen.
        </p>
      ) : (
        <ul>
          {alerts.map((a) => {
            const s = SEV[a.severity];
            const Icon = s.icon;
            return (
              <li
                key={a.id}
                className="flex items-start gap-3 border-b border-divider px-5 py-3.5 last:border-0"
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', s.tone)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-13 font-medium text-ink">
                    <span className="sr-only">{s.label}: </span>
                    {a.title}
                  </p>
                  <p className="mt-0.5 text-13 text-ink-muted">{a.detail}</p>
                </div>
                <Link
                  to={a.to}
                  search={a.search as never}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-ctl border border-border px-3 text-13 font-medium whitespace-nowrap hover:bg-hover"
                >
                  {a.action}
                  <ChevronRight className="size-4 text-ink-muted" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Dispatch({ d }: { d: NonNullable<HomeSummary['dispatch']> }) {
  const row = (label: ReactNode, n: number, due: string, alarm?: boolean) => (
    <Link
      to="/shipping"
      search={{ due } as never}
      className="flex h-10 items-center gap-2 rounded-ctl px-2 text-13 hover:bg-hover"
    >
      <span className={cn('flex-1', alarm && n > 0 && 'font-medium text-danger')}>{label}</span>
      <span className={cn('num font-medium', alarm && n > 0 ? 'text-danger' : 'text-ink')}>
        {formatInt(n)}
      </span>
      <ChevronRight className="size-4 text-ink-muted" aria-hidden />
    </Link>
  );
  return (
    <Card title="Dispatch">
      <div className="px-5 pt-4">
        <p className="num text-2xl leading-8 font-semibold">{formatInt(d.awaiting)}</p>
        <p className="text-13 text-ink-muted">orders awaiting dispatch</p>
      </div>
      <div className="mt-3 px-3">
        {row(
          <span className="flex items-center gap-1.5">
            {d.overdue > 0 && <OctagonAlert className="size-3.5" aria-hidden />}Past ship-by
          </span>,
          d.overdue,
          'late',
          true,
        )}
        {row('Due today', d.today, 'today')}
        {row('Due tomorrow', d.tomorrow, 'tomorrow')}
      </div>
      <div className="px-5 pt-2 pb-4">
        <Link
          to="/shipping"
          className="flex h-10 items-center justify-center gap-2 rounded-ctl bg-side text-13 font-medium text-white hover:bg-side-hover"
        >
          <Truck className="size-4" aria-hidden /> Open shipping desk
        </Link>
      </div>
    </Card>
  );
}

function OrdersToday({ rows }: { rows: NonNullable<HomeSummary['todayByChannel']> }) {
  const total = rows.reduce((a, r) => a + r.orders, 0);
  const max = Math.max(1, ...rows.map((r) => r.orders));
  // C1 (HOME-3): one quick view open at a time; Esc closes it and returns focus to its chevron.
  const [open, setOpen] = useState<Channel | null>(null);
  const toggles = useRef(new Map<Channel, HTMLButtonElement>());
  const close = () => {
    if (!open) return;
    toggles.current.get(open)?.focus();
    setOpen(null);
  };
  return (
    <Card
      title="Orders today"
      link={
        <Link to="/orders" className="flex items-center gap-1 text-brand-600 hover:underline">
          View all <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      <div
        className="px-5 py-4"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <p className="num text-2xl leading-8 font-semibold">{formatInt(total)}</p>
        <ul className="mt-3 flex flex-col gap-1.5">
          {rows.map((r) => {
            const expanded = open === r.channel;
            const panelId = `today-${r.channel}`;
            return (
              <li key={r.channel}>
                <div className="grid grid-cols-[18px_72px_minmax(0,1fr)_32px_28px] items-center gap-x-2 text-13">
                  <ChannelMark channel={r.channel} />
                  <span aria-hidden className="h-1.5 rounded-full bg-[#e2e5ea]">
                    <span
                      className="block h-full rounded-full bg-side"
                      style={{ width: `${String((r.orders / max) * 100)}%` }}
                    />
                  </span>
                  <span className="num text-right font-medium">{formatInt(r.orders)}</span>
                  <button
                    ref={(el) => {
                      if (el) toggles.current.set(r.channel, el);
                    }}
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    aria-label={`${expanded ? 'Hide' : 'Show'} today's ${CHANNEL_NAME[r.channel]} orders`}
                    onClick={() => {
                      setOpen(expanded ? null : r.channel);
                    }}
                    className="grid size-7 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink"
                  >
                    <ChevronDown
                      className={cn(
                        'size-4 transition-transform duration-150',
                        expanded && 'rotate-180',
                      )}
                      aria-hidden
                    />
                  </button>
                </div>
                {expanded && <TodayPanel id={panelId} channel={r.channel} />}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

const CHANNEL_NAME: Record<Channel, string> = {
  amazon: 'Amazon',
  ebay: 'eBay',
  website: 'Website',
};

/** The latest 10 orders placed today on one channel: ref, time, company, total and status. */
function TodayPanel({ id, channel }: { id: string; channel: Channel }) {
  const { session, persona, companyId, company } = useAppState();
  const q = useQuery({
    queryKey: ['today-orders', persona, companyId, channel],
    queryFn: () => mockApi.todayOrders(channel, companyId),
    enabled: !!session,
  });
  return (
    <div
      id={id}
      role="region"
      aria-label={`Today's ${CHANNEL_NAME[channel]} orders`}
      className="mt-2 mb-1 rounded-ctl border border-border"
    >
      {!q.data ? (
        <div aria-busy className="h-24" />
      ) : q.data.items.length === 0 ? (
        <p className="px-3 py-4 text-13 text-ink-muted">
          No {CHANNEL_NAME[channel]} orders yet today. New orders appear here as they arrive.
        </p>
      ) : (
        <>
          <ul>
            {q.data.items.map((o) => {
              const c = company(o.companyId);
              const st = STATUS[o.status];
              const Icon = st.icon;
              return (
                <li key={o.id} className="border-b border-divider last:border-0">
                  <Link
                    to="/orders/$orderId"
                    params={{ orderId: o.id }}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-13 hover:bg-hover"
                  >
                    <span className="min-w-0">
                      <span className="ref block truncate font-medium text-ink">{o.ref}</span>
                      <span className="num flex items-center gap-1.5 text-xs text-ink-muted">
                        {formatTime(o.placedAt)}
                        {c && (
                          <>
                            <CompanySwatch company={c} />
                            <span className="truncate">{c.tradingName}</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="num block font-medium">{formatPence(o.totalPence)}</span>
                      <span className="flex items-center justify-end gap-1 text-xs text-ink-muted">
                        <Icon className="size-3.5" aria-hidden />
                        {st.label}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <Link
            to="/orders"
            search={{ placed: 'today', channel: q.data.channelAccountIds.join(',') }}
            className="flex items-center gap-1 border-t border-divider px-3 py-2 text-13 font-medium text-brand-600 hover:underline"
          >
            View all {formatInt(q.data.total)} <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </>
      )}
    </div>
  );
}

function Sales({ rows }: { rows: NonNullable<HomeSummary['sales']> }) {
  return (
    <Card
      title="Sales"
      link={
        <Link to={SALES_PATH} className="flex items-center gap-1 text-brand-600 hover:underline">
          Sales & Profit <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      <table className="w-full text-13">
        <thead>
          <tr className="text-left text-xs text-ink-muted">
            <th className="px-5 pt-3 pb-1.5 font-medium">Period</th>
            <th className="px-2 pt-3 pb-1.5 text-right font-medium">Orders</th>
            <th className="px-2 pt-3 pb-1.5 text-right font-medium">Units</th>
            <th className="px-5 pt-3 pb-1.5 text-right font-medium">Sales</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period} className="border-t border-divider">
              <td className="px-5 py-2.5">{r.period}</td>
              <td className="num px-2 py-2.5 text-right">{formatInt(r.orders)}</td>
              <td className="num px-2 py-2.5 text-right">{formatInt(r.units)}</td>
              <td className="num px-5 py-2.5 text-right font-medium">
                {formatPence(r.grossPence)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-5 pt-1 pb-3 text-xs text-ink-muted">
        Gross, including VAT and shipping. Cancelled orders excluded.
      </p>
    </Card>
  );
}

function Tasks({ tasks }: { tasks: HomeSummary['tasks'] }) {
  return (
    <Card title="Pending tasks">
      <ul className="px-3 py-2">
        {tasks.map((t) => (
          <li key={t.id}>
            <Link
              to={t.to}
              search={t.search as never}
              className="flex min-h-10 items-center gap-2 rounded-ctl px-2 py-1.5 text-13 hover:bg-hover"
            >
              <span className="flex-1">{t.label}</span>
              <span className="num rounded-full bg-[#e2e5ea] px-2 text-xs leading-[18px] font-medium">
                {formatInt(t.count)}
              </span>
              <ChevronRight className="size-4 text-ink-muted" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Reminders({ items }: { items: NonNullable<HomeSummary['reminders']> }) {
  return (
    <Card
      title="Reminders today"
      link={
        <Link
          to={REMINDERS_PATH}
          className="flex items-center gap-1 text-brand-600 hover:underline"
        >
          All <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      {items.length === 0 ? (
        <p className="px-5 py-6 text-13 text-ink-muted">No reminders due today.</p>
      ) : (
        <ul className="px-5 py-2">
          {items.map((r) => (
            <li
              key={r.id}
              className="flex items-start gap-3 border-b border-divider py-2.5 text-13 last:border-0"
            >
              <BellRing className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
              <span className="num w-11 shrink-0 font-medium">{r.time}</span>
              <span className="min-w-0">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
