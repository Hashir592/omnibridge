import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Archive, CircleCheck, Clock, Eye, Mail, MailOpen, Send, Star } from 'lucide-react';
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

export type CsSection = 'messages' | 'amazon' | 'feedback' | 'reviews';

export interface CsSearch {
  section?: CsSection | undefined;
  view?: 'unread' | 'archived' | 'done' | undefined;
  account?: string | undefined;
  /** C6: which Amazon account's inbox. */
  amz?: string | undefined;
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
              { value: 'amazon', label: 'Amazon messages', content: <AmazonMessages /> },
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
  const view = search.view === 'unread' || search.view === 'archived' ? search.view : 'open';
  const q = useQuery({
    queryKey: ['conversations', persona, companyId, view, search.account],
    // Keep what is on screen while the next answer loads, so an action never flashes empty.
    placeholderData: keepPreviousData,
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
        <ThreadActions channel="ebay" id={c.id} unread={c.unread > 0} state={c.state} />
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

/* ---------- thread actions: read, unread, archive (eBay) or done (Amazon) ---------- */

/** Threads the user marked unread in this visit, so opening them does not mark them read again. */
const markedUnread = new Set<string>();

function ThreadActions({
  channel,
  id,
  unread,
  state,
}: {
  channel: 'ebay' | 'amazon';
  id: string;
  unread: boolean;
  state: 'open' | 'archived' | 'done';
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (
    patch: { unread?: boolean; state?: 'open' | 'archived' | 'done' },
    done?: string,
  ) => {
    setBusy(true);
    const r = await mockApi.patchConversation(channel, id, patch);
    setBusy(false);
    if (!r.ok) {
      toast({ title: 'That did not save. Try again.', tone: 'error' });
      return;
    }
    if (patch.unread === true) markedUnread.add(id);
    if (patch.unread === false) markedUnread.delete(id);
    const keys =
      channel === 'amazon' ? ['amazon-inbox', 'amazon-thread'] : ['conversations', 'thread'];
    await Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
    if (done) toast({ title: done, tone: 'success' });
  };
  // Opening a thread marks it read (CS-1, CS-6), unless the user just marked it unread.
  useEffect(() => {
    if (unread && !markedUnread.has(id)) void act({ unread: false });
  }, [id, unread]);

  const closed = state !== 'open';
  return (
    <div className="ml-auto flex gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        icon={unread ? <MailOpen /> : <Mail />}
        onClick={() => void act({ unread: !unread }, unread ? 'Marked read' : 'Marked unread')}
      >
        {unread ? 'Mark read' : 'Mark unread'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        icon={channel === 'amazon' ? <CircleCheck /> : <Archive />}
        onClick={() =>
          void act(
            { state: closed ? 'open' : channel === 'amazon' ? 'done' : 'archived' },
            closed ? 'Moved to the inbox' : channel === 'amazon' ? 'Marked done' : 'Archived',
          )
        }
      >
        {closed ? 'Move to inbox' : channel === 'amazon' ? 'Mark done' : 'Archive'}
      </Button>
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
          className={cn('size-3.5', i <= n ? 'fill-[#FFA41C] text-[#E47911]' : 'text-[#C9CED6]')}
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

/* ---------- Amazon buyer messages (client change C6, CS-6) ---------- */

const REPLY_LIMIT = 4000;

/** "Reply due in 5 h", from Amazon's 24-hour reply expectation. */
function ReplyDue({ at }: { at: string }) {
  const ms = Date.parse(at) - Date.now();
  const hours = Math.floor(ms / 3_600_000);
  if (ms <= 0)
    return (
      <StatusLabel tone="danger" icon={Clock}>
        Reply overdue
      </StatusLabel>
    );
  return (
    <StatusLabel tone={hours <= 6 ? 'warning' : 'neutral'} icon={Clock}>
      {hours < 1 ? 'Reply due in under 1 h' : `Reply due in ${String(hours)} h`}
    </StatusLabel>
  );
}

function AmazonMessages() {
  const { search, set } = useCsSearch();
  const { session, persona, companyId } = useAppState();
  const view = search.view === 'unread' || search.view === 'done' ? search.view : 'open';
  const q = useQuery({
    queryKey: ['amazon-inbox', persona, companyId, search.amz, view],
    // Keep what is on screen while the next answer loads, so an action never flashes empty.
    placeholderData: keepPreviousData,
    queryFn: () => mockApi.amazonInbox({ company: companyId, account: search.amz, view }),
    enabled: !!session,
  });
  const d = q.data;
  const items = d?.items ?? [];
  const selected = items.find((c) => c.id === search.c) ?? items[0];
  const name = (id: string) => session?.channelAccounts.find((a) => a.id === id)?.name ?? id;

  if (q.isError)
    return (
      <Card>
        <ErrorState
          title="Amazon messages could not load"
          body="The server did not answer. Try again; if it keeps failing, check Status."
          action={{ label: 'Try again', onClick: () => void q.refetch() }}
        />
      </Card>
    );
  if (d && d.accounts.length === 0)
    return (
      <Card>
        <EmptyState
          title="No Amazon accounts for this company"
          body="Buyer messages are read per Amazon account. Connect one in Connections, then set up Buyer messages there."
        />
      </Card>
    );

  return (
    <div className="flex flex-col gap-3">
      {d && d.accounts.length > 1 && (
        <ViewTabs
          label="Amazon account"
          value={d.account}
          onChange={(v) => {
            set({ amz: v, c: undefined });
          }}
          tabs={d.accounts.map((a) => ({
            id: a.channelAccountId,
            label: name(a.channelAccountId),
            count: a.unread,
          }))}
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <ViewTabs<'open' | 'unread' | 'done'>
          label="Message views"
          value={view}
          onChange={(v) => {
            set({ view: v === 'open' ? undefined : v, c: undefined });
          }}
          tabs={[
            { id: 'open', label: 'Inbox', count: d?.counts.open },
            { id: 'unread', label: 'Unread', count: d?.counts.unread },
            { id: 'done', label: 'Done', count: d?.counts.done },
          ]}
        />
        <span className="ml-auto text-xs text-ink-muted">
          Kept apart from eBay. Amazon expects a reply within 24 hours.
        </span>
      </div>
      <Card className="grid min-h-[600px] overflow-hidden lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="border-b border-divider lg:border-r lg:border-b-0">
          {!d ? (
            <div aria-busy className="h-64" />
          ) : items.length === 0 ? (
            <EmptyState
              title={view === 'done' ? 'Nothing marked done yet' : 'No buyer messages here'}
              body="Amazon copies each buyer message here within a few minutes of it being sent."
            />
          ) : (
            <ul aria-label="Amazon conversations" className="max-h-[600px] overflow-y-auto">
              {items.map((c) => {
                const active = c.id === selected?.id;
                return (
                  <li key={c.id} className="border-b border-divider last:border-0">
                    <button
                      onClick={() => {
                        set({ c: c.id });
                      }}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover',
                        active && 'bg-selected hover:bg-selected',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              'truncate text-13',
                              c.unread > 0 ? 'font-semibold' : 'font-medium',
                            )}
                          >
                            {c.topic}
                          </span>
                          <span className="num ml-auto shrink-0 text-xs text-ink-muted">
                            {when(c.lastAt)}
                          </span>
                        </span>
                        <span className="ref mt-0.5 block truncate text-xs text-ink-muted">
                          {c.order ? `Order ${c.order.ref}` : 'No order named'}
                        </span>
                        {c.replyDueAt && (
                          <span className="mt-1 block">
                            <ReplyDue at={c.replyDueAt} />
                          </span>
                        )}
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
              })}
            </ul>
          )}
        </div>
        {selected ? <AmazonThreadView id={selected.id} /> : <div className="hidden lg:block" />}
      </Card>
    </div>
  );
}

function AmazonThreadView({ id }: { id: string }) {
  const { session, persona } = useAppState();
  const toast = useToast();
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    setReply('');
    setError(undefined);
  }, [id]);
  const q = useQuery({
    queryKey: ['amazon-thread', id, persona],
    queryFn: () => mockApi.amazonThread(id),
    enabled: !!session,
    gcTime: 0, // holds buyer PII: drop it from memory as soon as the thread closes
  });
  const t = q.data;
  if (!t) return <div aria-busy className="h-64" />;
  const c = t.conversation;
  const over = reply.length > REPLY_LIMIT;

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-start gap-3 border-b border-divider px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{c.topic}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            <span>Buyer, through Amazon’s message relay</span>
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
            {c.replyDueAt && (
              <>
                <span aria-hidden>·</span>
                <ReplyDue at={c.replyDueAt} />
              </>
            )}
          </p>
        </div>
        <ThreadActions channel="amazon" id={c.id} unread={c.unread > 0} state={c.state} />
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
        <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-muted">
          <Eye className="size-3.5" aria-hidden /> Each view is logged. Message text is deleted 30
          days after the last activity ({formatDate(t.deleteAfter)}).
        </p>
        <Field
          label="Reply"
          hint="Plain text, sent through Amazon. Links are blocked except to your own website."
          error={
            error ??
            (over
              ? `Too long by ${(reply.length - REPLY_LIMIT).toLocaleString('en-GB')} characters`
              : undefined)
          }
        >
          <textarea
            aria-label="Reply"
            value={reply}
            onChange={(e) => {
              setReply(e.target.value);
              setError(undefined);
            }}
            rows={4}
            className="w-full rounded-ctl border border-border bg-card px-3 py-2 text-13 shadow-card outline-none focus:border-brand-600"
          />
        </Field>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span
            className={cn('num text-xs', over ? 'font-medium text-danger' : 'text-ink-muted')}
            aria-live="polite"
          >
            {reply.length.toLocaleString('en-GB')} / {REPLY_LIMIT.toLocaleString('en-GB')}{' '}
            characters
          </span>
          <Button
            variant="primary"
            icon={<Send />}
            disabled={over}
            onClick={() => {
              if (reply.trim() === '') {
                setError('Write a reply first');
                return;
              }
              setReply('');
              toast({
                title: 'Reply queued',
                description: 'It is emailed to Amazon’s relay within a minute.',
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
