import {
  CircleCheck,
  CirclePause,
  CircleSlash,
  KeyRound,
  OctagonAlert,
  PanelRight,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Connection, ConnectionDetail, ConnectionStatus } from '../../auth/api.ts';
import type { CompanyName } from '../../app/companies.ts';
import { ChannelMark } from '../../components/badges.tsx';
import { PausedLine } from '../../components/PausedLine.tsx';
import { Card, DetailRow, SimpleTable, Td, Tr } from '../../components/Card.tsx';
import { StatusLabel, type StatusTone } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog } from '../../kit/Dialog.tsx';
import { cn } from '../../lib/cn.ts';
import { formatDate, formatDateTime, formatInt, formatTime } from '../../lib/format.ts';
import { PROVIDER_LABEL } from '../../lib/connections.ts';
import { canAuthorise, usageLine, usageShare } from './rules.ts';

export const STATUS: Record<
  ConnectionStatus,
  { label: string; tone: StatusTone; icon: LucideIcon }
> = {
  active: { label: 'Active', tone: 'success', icon: CircleCheck },
  needs_reauth: { label: 'Needs re-authorisation', tone: 'danger', icon: KeyRound },
  paused: { label: 'Paused', tone: 'danger', icon: CirclePause },
  error: { label: 'Error', tone: 'danger', icon: OctagonAlert },
  disconnected: { label: 'Disconnected', tone: 'neutral', icon: CircleSlash },
};

export function when(iso: string | null): string {
  if (!iso) return 'Never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins >= 0 && mins < 60) return `${String(Math.max(1, mins))} min ago`;
  const d = Math.floor(mins / 1440);
  return d === 0
    ? `Today, ${formatTime(iso)}`
    : d === 1
      ? `Yesterday, ${formatTime(iso)}`
      : formatDate(iso);
}

function CompanyLine({ company }: { company: CompanyName | undefined }) {
  if (!company) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: company.colour }}
      />
      {company.name}
    </span>
  );
}

function ProviderMark({ c }: { c: Connection }) {
  if (c.provider === 'evri' || c.provider === 'dpd') {
    return <Truck className="size-4 shrink-0 text-ink-muted" aria-hidden />;
  }
  const channel = c.provider === 'ebay' ? 'ebay' : c.provider === 'website' ? 'website' : 'amazon';
  return (
    <span className="inline-grid shrink-0 grid-cols-[18px] [&>span:last-child]:sr-only">
      <ChannelMark channel={channel} />
    </span>
  );
}

