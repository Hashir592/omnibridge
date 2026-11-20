import { useCompanyNames } from '../app/companies.ts';
import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bell, CircleAlert, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { useMarkAllRead, useMarkRead, useUnreadCount } from '../app/notifications.ts';
import { useAppState } from '../app/session.tsx';
import { notificationApi } from '../auth/api.ts';
import { cn } from '../lib/cn.ts';
import { NotificationRow } from './NotificationRow.tsx';

/** The popover shows the newest ones; the centre page (see all) has filters and every page. */
const POPOVER_LIMIT = 20;

/**
 * The bell and its popover (section 6, NTF-1). The number comes from the server's unread count.
 * Opening a notification marks it read and goes to the record; the server resolves it when its
 * condition clears.
 */
export function NotificationBell() {
  const { session, persona } = useAppState();
  const companyName = useCompanyNames();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'all' | 'unread'>('all');
  const count = useUnreadCount();
  const unread = count.data ?? 0;
  const list = useQuery({
    queryKey: ['notifications', persona, 'popover', view],
    queryFn: () =>
      notificationApi.list(
        { state: view === 'unread' ? 'unread' : undefined },
        undefined,
        POPOVER_LIMIT,
      ),
    enabled: open && !!session,
  });
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const shown = list.data?.items ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="relative grid size-9 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
        aria-label={`Notifications, ${String(unread)} unread`}
      >
        <Bell className="size-[18px]" aria-hidden />
        {unread > 0 && (
          <span className="num absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand-700 px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-card">
            {unread > 99 ? '99+' : unread}
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
                  className="ml-auto text-xs font-medium text-brand-600 hover:underline disabled:opacity-50"
                  disabled={markAll.isPending}
                  onClick={() => {
                    markAll.mutate();
                  }}
                >
                  Mark all read
                </button>
              )}
            </div>
            <Popover.Description className="sr-only">
              Alerts for your tabs and companies, newest first.
            </Popover.Description>
            {list.isError ? (
              <div
                role="alert"
                className="flex flex-col items-center gap-1.5 px-6 py-10 text-center"
              >
                <CircleAlert className="size-5 text-danger" aria-hidden />
                <p className="text-13 text-ink-muted">Notifications could not be loaded.</p>
                <button
                  className="text-13 font-medium text-brand-600 hover:underline"
                  onClick={() => {
                    void list.refetch();
                  }}
                >
                  Try again
                </button>
              </div>
            ) : list.isPending ? (
              <p className="px-6 py-10 text-center text-13 text-ink-muted" aria-busy>
                Loading…
              </p>
            ) : shown.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
                <CircleCheck className="size-5 text-success" aria-hidden />
                <p className="text-13 text-ink-muted">
                  {view === 'unread'
                    ? 'Nothing unread. New alerts appear here as they happen.'
                    : 'No notifications yet. Alerts appear here as they happen.'}
                </p>
              </div>
            ) : (
              <ul className="min-h-0 overflow-y-auto">
                {shown.map((n) => (
                  <li key={n.id} className="border-b border-divider last:border-0">
                    <NotificationRow
                      n={n}
                      company={companyName(n.companyId)}
                      onOpen={() => {
                        if (n.state === 'unread') markRead.mutate(n.id);
                        setOpen(false);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider px-4 py-2.5 text-xs text-ink-muted">
              <span>Critical alerts are also emailed.</span>
              <Link
                to="/notifications"
                onClick={() => {
                  setOpen(false);
                }}
                className="ml-auto font-medium text-brand-600 hover:underline"
              >
                All notifications
              </Link>
              <Link
                to="/notifications"
                search={{ view: 'email' }}
                onClick={() => {
                  setOpen(false);
                }}
                className="font-medium text-brand-600 hover:underline"
              >
                Email settings
              </Link>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
