import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { formatPence } from '../lib/format.ts';

export interface StatementLine {
  label: ReactNode;
  /** Integer pence per column; null shows a dash. */
  values?: Array<number | null>;
  /** heading: a group title; line: an entry; subtotal and total: sums (total is the result). */
  kind?: 'heading' | 'line' | 'subtotal' | 'total';
  /** Shown under the label, for example where a figure comes from. */
  note?: ReactNode;
  /** A signal mark (Provisional, Estimate) after the label. */
  signal?: ReactNode;
  /** Right-hand text column, for example "+8.2%". */
  extra?: ReactNode;
}

/**
 * A money statement (VAT settlement, P&L, contribution profit): labels left, amounts right in
 * tabular figures. Totals are bold with a rule above; only a negative total turns red (a loss).
 */
export function Statement({
  label,
  columns,
  lines,
  extraHeader,
}: {
  label: string;
  columns: string[];
  lines: StatementLine[];
  extraHeader?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-13">
        <thead>
          <tr className="h-10 bg-rail text-xs text-ink-muted">
            <th scope="col" className="border-b border-divider pl-5 text-left font-medium">
              Line
            </th>
            {columns.map((c) => (
              <th
                key={c}
                scope="col"
                className="border-b border-divider px-4 text-right font-medium whitespace-nowrap last:pr-5"
              >
                {c}
              </th>
            ))}
            {extraHeader !== undefined && (
              <th
                scope="col"
                className="border-b border-divider pr-5 text-right font-medium whitespace-nowrap"
              >
                {extraHeader}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const kind = l.kind ?? 'line';
            if (kind === 'heading') {
              return (
                <tr key={i} className="h-10">
                  <th
                    scope="rowgroup"
                    colSpan={columns.length + 1 + (extraHeader !== undefined ? 1 : 0)}
                    className="border-b border-divider pt-3 pl-5 text-left text-xs font-semibold text-ink-muted"
                  >
                    {l.label}
                  </th>
                </tr>
              );
            }
            const sum = kind === 'subtotal' || kind === 'total';
            return (
              <tr
                key={i}
                className={cn(
                  'border-b border-divider',
                  sum ? 'h-11' : 'h-10',
                  kind === 'total' && 'bg-rail',
                )}
              >
                <th
                  scope="row"
                  className={cn(
                    'py-2 pl-5 text-left',
                    sum ? 'font-semibold text-ink' : 'pl-8 font-normal text-ink',
                  )}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {l.label}
                    {l.signal}
                  </span>
                  {l.note !== undefined && (
                    <span className="block text-xs font-normal text-ink-muted">{l.note}</span>
                  )}
                </th>
                {(l.values ?? []).map((v, j) => (
                  <td
                    key={j}
                    className={cn(
                      'num px-4 text-right whitespace-nowrap last:pr-5',
                      sum && 'font-semibold',
                      kind === 'total' && v !== null && v < 0 && 'text-danger',
                    )}
                  >
                    {v === null ? <span className="text-ink-faint">-</span> : formatPence(v)}
                  </td>
                ))}
                {extraHeader !== undefined && (
                  <td className="num pr-5 text-right whitespace-nowrap text-ink-muted">
                    {l.extra}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
