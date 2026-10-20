import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { formatDate, formatInt, formatPence, formatTime } from '../../lib/format.ts';

/** The 12 px second line of a two-line cell. */
export function Sub({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <span className={cn('truncate text-xs leading-4 text-ink-muted', className)}>{children}</span>
  );
}

/** Value with optional subtext; the standard 56 px cell. */
export function TwoLine({
  value,
  sub,
  className,
}: {
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <>
      <span className={cn('truncate text-13 leading-[18px]', className)}>{value}</span>
      {sub !== undefined && <Sub>{sub}</Sub>}
    </>
  );
}

/** Integer pence as £1,234.56, tabular. Negative amounts are red with a minus sign (NFR-9). Right-align the column. */
export function MoneyCell({
  pence,
  sub,
  strong,
}: {
  pence: number;
  sub?: ReactNode;
  strong?: boolean;
}) {
  return (
    <>
      <span
        className={cn(
          'num text-13 leading-[18px]',
          strong && 'font-medium',
          pence < 0 && 'text-danger',
        )}
      >
        {formatPence(pence)}
      </span>
      {sub !== undefined && <Sub className="num">{sub}</Sub>}
    </>
  );
}

export function NumberCell({ value, sub }: { value: number; sub?: ReactNode }) {
  return (
    <>
      <span className="num text-13 leading-[18px]">{formatInt(value)}</span>
      {sub !== undefined && <Sub className="num">{sub}</Sub>}
    </>
  );
}

/** UTC instant shown as DD/MM/YYYY with the London time underneath (NFR-9). */
export function DateCell({ iso, time = true }: { iso: string; time?: boolean }) {
  return (
    <>
      <span className="num text-13 leading-[18px]">{formatDate(iso)}</span>
      {time && <Sub className="num">{formatTime(iso)}</Sub>}
    </>
  );
}

/** An empty cell: a faint dash that screen readers hear as the given label. */
export function EmptyCell({ label }: { label: string }) {
  return (
    <span className="text-13 text-ink-faint" aria-label={label}>
      -
    </span>
  );
}
