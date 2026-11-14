import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';

/** A white panel with an optional header (title left, aside right). */
export function Card({
  title,
  aside,
  className,
  children,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn('min-w-0 rounded-card border border-border bg-card shadow-card', className)}
    >
      {title !== undefined && (
        <header className="flex min-h-12 items-center gap-3 border-b border-divider px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {aside !== undefined && (
            <div className="ml-auto flex items-center gap-2 text-13">{aside}</div>
          )}
        </header>
      )}
      {children}
    </section>
  );
}

/** Page title row: h1, an optional line under it, and actions on the right. */
export function PageHeader({
  title,
  sub,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">{title}</h1>
        {sub !== undefined && <p className="num mt-0.5 text-13 text-ink-muted">{sub}</p>}
      </div>
      {actions !== undefined && (
        <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/** A label and a compact figure, for a row of key numbers (no hero numbers, DIRECTION §6). */
export function Figure({
  label,
  value,
  sub,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-center gap-1.5 text-xs text-ink-muted">{label}</div>
      <div className="num mt-1 text-lg leading-6 font-semibold tracking-[-0.01em] text-ink">
        {value}
      </div>
      {sub !== undefined && <div className="num mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

/** A label/value pair inside a details card. */
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-divider py-2.5 text-13 last:border-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

/** A plain HTML table inside a card, for short lists that need no paging (under ~20 rows). */
export function SimpleTable({
  label,
  head,
  children,
  className,
}: {
  label: string;
  head: Array<{ label: string; align?: 'right'; className?: string }>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table aria-label={label} className="w-full border-collapse text-13">
        <thead>
          <tr className="h-10 bg-rail text-left text-xs font-medium text-ink-muted">
            {head.map((h) => (
              <th
                key={h.label}
                scope="col"
                className={cn(
                  'border-b border-divider px-4 font-medium whitespace-nowrap first:pl-5 last:pr-5',
                  h.align === 'right' && 'text-right',
                  h.className,
                )}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** One 56 px row of a SimpleTable. */
export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr className={cn('h-14 border-b border-divider last:border-0', className)}>{children}</tr>
  );
}

export function Td({
  children,
  align,
  className,
}: {
  children?: ReactNode;
  align?: 'right';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'px-4 align-middle first:pl-5 last:pr-5',
        align === 'right' && 'num text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Value with a 12 px line under it, for SimpleTable cells. */
export function Stack({ value, sub }: { value: ReactNode; sub?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate leading-[18px]">{value}</span>
      {sub !== undefined && (
        <span className="truncate text-xs leading-4 text-ink-muted">{sub}</span>
      )}
    </span>
  );
}
