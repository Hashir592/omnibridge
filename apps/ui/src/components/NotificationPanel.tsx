import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Bell,
  CircleCheck,
  Info,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { SignalLabel } from '../kit/Badge.tsx';
import { cn } from '../lib/cn.ts';
import { daysFromToday, formatDate, formatTime } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import type { Notification } from '../mocks/notifications.ts';
import { CompanySwatch } from './badges.tsx';

const SEV: Record<Notification['severity'], { icon: LucideIcon; tone: string; label: string }> = {
  critical: { icon: OctagonAlert, tone: 'text-danger', label: 'Critical' },
  warning: { icon: TriangleAlert, tone: 'text-warning', label: 'Warning' },
  info: { icon: Info, tone: 'text-brand-600', label: 'Info' },
};

const when = (iso: string) => {
  const d = daysFromToday(iso);
  return d === 0 ? formatTime(iso) : d === -1 ? `Yesterday, ${formatTime(iso)}` : formatDate(iso);
};

/**
 * The notification centre behind the bell (section 6). Unread first; opening one marks it read
 * (optimistic) and goes to the record. A notification resolves itself when its condition clears.
 */
export function NotificationBell() {
  const { session, persona, company } = useAppState();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'all' | 'unread'>('all');
  const [read, setRead] = useState<Set<string>>(new Set());
  const q = useQuery({
    queryKey: ['notifications', persona],
    queryFn: mockApi.notifications,
    enabled: !!session,
  });
  const items = (q.data ?? []).map((n) =>
    n.state === 'unread' && read.has(n.id) ? { ...n, state: 'read' as const } : n,
  );
  const unread = items.filter((n) => n.state === 'unread').length;
  const shown = view === 'unread' ? items.filter((n) => n.state === 'unread') : items;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="relative grid size-9 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
        aria-label={`Notifications, ${String(unread)} unread`}
      >
        <Bell className="size-[18px]" aria-hidden />
        {unread > 0 && (
          <span className="num absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand-700 px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-card">
            {unread}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="flex max-h-[min(640px,calc(100dvh-80px))] w-[min(420px,calc(100vw-24px))] flex-col rounded-card border border-border bg-card shadow-pop outline-none">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-divider px-4">
              <Popover.Title className="text-sm font-semibold">Notifications</Popover.Title>
              <div role="tablist" aria-label="Show" className="ml-2 flex gap-1">
                {(['all', 'unread'] as const).map((v) => (
                  <button
                    key={v}
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => {
                      setView(v);
                    }}
                    className={cn(
                      'h-7 rounded-full px-2.5 text-xs font-medium',
                      view === v ? 'bg-side text-white' : 'text-ink-muted hover:bg-hover',
                    )}
                  >
                    {v === 'all' ? 'All' : `Unread ${String(unread)}`}
                  </button>
                ))}
              </div>
              {unread > 0 && (
                <button
                  className="ml-auto text-xs font-medium text-brand-600 hover:underline"
                  onClick={() => {
                    setRead(new Set(items.map((n) => n.id)));
                  }}
                >
                  Mark all read
                </button>
              )}
            </div>
            <Popover.Description className="sr-only">
              Alerts for your tabs and companies, newest first.
            </Popover.Description>
            {shown.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
                <CircleCheck className="size-5 text-success" aria-hidden />
                <p className="text-13 text-ink-muted">
                  Nothing unread. New alerts appear here as they happen.
                </p>
              </div>
            ) : (
              <ul className="min-h-0 overflow-y-auto">
                {shown.map((n) => {
                  const s = SEV[n.severity];
                  const Icon = n.state === 'resolved' ? CircleCheck : s.icon;
                  const c = n.companyId ? company(n.companyId) : undefined;
                  return (
                    <li key={n.id} className="border-b border-divider last:border-0">
                      <Link
                        to={n.to}
                        search={n.search as never}
                        onClick={() => {
                          setRead(new Set(read).add(n.id));
                          setOpen(false);
                        }}
                        className={cn(
                          'flex gap-3 px-4 py-3 hover:bg-hover',
                          n.state === 'unread' && 'bg-[#f8fafc]',
                        )}
                      >
                        <Icon
                          className={cn(
                            'mt-0.5 size-4 shrink-0',
                            n.state === 'resolved' ? 'text-success' : s.tone,
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              'block text-13',
                              n.state === 'unread' ? 'font-semibold' : 'font-medium text-ink-muted',
                            )}
                          >
                            <span className="sr-only">
                              {n.state === 'resolved' ? 'Resolved' : s.label}:{' '}
                            </span>
                            {n.title}
                          </span>
                          <span className="mt-0.5 block text-xs text-ink-muted">{n.detail}</span>
                          <span className="num mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                            {when(n.at)}
                            {c && (
                              <span className="flex items-center gap-1">
                                <CompanySwatch company={c} /> {c.tradingName}
                              </span>
                            )}
                            {n.signal && <SignalLabel signal={n.signal} />}
                            {n.state === 'resolved' && <span>Resolved itself</span>}
                          </span>
                        </span>
                        {n.state === 'unread' && (
                          <span
                            className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600"
                            aria-label="Unread"
                          />
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="shrink-0 border-t border-divider px-4 py-2.5 text-xs text-ink-muted">
              Critical alerts are also emailed.{' '}
              {session?.user.isAdmin && (
                <Link
                  to="/settings"
                  search={{ section: 'notifications' }}
                  onClick={() => {
                    setOpen(false);
                  }}
                  className="font-medium text-brand-600 hover:underline"
                >
                  Email settings
                </Link>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
