import {
  CircleAlert,
  CircleCheck,
  Info,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { formatInt } from '../lib/format.ts';

/** A small neutral label, for example a plan name or "Admin". Never a status. */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full border border-border bg-rail px-2 text-xs font-medium text-ink-muted">
      {children}
    </span>
  );
}

/** A round count, for example on a tab or a menu item. */
export function Count({ value }: { value: number }) {
  return (
    <span className="num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#e2e5ea] px-1.5 text-xs font-medium text-ink-muted">
      {formatInt(value)}
    </span>
  );
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  success: { icon: CircleCheck, className: 'text-success' },
  warning: { icon: TriangleAlert, className: 'text-warning' },
  danger: { icon: OctagonAlert, className: 'text-danger' },
  info: { icon: Info, className: 'text-brand-600' },
  neutral: { icon: CircleAlert, className: 'text-ink-muted' },
};

/**
 * Status as a coloured icon and a plain label (ADR-041: no pill chips). The label stays ink,
 * so colour is never the only signal (WCAG 2.1 AA).
 */
export function StatusLabel({
  tone,
  children,
  icon,
}: {
  tone: StatusTone;
  children: ReactNode;
  icon?: LucideIcon;
}) {
  const Icon = icon ?? TONE[tone].icon;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-13 leading-[18px] text-ink">
      <Icon className={cn('size-4 shrink-0', TONE[tone].className)} aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

export type Signal = 'Provisional' | 'Estimate' | 'Allocated estimate' | 'Native' | 'Derived';

/**
 * Data-quality marks the PRD asks to show next to a figure (Provisional, Estimate, and so on).
 * A dashed outline, so it reads as a note on the number rather than a status.
 */
export function SignalLabel({ signal, title }: { signal: Signal; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-[18px] items-center rounded-full border border-dashed border-[#b9bfc8] px-1.5 text-[11px] leading-none font-medium text-ink-muted"
    >
      {signal}
    </span>
  );
}

/** A full-width alert strip: status colour, bold title, one plain sentence on what to do. */
export function AlertStrip({
  tone,
  title,
  children,
  action,
}: {
  tone: 'warning' | 'danger' | 'info' | 'success';
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const bg = {
    warning: 'bg-warning-bg border-warning/30',
    danger: 'bg-danger-bg border-danger/30',
    info: 'bg-brand-50 border-brand-600/30',
    success: 'bg-success-bg border-success/30',
  }[tone];
  const Icon = TONE[tone].icon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-card border px-4 py-3', bg)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', TONE[tone].className)} aria-hidden />
      <div className="min-w-0 flex-1 text-13">
        <span className="font-semibold text-ink">{title}</span>{' '}
        <span className="text-ink">{children}</span>
      </div>
      {action}
    </div>
  );
}
