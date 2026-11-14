import { useQuery } from '@tanstack/react-query';
import {
  Check,
  CircleCheck,
  Copy,
  CirclePause,
  CircleSlash,
  KeyRound,
  OctagonAlert,
  Plus,
  TriangleAlert,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanySwatch } from '../components/badges.tsx';
import { Card, DetailRow, PageHeader } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { StatusLabel, type StatusTone } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { ConfirmDialog } from '../kit/Dialog.tsx';
import { ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatInt, formatTime } from '../lib/format.ts';
import type { Connection, ConnectionStatus } from '../mocks/admin.ts';
import { mockApi } from '../mocks/api.ts';

const STATUS: Record<ConnectionStatus, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  active: { label: 'Active', tone: 'success', icon: CircleCheck },
  needs_reauth: { label: 'Needs re-authorisation', tone: 'danger', icon: KeyRound },
  paused: { label: 'Paused', tone: 'neutral', icon: CirclePause },
  error: { label: 'Error', tone: 'danger', icon: OctagonAlert },
  disconnected: { label: 'Disconnected', tone: 'neutral', icon: CircleSlash },
};

function when(iso: string | null): string {
  if (!iso) return 'Never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${String(Math.max(1, mins))} min ago`;
  const d = Math.floor(mins / 1440);
  return d === 0
    ? `Today, ${formatTime(iso)}`
    : d === 1
      ? `Yesterday, ${formatTime(iso)}`
      : formatDate(iso);
}

export function ConnectionsPage() {
  return (
    <TabGate tab="admin">
      <Connections />
    </TabGate>
  );
}

function Connections() {
  const { session, persona } = useAppState();
  const q = useQuery({
    queryKey: ['connections', persona],
    queryFn: mockApi.connections,
    enabled: !!session,
  });
  const groups: Array<[string, Connection[]]> = [
    ['Sales channels', (q.data ?? []).filter((c) => c.kind === 'channel')],
    ['Advertising', (q.data ?? []).filter((c) => c.kind === 'ads')],
    ['Carriers', (q.data ?? []).filter((c) => c.kind === 'carrier')],
  ];
  const problems = (q.data ?? []).filter(
    (c) => c.status === 'needs_reauth' || c.status === 'error',
  ).length;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Connections"
          sub={
            q.data &&
            (problems > 0
              ? `${String(problems)} connection${problems === 1 ? '' : 's'} need${problems === 1 ? 's' : ''} attention`
              : 'Every connection is working')
          }
          actions={
            <Button variant="primary" icon={<Plus />}>
              Connect account
            </Button>
          }
        />
        {q.isError ? (
          <Card className="mt-5">
            <ErrorState
              title="Connections could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: () => void q.refetch() }}
            />
          </Card>
        ) : !q.data ? (
          <div aria-busy className="mt-5 h-96" />
        ) : (
          groups.map(([title, list]) =>
            list.length === 0 ? null : (
              <section key={title} className="mt-6">
                <h2 className="mb-3 text-sm font-semibold">{title}</h2>
                <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
                  {list.map((c) => (
                    <ConnectionCard key={c.id} c={c} />
                  ))}
                </div>
              </section>
            ),
          )
        )}
      </div>
    </div>
  );
}

