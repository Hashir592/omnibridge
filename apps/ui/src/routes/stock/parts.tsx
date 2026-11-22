/**
 * Stock pieces the screens share (T-0317): the SKU status, a listing's last push, and the change
 * log table used on the SKU page and the Change log page (INV-5).
 */
import {
  CircleCheck,
  CircleSlash,
  Clock,
  OctagonAlert,
  PackageX,
  RefreshCwOff,
  type LucideIcon,
} from 'lucide-react';
import { useAppState } from '../../app/session.tsx';
import type { Movement, StockListing } from '../../auth/api.ts';
import { SimpleTable, Stack, Td, Tr } from '../../components/Card.tsx';
import { StatusLabel, type StatusTone } from '../../kit/Badge.tsx';
import { cn } from '../../lib/cn.ts';
import { formatDate, formatDateTime, formatInt, formatTime } from '../../lib/format.ts';
import {
  KIND_LABEL,
  REASON_LABEL,
  pushesText,
  signed,
  sourceText,
  type StockState,
} from './rules.ts';

const STATE: Record<StockState, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  in_stock: { label: 'In stock', tone: 'success', icon: CircleCheck },
  out: { label: 'Out of stock', tone: 'warning', icon: PackageX },
  oversold: { label: 'Oversold', tone: 'danger', icon: OctagonAlert },
  sync_failed: { label: 'Sync failed', tone: 'warning', icon: RefreshCwOff },
  inactive: { label: 'Inactive', tone: 'neutral', icon: CircleSlash },
};

/** Coloured icon and plain label (ADR-041). */
export function StockStatus({ state }: { state: StockState }) {
  const s = STATE[state];
  return (
    <StatusLabel tone={s.tone} icon={s.icon}>
      {s.label}
    </StatusLabel>
  );
}

/** A listing's last write (INV-4, INV-8), with its time underneath. */
export function LastPush({ l }: { l: Pick<StockListing, 'fulfilment' | 'last_push'> }) {
  if (l.fulfilment === 'fba') return <Stack value="Fulfilled by Amazon" sub="Never pushed" />;
  if (!l.last_push) return <span className="text-ink-muted">Never pushed</span>;
  const r = l.last_push.result;
  return (
    <Stack
      value={
        r === 'sent' ? (
          <StatusLabel tone="success">Sent</StatusLabel>
        ) : r === 'pending' ? (
          <StatusLabel tone="info" icon={Clock}>
            Sending
          </StatusLabel>
        ) : r === 'held' ? (
          <StatusLabel tone="warning" icon={Clock}>
            Held, sends later
          </StatusLabel>
        ) : (
          <StatusLabel tone="danger" icon={RefreshCwOff}>
            Sync failed
          </StatusLabel>
        )
      }
      sub={<span className="num">{formatDateTime(l.last_push.at)}</span>}
    />
  );
}

/** The change log rows (INV-5): when, SKU, change, on hand after, reason, source, pushes. */
export function MovementsTable({
  rows,
  showSku,
  label = 'Stock movements',
}: {
  rows: Movement[];
  showSku: boolean;
  label?: string;
}) {
  const { session } = useAppState();
  return (
    <SimpleTable
      label={label}
      head={[
        { label: 'When' },
        ...(showSku ? [{ label: 'SKU' }] : []),
        { label: 'Change', align: 'right' as const },
        { label: 'On hand after', align: 'right' as const },
        { label: 'What' },
        { label: 'Listings pushed' },
      ]}
    >
      {rows.map((m) => {
        const p = pushesText(m.pushes);
        const detail = [
          m.reason ? REASON_LABEL[m.reason] : null,
          m.supplier ? `From ${m.supplier}` : null,
          m.note,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <Tr key={m.id}>
            <Td>
              <Stack
                value={<span className="num">{formatDate(m.at)}</span>}
                sub={formatTime(m.at)}
              />
            </Td>
            {showSku && (
              <Td>
                <span className="ref">{m.sku}</span>
              </Td>
            )}
            <Td align="right">
              <Stack
                value={
                  <span
                    className={cn(
                      'num font-medium',
                      m.on_hand_change > 0 && 'text-success',
                      m.on_hand_change < 0 && 'text-ink',
                    )}
                  >
                    {signed(m.on_hand_change)}
                  </span>
                }
                sub={
                  m.reserved_change !== 0 ? (
                    <span className="num">{signed(m.reserved_change)} reserved</span>
                  ) : undefined
                }
              />
            </Td>
            <Td align="right">
              <span className="num">{formatInt(m.on_hand_after)}</span>
            </Td>
            <Td>
              <Stack
                value={KIND_LABEL[m.kind]}
                sub={
                  <>
                    {sourceText(m.source, session?.userId)}
                    {detail && ` · ${detail}`}
                  </>
                }
              />
            </Td>
            <Td>
              {p.tone === 'none' ? (
                <span className="text-ink-muted">{p.text}</span>
              ) : (
                <StatusLabel
                  tone={p.tone === 'ok' ? 'success' : p.tone === 'bad' ? 'danger' : 'warning'}
                  {...(p.tone === 'wait' ? { icon: Clock } : {})}
                >
                  {p.text}
                </StatusLabel>
              )}
            </Td>
          </Tr>
        );
      })}
    </SimpleTable>
  );
}