/** One account (INT-4): every field the PRD names, the kill switch, and its actions. */
export function ConnectionCard({
  c,
  company,
  onKill,
  onAuthorise,
  onDetails,
  busy,
  actions,
  children,
}: {
  c: Connection;
  company: CompanyName | undefined;
  onKill: (paused: boolean) => void;
  onAuthorise: () => void;
  onDetails: () => void;
  busy: boolean;
  /** More footer buttons, before Details. */
  actions?: ReactNode;
  /** Provider extras below the details, such as Amazon's buyer messages setup. */
  children?: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const s = STATUS[c.status];
  const paused = c.kill_switch.paused;

  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ProviderMark c={c} />
          <span className="truncate">{c.display_name}</span>
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
          <span>{PROVIDER_LABEL[c.provider]}</span>
          {company && <span aria-hidden>·</span>}
          <CompanyLine company={company} />
        </div>
        {paused && (
          <div className="mb-2">
            <PausedLine pausedAt={c.kill_switch.paused_at} />
          </div>
        )}
        {c.usage_today.some((u) => (usageShare(u) ?? 0) >= 80) && (
          <p className="mb-2">
            <StatusLabel tone="warning">
              Above 80% of a daily cap: non-urgent syncs slow down.
            </StatusLabel>
          </p>
        )}
        <dl>
          <DetailRow label="Last successful call">
            <span className="num">{when(c.last_success_at)}</span>
          </DetailRow>
          <DetailRow label="Last token refresh">
            <span className="num">{when(c.last_token_refresh_at)}</span>
          </DetailRow>
          <DetailRow label="Auth failures in a row">
            <span
              className={cn('num', c.consecutive_auth_failures > 0 && 'font-medium text-danger')}
            >
              {formatInt(c.consecutive_auth_failures)}
            </span>
          </DetailRow>
          <DetailRow label="API usage today">
            {c.usage_today.length === 0 ? (
              <span className="text-ink-muted">No calls yet</span>
            ) : (
              <span className="flex flex-col items-end gap-1.5">
                {c.usage_today.map((u) => (
                  <UsageMeter key={u.api} u={u} />
                ))}
              </span>
            )}
          </DetailRow>
          <DetailRow label="Kill switch">
            <label className="flex items-center justify-end gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={paused}
                disabled={busy}
                onChange={(e) => {
                  if (e.target.checked) setAsking(true);
                  else onKill(false);
                }}
              />
              <span className={cn(paused && 'font-medium text-danger')}>
                <span className="sr-only">Kill switch: </span>
                {paused ? 'On: writes wait' : 'Off'}
              </span>
            </label>
          </DetailRow>
        </dl>
      </div>
      {children}
      <div className="flex flex-wrap justify-end gap-2 border-t border-divider px-5 py-3">
        {actions}
        <Button size="sm" icon={<PanelRight />} onClick={onDetails}>
          Details
        </Button>
        {canAuthorise(c) && (
          <Button
            size="sm"
            variant="primary"
            icon={<KeyRound />}
            disabled={busy}
            onClick={onAuthorise}
          >
            {c.status === 'disconnected' ? 'Connect again' : 'Re-authorise'}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive
        title={`Pause writes to ${c.display_name}?`}
        description="Stock, tracking, ad changes and review requests for this account stop at once and wait. Orders and other reads continue. Resume to send what is waiting."
        confirmLabel="Pause writes"
        onConfirm={() => {
          onKill(true);
        }}
      />
    </Card>
  );
}

function UsageMeter({ u }: { u: Connection['usage_today'][number] }) {
  const pct = usageShare(u);
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="num">
        <span className="font-mono text-xs text-ink-muted">{u.api}</span> {usageLine(u)}
      </span>
      {pct !== null && (
        <span
          className="h-1 w-32 overflow-hidden rounded-full bg-[#e2e5ea]"
          role="meter"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${u.api}: ${String(pct)}% of the daily cap used`}
        >
          <span
            className={cn('block h-full rounded-full', pct >= 80 ? 'bg-warning' : 'bg-brand-600')}
            style={{ width: `${String(Math.min(pct, 100))}%` }}
          />
        </span>
      )}
    </span>
  );
}

/** The detail sheet: last error, sync streams and token expiry; never a token value (INT-3). */
export function ConnectionDetailBody({ d }: { d: ConnectionDetail }) {
  return (
    <div className="flex flex-col gap-5">
      {d.kill_switch.paused && <PausedLine pausedAt={d.kill_switch.paused_at} />}
      <dl>
        <DetailRow label="Status">{STATUS[d.status].label}</DetailRow>
        <DetailRow label="Needs re-authorisation since">
          {d.needs_reauth_at ? formatDateTime(d.needs_reauth_at) : '–'}
        </DetailRow>
        <DetailRow label="Last error">
          {d.last_error ? (
            <span className="flex flex-col items-end">
              <span className="font-mono text-xs">{d.last_error.code}</span>
              <span className="text-xs text-ink-muted">{formatDateTime(d.last_error.at)}</span>
            </span>
          ) : (
            'None'
          )}
        </DetailRow>
      </dl>
      <section aria-label="Sync streams">
        <h3 className="mb-2 text-sm font-semibold">Sync streams</h3>
        {d.streams.length === 0 ? (
          <p className="text-ink-muted">No sync has run yet.</p>
        ) : (
          <SimpleTable
            label="Sync streams"
            head={[{ label: 'Stream' }, { label: 'Up to' }, { label: 'Last success' }]}
          >
            {d.streams.map((s) => (
              <Tr key={s.stream}>
                <Td className="font-mono text-xs">{s.stream}</Td>
                <Td className="num">{s.cursor_at ? formatDateTime(s.cursor_at) : '–'}</Td>
                <Td className="num">{when(s.last_success_at)}</Td>
              </Tr>
            ))}
          </SimpleTable>
        )}
      </section>
      <section aria-label="Stored tokens">
        <h3 className="mb-2 text-sm font-semibold">Stored tokens</h3>
        {d.credentials.length === 0 ? (
          <p className="text-ink-muted">No tokens are stored.</p>
        ) : (
          <SimpleTable
            label="Stored tokens"
            head={[{ label: 'Token' }, { label: 'Slot' }, { label: 'Expires' }]}
          >
            {d.credentials.map((t) => (
              <Tr key={`${t.kind}-${t.slot}`}>
                <Td className="font-mono text-xs">{t.kind}</Td>
                <Td>{t.slot === 'current' ? 'Current' : 'Next'}</Td>
                <Td className="num">{t.expires_at ? formatDate(t.expires_at) : 'No expiry'}</Td>
              </Tr>
            ))}
          </SimpleTable>
        )}
      </section>
    </div>
  );
}