function ConnectionCard({ c }: { c: Connection }) {
  const { company } = useAppState();
  const toast = useToast();
  const [kill, setKill] = useState(c.killSwitch);
  const [asking, setAsking] = useState(false);
  const co = c.companyId ? company(c.companyId) : undefined;
  const s = STATUS[c.status];
  const usagePct =
    c.usage && c.usage.limit > 0 ? Math.round((c.usage.used / c.usage.limit) * 100) : null;

  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          {c.channel ? (
            <span className="inline-grid shrink-0 grid-cols-[18px] [&>span:last-child]:sr-only">
              <ChannelMark channel={c.channel} />
            </span>
          ) : (
            <Truck className="size-4 text-ink-muted" aria-hidden />
          )}
          <span className="truncate">{c.name}</span>
        </span>
      }
      aside={
        <StatusLabel tone={s.tone} icon={s.icon}>
          {s.label}
        </StatusLabel>
      }
    >
      <div className="px-5 pt-1 pb-2">
        <div className="flex items-center gap-2 py-2 text-xs text-ink-muted">
          <span>{c.provider}</span>
          <span aria-hidden>·</span>
          {co ? (
            <span className="flex items-center gap-1.5">
              <CompanySwatch company={co} />
              {co.tradingName}
            </span>
          ) : (
            <span>All companies</span>
          )}
        </div>
        {c.note && (
          <p
            className={cn(
              'mb-2 flex items-start gap-2 text-13',
              c.status === 'needs_reauth' || c.status === 'error'
                ? 'text-danger'
                : c.status === 'paused'
                  ? 'text-ink-muted'
                  : 'text-warning',
            )}
          >
            {c.status === 'paused' ? (
              <CirclePause className="mt-0.5 size-4 shrink-0" aria-hidden />
            ) : (
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            )}
            <span className="text-ink">{c.note}</span>
          </p>
        )}
        <dl>
          <DetailRow label="Last successful call">
            <span className="num">{when(c.lastSuccessAt)}</span>
          </DetailRow>
          <DetailRow label="Last token refresh">
            <span className="num">{when(c.lastRefreshAt)}</span>
          </DetailRow>
          <DetailRow label="Auth failures in a row">
            <span className={cn('num', c.authFailures > 0 && 'font-medium text-danger')}>
              {formatInt(c.authFailures)}
            </span>
          </DetailRow>
          <DetailRow label="API usage today">
            {c.usage ? (
              <span className="flex flex-col items-end gap-1">
                <span className="num">
                  {formatInt(c.usage.used)}{' '}
                  {usagePct !== null ? `of ${formatInt(c.usage.limit)}` : ''} {c.usage.unit}
                </span>
                {usagePct !== null && (
                  <span
                    className="h-1 w-32 overflow-hidden rounded-full bg-[#e2e5ea]"
                    role="meter"
                    aria-valuenow={usagePct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${String(usagePct)}% of the daily limit used`}
                  >
                    <span
                      className={cn(
                        'block h-full rounded-full',
                        usagePct >= 80 ? 'bg-warning' : 'bg-brand-600',
                      )}
                      style={{ width: `${String(Math.min(usagePct, 100))}%` }}
                    />
                  </span>
                )}
              </span>
            ) : (
              <span className="text-ink-muted">Reports only</span>
            )}
          </DetailRow>
          <DetailRow label="Kill switch">
            <label className="flex items-center justify-end gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={kill}
                onChange={(e) => {
                  if (e.target.checked) setAsking(true);
                  else {
                    setKill(false);
                    toast({ title: 'Writes resumed', description: c.name, tone: 'success' });
                  }
                }}
              />
              <span className={cn(kill && 'font-medium text-danger')}>
                {kill ? 'On: no writes are sent' : 'Off'}
              </span>
            </label>
          </DetailRow>
        </dl>
      </div>
      {c.buyerMessages && <BuyerMessages id={c.id} setup={c.buyerMessages} />}
      <div className="flex flex-wrap justify-end gap-2 border-t border-divider px-5 py-3">
        {c.status === 'needs_reauth' ? (
          <Button size="sm" variant="primary" icon={<KeyRound />}>
            Re-authorise
          </Button>
        ) : c.status === 'paused' ? (
          <Button size="sm">Resume</Button>
        ) : (
          <Button size="sm">Pause</Button>
        )}
        <Button size="sm" variant="danger">
          Disconnect
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive
        title={`Stop all writes to ${c.name}?`}
        description="Labels, stock updates, tracking and replies for this account stop at once and wait in the queue. Reading orders continues. Turn it off to send what is waiting."
        confirmLabel="Turn on kill switch"
        onConfirm={() => {
          setKill(true);
        }}
      />
    </Card>
  );
}

/**
 * C6 (CS-6): Amazon copies buyer messages to the account's own inbound address, and replies go
 * from the approved sender. The seller sets both up in Seller Central; "Send test" checks it.
 */
function BuyerMessages({
  id,
  setup,
}: {
  id: string;
  setup: NonNullable<Connection['buyerMessages']>;
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    setup.lastTest === 'passed'
      ? { ok: true, text: 'Last test passed: buyer messages are arriving.' }
      : setup.lastTest === 'failed'
        ? { ok: false, text: 'Last test failed: no test message arrived. Check step 1.' }
        : null,
  );
  const [busy, setBusy] = useState(false);
  return (
    <section
      aria-label="Buyer messages setup"
      className="border-t border-divider px-5 py-4 text-13"
    >
      <h3 className="text-sm font-semibold">Buyer messages</h3>
      <p className="mt-1 text-ink-muted">
        Read and answer Amazon buyer messages in Customer Service.
      </p>
      <ol className="mt-3 flex list-decimal flex-col gap-2.5 pl-5">
        <li>
          In Seller Central, open Settings, Notification preferences, Messaging. Under Buyer
          Messages, add this address:
          <span className="mt-1 flex items-center gap-1.5">
            <code className="ref min-w-0 truncate rounded-[6px] bg-rail px-2 py-1 text-xs">
              {setup.inbound}
            </code>
            <CopyText value={setup.inbound} label="Copy inbound address" />
          </span>
        </li>
        <li>
          On the Messaging Permissions page, add an approved sender:
          <span className="mt-1 flex items-center gap-1.5">
            <code className="ref rounded-[6px] bg-rail px-2 py-1 text-xs">{setup.sender}</code>
            <CopyText value={setup.sender} label="Copy approved sender" />
          </span>
        </li>
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void mockApi.testBuyerMessages(id).then((r) => {
              setBusy(false);
              const body = r.body as
                { ok?: boolean; receivedAt?: string; detail?: string } | undefined;
              setResult(
                body?.ok
                  ? {
                      ok: true,
                      text: `Test received at ${formatTime(body.receivedAt ?? new Date().toISOString())}. Buyer messages are arriving.`,
                    }
                  : { ok: false, text: body?.detail ?? 'The test could not run. Try again.' },
              );
            });
          }}
        >
          {busy ? 'Sending test…' : 'Send test'}
        </Button>
        {result && (
          <span role="status">
            <StatusLabel tone={result.ok ? 'success' : 'danger'}>{result.text}</StatusLabel>
          </span>
        )}
      </div>
    </section>
  );
}

function CopyText({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => {
        if ('clipboard' in navigator) void navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => {
          setDone(false);
        }, 1500);
      }}
      className="grid size-7 shrink-0 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink"
    >
      {done ? (
        <Check className="size-4 text-success" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
    </button>
  );
}
