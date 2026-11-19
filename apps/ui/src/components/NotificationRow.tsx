import { Link } from '@tanstack/react-router';
import { CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Notification } from '../auth/api.ts';
import { SignalLabel, type Signal } from '../kit/Badge.tsx';
import { cn } from '../lib/cn.ts';
import { daysFromToday, formatDate, formatTime } from '../lib/format.ts';
import { detailOf, targetOf } from '../lib/notificationLink.ts';
import type { Company } from '../mocks/types.ts';
import { CompanySwatch } from './badges.tsx';

export const SEVERITY: Record<
  Notification['severity'],
  { icon: LucideIcon; tone: string; label: string }
> = {
  critical: { icon: OctagonAlert, tone: 'text-danger', label: 'Critical' },
  warning: { icon: TriangleAlert, tone: 'text-warning', label: 'Warning' },
  info: { icon: Info, tone: 'text-brand-600', label: 'Info' },
};

const SIGNAL: Record<NonNullable<Notification['signal']>, Signal> = {
  native: 'Native',
  derived: 'Derived',
  estimate: 'Estimate',
};

const when = (iso: string) => {
  const d = daysFromToday(iso);
  return d === 0 ? formatTime(iso) : d === -1 ? `Yesterday, ${formatTime(iso)}` : formatDate(iso);
};

/**
 * One notification (NTF-1): severity, title, the record it is about, when, company, signal and
 * state. The whole row is a link to the record; the caller marks it read when it is followed.
 */
export function NotificationRow({
  n,
  company,
  onOpen,
  highlighted,
}: {
  n: Notification;
  company: Company | undefined;
  onOpen: () => void;
  highlighted?: boolean;
}) {
  const s = SEVERITY[n.severity];
  const Icon = n.state === 'resolved' ? CircleCheck : s.icon;
  const target = targetOf(n);
  return (
    <Link
      to={target.to}
      search={target.search as never}
      onClick={onOpen}
      aria-current={highlighted ? 'true' : undefined}
      className={cn(
        'flex gap-3 px-4 py-3 hover:bg-hover',
        n.state === 'unread' && 'bg-[#f8fafc]',
        highlighted && 'bg-hover ring-2 ring-brand-600 ring-inset',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-4 shrink-0', n.state === 'resolved' ? 'text-success' : s.tone)}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block text-13',
            n.state === 'unread' ? 'font-semibold' : 'font-medium text-ink-muted',
          )}
        >
          <span className="sr-only">{n.state === 'resolved' ? 'Resolved' : s.label}: </span>
          {n.title}
        </span>
        <span className="mt-0.5 block text-xs text-ink-muted">{detailOf(n)}</span>
        <span className="num mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          {when(n.updatedAt)}
          {company && (
            <span className="flex items-center gap-1">
              <CompanySwatch company={company} /> {company.tradingName}
            </span>
          )}
          {n.signal && <SignalLabel signal={SIGNAL[n.signal]} />}
          {n.state === 'resolved' && <span>Resolved itself</span>}
        </span>
      </span>
      {n.state === 'unread' && (
        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" />
      )}
    </Link>
  );
}
