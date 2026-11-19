import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { CheckCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useMarkAllRead, useMarkRead } from '../app/notifications.ts';
import { useAppState } from '../app/session.tsx';
import { notificationApi, type Notification } from '../auth/api.ts';
import { Card, PageHeader } from '../components/Card.tsx';
import { EmailPreferences } from '../components/EmailPreferences.tsx';
import { NotificationRow } from '../components/NotificationRow.tsx';
import { Button } from '../kit/Button.tsx';
import { Select } from '../kit/Select.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { Tabs } from '../kit/Tabs.tsx';

export interface NotificationsSearch {
  view?: 'email' | undefined;
  state?: Notification['state'] | undefined;
  severity?: Notification['severity'] | undefined;
}

type View = 'list' | 'email';

const STATE_OPTIONS = [
  { value: 'all', label: 'Any state' },
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
  { value: 'resolved', label: 'Resolved' },
];
const SEVERITY_OPTIONS = [
  { value: 'all', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

/** A linked email opens the centre on its notification: look through this many pages for it. */
const FIND_PAGES = 10;

/**
 * The notification centre (NTF-1, NTF-4): every notification the signed-in user may see, with
 * state and severity filters in the URL, plus their email choices. `/notifications/<id>` is the
 * link in an email: it marks that notification read and shows it highlighted. Every member has this
 * page, whatever tabs they have ticked.
 */
export function NotificationsPage() {
  const search: NotificationsSearch = useSearch({ strict: false });
  const { notificationId }: { notificationId?: string | undefined } = useParams({ strict: false });
  const navigate = useNavigate();
  const view: View = search.view === 'email' ? 'email' : 'list';
  const go = (next: NotificationsSearch) => {
    void navigate({ to: '/notifications', search: next, replace: true });
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader title="Notifications" sub="Alerts for your tabs and companies" />
        <div className="mt-3">
          <Tabs<View>
            label="Notification sections"
            value={view}
            onChange={(v) => {
              go(v === 'email' ? { view: 'email' } : {});
            }}
            items={[
              {
                value: 'list',
                label: 'Notifications',
                content: (
                  <Centre
                    state={search.state}
                    severity={search.severity}
                    focusId={notificationId}
                    onFilter={(f) => {
                      go({ ...(search.state ? { state: search.state } : {}), ...f });
                    }}
                  />
                ),
              },
              { value: 'email', label: 'Email', content: <EmailPreferences /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function Centre({
  state,
  severity,
  focusId,
  onFilter,
}: {
  state: Notification['state'] | undefined;
  severity: Notification['severity'] | undefined;
  focusId: string | undefined;
  onFilter: (f: NotificationsSearch) => void;
}) {
  const { persona, company } = useAppState();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const filter = { state, severity };
  const q = useInfiniteQuery({
    queryKey: ['notifications', persona, 'page', state ?? 'any', severity ?? 'any'],
    queryFn: ({ pageParam }) => notificationApi.list(filter, pageParam, 50),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const pages = q.data?.pages.length ?? 0;

  // The email link: read it once (the server answers 404 when this user may not see it).
  const opened = useRef<string>(undefined);
  const hidden = markRead.data?.status === 404;
  useEffect(() => {
    if (focusId === undefined || opened.current === focusId) return;
    opened.current = focusId;
    markRead.mutate(focusId);
  }, [focusId]);
  const found = focusId === undefined ? undefined : items.find((n) => n.id === focusId);
  useEffect(() => {
    if (focusId !== undefined && !found && q.hasNextPage && !q.isFetching && pages < FIND_PAGES)
      void q.fetchNextPage();
  }, [focusId, found, q, pages]);
  useEffect(() => {
    if (found) document.getElementById(`ntf-${found.id}`)?.scrollIntoView({ block: 'center' });
  }, [found]);
  const gone =
    focusId !== undefined &&
    !found &&
    (hidden || (!q.isFetching && (!q.hasNextPage || pages >= FIND_PAGES)) || q.isError);
  const unread = items.some((n) => n.state === 'unread');

  return (
    <Card
      title="Newest first"
      aside={
        <>
          <Select
            label="State"
            className="w-36"
            options={STATE_OPTIONS}
            value={state ?? 'all'}
            onChange={(v) => {
              onFilter({
                ...(severity ? { severity } : {}),
                ...(v && v !== 'all' ? { state: v as Notification['state'] } : {}),
              });
            }}
          />
          <Select
            label="Severity"
            className="w-40"
            options={SEVERITY_OPTIONS}
            value={severity ?? 'all'}
            onChange={(v) => {
              onFilter({
                ...(state ? { state } : {}),
                ...(v && v !== 'all' ? { severity: v as Notification['severity'] } : {}),
              });
            }}
          />
          <Button
            size="sm"
            icon={<CheckCheck />}
            disabled={!unread || markAll.isPending}
            onClick={() => {
              markAll.mutate();
            }}
          >
            Mark all read
          </Button>
        </>
      }
    >
      {gone && (
        <p role="status" className="border-b border-divider px-5 py-3 text-13 text-ink-muted">
          That notification is no longer available to you. Here are the others.
        </p>
      )}
      {q.isError ? (
        <ErrorState
          title="Notifications could not be loaded"
          body="Check your connection and try again."
          action={{
            label: 'Try again',
            onClick: () => {
              void q.refetch();
            },
          }}
        />
      ) : q.isPending ? (
        <p className="px-5 py-10 text-13 text-ink-muted" aria-busy>
          Loading…
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          title={state || severity ? 'Nothing matches these filters' : 'No notifications yet'}
          body={
            state || severity
              ? 'Clear a filter to see more.'
              : 'Alerts for your tabs and companies appear here as they happen.'
          }
        />
      ) : (
        <>
          <ul>
            {items.map((n) => (
              <li key={n.id} id={`ntf-${n.id}`} className="border-b border-divider last:border-0">
                <NotificationRow
                  n={n}
                  highlighted={n.id === focusId}
                  company={n.companyId ? company(n.companyId) : undefined}
                  onOpen={() => {
                    if (n.state === 'unread') markRead.mutate(n.id);
                  }}
                />
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <div className="border-t border-divider px-5 py-3">
              <Button
                size="sm"
                disabled={q.isFetchingNextPage}
                onClick={() => {
                  void q.fetchNextPage();
                }}
              >
                {q.isFetchingNextPage ? 'Loading…' : 'Show more'}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
