import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Archive, Eye, Mail, MailOpen, Send, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { CompanySwatch } from '../components/badges.tsx';
import { Card, PageHeader, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { SignalLabel, StatusLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { Field } from '../kit/Field.tsx';
import { Select } from '../kit/Select.tsx';
import { Tabs } from '../kit/Tabs.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { ViewTabs } from '../kit/table/Toolbar.tsx';
import { cn } from '../lib/cn.ts';
import { daysFromToday, formatDate, formatDateTime, formatTime } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import { TEMPLATES, type Conversation, type Feedback } from '../mocks/inbox.ts';

export type CsSection = 'messages' | 'feedback' | 'reviews';

export interface CsSearch {
  section?: CsSection | undefined;
  view?: 'unread' | 'archived' | undefined;
  account?: string | undefined;
  c?: string | undefined;
}

const route = getRouteApi('/customer-service');

const when = (iso: string) => {
  const d = daysFromToday(iso);
  return d === 0 ? formatTime(iso) : d === -1 ? 'Yesterday' : formatDate(iso);
};

export function CustomerServicePage() {
  return (
    <TabGate tab="customer_service">
      <CustomerService />
    </TabGate>
  );
}

function useCsSearch() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/customer-service' });
  const set = (patch: Partial<CsSearch>) =>
    void navigate({ search: (prev: CsSearch) => ({ ...prev, ...patch }), replace: true });
  return { search, set };
}

function CustomerService() {
  const { search, set } = useCsSearch();
  const section = search.section ?? 'messages';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader title="Customer Service" />
        <div className="mt-3">
          <Tabs<CsSection>
            label="Customer Service sections"
            value={section}
            onChange={(v) => {
              set({ section: v === 'messages' ? undefined : v, c: undefined, view: undefined });
            }}
            items={[
              { value: 'messages', label: 'eBay messages', content: <Messages /> },
              { value: 'feedback', label: 'Feedback', content: <FeedbackSection /> },
              { value: 'reviews', label: 'Amazon review requests', content: <Reviews /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------- eBay messages (CS-1, CS-2) ---------- */

function Messages() {
  const { search, set } = useCsSearch();
  const { session, persona, companyId } = useAppState();
  const view = search.view ?? 'open';
  const q = useQuery({
    queryKey: ['conversations', persona, companyId, view, search.account],
    queryFn: () => mockApi.conversations({ company: companyId, view, account: search.account }),
    enabled: !!session,
  });
  const ebay = (session?.channelAccounts ?? []).filter((a) => a.channel === 'ebay');
  const items = q.data?.items ?? [];
  const selected = items.find((c) => c.id === search.c) ?? items[0];

  if (q.isError)
    return (
      <Card>
        <ErrorState
          title="Messages could not load"
          body="The server did not answer. Try again; if it keeps failing, check Status."
          action={{ label: 'Try again', onClick: () => void q.refetch() }}
        />
      </Card>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <ViewTabs<'open' | 'unread' | 'archived'>
          label="Message views"
          value={view}
          onChange={(v) => {
            set({ view: v === 'open' ? undefined : v, c: undefined });
          }}
          tabs={[
            { id: 'open', label: 'Inbox', count: q.data?.counts.open },
            { id: 'unread', label: 'Unread', count: q.data?.counts.unread },
            { id: 'archived', label: 'Archived', count: q.data?.counts.archived },
          ]}
        />
        <div className="ml-auto w-64">
          <Select
            label="eBay account"
            options={[
              { value: 'all', label: 'All eBay accounts' },
              ...ebay.map((a) => ({ value: a.id, label: a.name })),
            ]}
            value={search.account ?? 'all'}
            onChange={(v) => {
              set({ account: v === 'all' || v === null ? undefined : v, c: undefined });
            }}
          />
        </div>
      </div>
      <Card className="grid min-h-[620px] overflow-hidden lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="border-b border-divider lg:border-r lg:border-b-0">
          {!q.data ? (
            <div aria-busy className="h-64" />
          ) : items.length === 0 ? (
            <EmptyState
              title={view === 'unread' ? 'No unread messages' : 'No conversations here'}
              body="New eBay messages arrive here within a few minutes. Nothing needs a reply right now."
            />
          ) : (
            <ul aria-label="Conversations" className="max-h-[620px] overflow-y-auto">
              {items.map((c) => (
                <ConversationRow
                  key={c.id}
                  c={c}
                  active={c.id === selected?.id}
                  onOpen={() => {
                    set({ c: c.id });
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        {selected ? <ThreadView id={selected.id} /> : <div className="hidden lg:block" />}
      </Card>
    </div>
  );
}

function ConversationRow({
  c,
  active,
  onOpen,
}: {
  c: Conversation;
  active: boolean;
  onOpen: () => void;
}) {
  const { session } = useAppState();
  const account = session?.channelAccounts.find((a) => a.id === c.channelAccountId);
  return (
    <li className="border-b border-divider last:border-0">
      <button
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover',
          active && 'bg-selected hover:bg-selected',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className={cn('truncate text-13', c.unread > 0 ? 'font-semibold' : 'font-medium')}
            >
              {c.topic}
            </span>
            <span className="num ml-auto shrink-0 text-xs text-ink-muted">{when(c.lastAt)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
            <span className="ref">{c.buyerMasked}</span>
            {c.order && <span className="ref truncate">· {c.order.ref}</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-muted">{account?.name}</span>
        </span>
        {c.unread > 0 && (
          <span
            className="num mt-0.5 rounded-full bg-side px-1.5 text-[11px] leading-[18px] font-medium text-white"
            aria-label={`${String(c.unread)} unread`}
          >
            {c.unread}
          </span>
        )}
      </button>
    </li>
  );
}

function ThreadView({ id }: { id: string }) {
  const { session, persona } = useAppState();
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [template, setTemplate] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setReply('');
    setTemplate(null);
    setError(undefined);
  }, [id]);
  const q = useQuery({
    queryKey: ['thread', id, persona],
    queryFn: () => mockApi.thread(id),
    enabled: !!session,
    gcTime: 0, // holds buyer PII: drop it from memory as soon as the thread closes
  });
  const t = q.data;
  if (!t) return <div aria-busy className="h-64" />;
  const c = t.conversation;
  const account = session?.channelAccounts.find((a) => a.id === c.channelAccountId);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-start gap-3 border-b border-divider px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{c.topic}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
            <span className="ref">{c.buyerMasked}</span>
            <span aria-hidden>·</span>
            {account?.name}
            {c.order && (
              <>
                <span aria-hidden>·</span>
                <Link
                  to="/orders/$orderId"
                  params={{ orderId: c.order.id }}
                  className="ref text-brand-600 hover:underline"
                >
                  Order {c.order.ref}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" icon={<Mail />}>
            Mark unread
          </Button>
          <Button size="sm" variant="ghost" icon={<Archive />}>
            Archive
          </Button>
        </div>
      </div>
      <ol aria-label="Messages" className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {t.messages.map((m) => (
          <li
            key={m.id}
            className={cn(
              'max-w-[80%] rounded-card border px-4 py-2.5 text-13',
              m.from === 'buyer'
                ? 'self-start border-border bg-rail'
                : 'self-end border-[#c3c8d0] bg-selected',
            )}
          >
            <p className="mb-1 text-xs text-ink-muted">
              {m.from === 'buyer' ? 'Buyer' : `You (${m.by ?? ''})`} ·{' '}
              <span className="num">{formatDateTime(m.at)}</span>
            </p>
            <p className="whitespace-pre-line">{m.text}</p>
          </li>
        ))}
      </ol>
      <div className="border-t border-divider px-5 py-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="w-60">
            <Select
              label="Saved reply"
              placeholder="Insert a saved reply"
              options={TEMPLATES.map((x) => ({ value: x.id, label: x.name }))}
              value={template}
              onChange={(v) => {
                setTemplate(v);
                const tpl = TEMPLATES.find((x) => x.id === v);
                if (tpl) setReply(tpl.text);
              }}
            />
          </div>
          <span className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Eye className="size-3.5" aria-hidden /> Each view is logged. Message text is deleted 30
            days after the last activity ({formatDate(t.deleteAfter)}).
          </span>
        </div>
        <Field label="Reply" hint="Plain text, sent to the buyer through eBay" error={error}>
          <textarea
            aria-label="Reply"
            value={reply}
            onChange={(e) => {
              setReply(e.target.value);
            }}
            rows={3}
            className="w-full rounded-ctl border border-border bg-card px-3 py-2 text-13 shadow-card outline-none focus:border-brand-600"
          />
        </Field>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            icon={<Send />}
            onClick={() => {
              if (reply.trim() === '') {
                setError('Write a reply first');
                return;
              }
              setError(undefined);
              setReply('');
              toast({
                title: 'Reply queued',
                description: 'It is sent to eBay within a minute.',
                tone: 'success',
              });
            }}
          >
            Send reply
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---------- feedback (CS-3, CS-4) ---------- */

function Stars({ n }: { n: number }) {
  return (
    <span
      role="img"
      className="flex items-center gap-0.5"
      aria-label={`${String(n)} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          aria-hidden
          className={cn('size-3.5', i <= n ? 'fill-ink text-ink' : 'text-ink-faint')}
        />
      ))}
    </span>
  );
}

function Rating({ f }: { f: Feedback }) {
  if (typeof f.rating === 'number')
    return (
      <span className="flex flex-col gap-1">
        <Stars n={f.rating} />
        {f.rating <= 3 && <StatusLabel tone="warning">Needs a look</StatusLabel>}
      </span>
    );
  if (f.rating === 'positive') return <StatusLabel tone="success">Positive</StatusLabel>;
  if (f.rating === 'neutral') return <StatusLabel tone="warning">Neutral</StatusLabel>;
  return <StatusLabel tone="danger">Negative</StatusLabel>;
}

function FeedbackSection() {
  const { session, persona, companyId } = useAppState();
  const q = useQuery({
    queryKey: ['feedback', persona, companyId],
    queryFn: () => mockApi.feedback(companyId),
    enabled: !!session,
  });
  if (!q.data) return <div aria-busy className="h-64" />;
  const ebay = q.data.items.filter((f) => f.channel === 'ebay');
  const amazon = q.data.items.filter((f) => f.channel === 'amazon');
  return (
    <div className="flex flex-col gap-5">
      {q.data.ebaySummary.length > 0 && (
        <Card title="eBay feedback received" aside={<SignalLabel signal="Native" />}>
          <SimpleTable
            label="eBay feedback counts"
            head={[
              { label: 'Account' },
              { label: 'Period' },
              { label: 'Positive', align: 'right' },
              { label: 'Neutral', align: 'right' },
              { label: 'Negative', align: 'right' },
            ]}
          >
            {q.data.ebaySummary.flatMap((s) =>
              s.counts.map((c, i) => (
                <Tr key={`${s.channelAccountId}-${c.period}`}>
                  <Td>
                    {i === 0
                      ? session?.channelAccounts.find((a) => a.id === s.channelAccountId)?.name
                      : ''}
                  </Td>
                  <Td>{c.period}</Td>
                  <Td align="right">{c.positive}</Td>
                  <Td align="right">{c.neutral}</Td>
                  <Td align="right">{c.negative}</Td>
                </Tr>
              )),
            )}
          </SimpleTable>
        </Card>
      )}
      <FeedbackList title="Latest eBay feedback" items={ebay} canReply />
      <FeedbackList
        title="Latest Amazon feedback"
        items={amazon}
        note="Amazon has no reply API, so this list is display only."
      />
    </div>
  );
}

function FeedbackList({
  title,
  items,
  canReply,
  note,
}: {
  title: string;
  items: Feedback[];
  canReply?: boolean;
  note?: string;
}) {
  const { session } = useAppState();
  return (
    <Card title={title} aside={note && <span className="text-xs text-ink-muted">{note}</span>}>
      {items.length === 0 ? (
        <EmptyState title="No feedback yet" body="New feedback appears here the day it is left." />
      ) : (
        <SimpleTable
          label={title}
          head={[
            { label: 'Rating' },
            { label: 'Comment' },
            { label: 'Account and order' },
            { label: 'Left' },
            { label: canReply ? 'Reply' : '' },
          ]}
        >
          {items.map((f) => (
            <Tr key={f.id}>
              <Td className="w-36">
                <Rating f={f} />
              </Td>
              <Td className="max-w-[360px]">
                <Stack value={f.comment} sub={f.reply ? `Your reply: ${f.reply}` : undefined} />
              </Td>
              <Td>
                <Stack
                  value={session?.channelAccounts.find((a) => a.id === f.channelAccountId)?.name}
                  sub={
                    f.order && (
                      <Link
                        to="/orders/$orderId"
                        params={{ orderId: f.order.id }}
                        className="ref text-brand-600 hover:underline"
                      >
                        {f.order.ref}
                      </Link>
                    )
                  }
                />
              </Td>
              <Td className="num whitespace-nowrap text-ink-muted">{when(f.at)}</Td>
              <Td>
                {canReply && !f.reply && (
                  <Button size="sm" icon={<MailOpen />}>
                    Reply
                  </Button>
                )}
              </Td>
            </Tr>
          ))}
        </SimpleTable>
      )}
    </Card>
  );
}

/* ---------- Amazon review requests (CS-5) ---------- */

function Reviews() {
  const { session, persona, companyId, company } = useAppState();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['reviews', persona, companyId],
    queryFn: () => mockApi.reviewRequests(companyId),
    enabled: !!session,
  });
  const [on, setOn] = useState<Record<string, boolean>>({});
  if (!q.data) return <div aria-busy className="h-64" />;
  if (q.data.accounts.length === 0)
    return (
      <Card>
        <EmptyState
          title="No Amazon accounts for this company"
          body="Review requests are sent per Amazon account. Connect one in Connections."
        />
      </Card>
    );
  return (
    <div className="flex flex-col gap-5">
      <Card title="Daily review requests">
        <ul>
          {q.data.accounts.map((a) => {
            const acct = session?.channelAccounts.find((x) => x.id === a.channelAccountId);
            const co = acct ? company(acct.companyId) : undefined;
            const checked = on[a.channelAccountId] ?? a.on;
            return (
              <li
                key={a.channelAccountId}
                className="flex flex-wrap items-center gap-4 border-b border-divider px-5 py-3.5 last:border-0"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2 text-13 font-medium">
                  {co && <CompanySwatch company={co} />}
                  {acct?.name}
                </span>
                <span className="num text-13 text-ink-muted">
                  {a.sent30} sent, {a.notEligible30} not eligible in 30 days
                </span>
                <label className="flex items-center gap-2 text-13">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={checked}
                    onChange={(e) => {
                      setOn({ ...on, [a.channelAccountId]: e.target.checked });
                      toast({
                        title: e.target.checked ? 'Review requests on' : 'Review requests off',
                        description: acct?.name ?? '',
                        tone: 'success',
                      });
                    }}
                  />
                  {checked ? 'On' : 'Off'}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
          Each order gets at most one request, ever: between 5 days after the earliest delivery date
          and 30 days after the latest. Cancelled and refunded orders are skipped. Only order IDs
          are used, never customer details.
        </p>
      </Card>
      <Card title="Last requests">
        <SimpleTable
          label="Last review requests"
          head={[{ label: 'Order' }, { label: 'When' }, { label: 'Result' }]}
        >
          {q.data.recent.map((x) => (
            <Tr key={x.id}>
              <Td>
                <Link
                  to="/orders/$orderId"
                  params={{ orderId: x.order.id }}
                  className="ref font-medium text-ink hover:text-brand-600 hover:underline"
                >
                  {x.order.ref}
                </Link>
              </Td>
              <Td className="num text-ink-muted">{formatDateTime(x.at)}</Td>
              <Td>
                {x.result === 'sent' ? (
                  <StatusLabel tone="success">Sent</StatusLabel>
                ) : x.result === 'not_eligible' ? (
                  <StatusLabel tone="neutral">Not eligible</StatusLabel>
                ) : (
                  <StatusLabel tone="warning">Error, retried tomorrow</StatusLabel>
                )}
              </Td>
            </Tr>
          ))}
        </SimpleTable>
      </Card>
    </div>
  );
}
