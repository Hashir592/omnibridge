import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { formatInt } from '../../lib/format.ts';
import { PAGE_SIZES, pageList, type PageSize } from '../../lib/paging.ts';

export interface PagerProps {
  page: number;
  size: PageSize;
  total: number;
  /** Plural noun for the count, for example "orders". */
  noun: string;
  /** ADR-040: totals above 10,000 are reported as "10,000+". */
  totalCapped?: boolean;
  onPage: (page: number) => void;
  onSize: (size: PageSize) => void;
}

/** Numbered pages of 20, 50 or 100 rows (ADR-040). Page and size live in the URL. */
export function Pager({ page, size, total, noun, totalCapped, onPage, onSize }: PagerProps) {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  const btn =
    'grid h-8 min-w-8 place-items-center rounded-ctl px-2 text-13 num text-ink hover:bg-card disabled:pointer-events-none disabled:text-ink-faint';
  return (
    <nav
      aria-label="Pagination"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 pt-3 text-13 text-ink-muted"
    >
      <span className="num">
        {formatInt(from)}-{formatInt(to)} of {formatInt(total)}
        {totalCapped ? '+' : ''} {noun}
      </span>
      <label className="flex items-center gap-2">
        Rows per page
        <select
          value={size}
          onChange={(e) => {
            onSize(Number(e.target.value) as PageSize);
          }}
          className="num h-8 rounded-ctl border border-border bg-card pr-7 pl-2.5 text-13 text-ink shadow-card"
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="ml-auto flex items-center gap-1">
        <button
          className={cn(btn, 'gap-1 pr-2.5')}
          disabled={page <= 1}
          onClick={() => {
            onPage(page - 1);
          }}
        >
          <span className="flex items-center gap-1">
            <ChevronLeft className="size-4" aria-hidden /> Previous
          </span>
        </button>
        {pageList(page, pageCount).map((p, i) =>
          p === 'gap' ? (
            <span key={`g${String(i)}`} className="px-1 text-ink-faint" aria-hidden>
              ...
            </span>
          ) : (
            <button
              key={p}
              onClick={() => {
                onPage(p);
              }}
              aria-label={`Page ${String(p)}`}
              aria-current={p === page ? 'page' : undefined}
              className={cn(btn, p === page && 'bg-side font-medium text-white hover:bg-side')}
            >
              {p}
            </button>
          ),
        )}
        <button
          className={cn(btn, 'pl-2.5')}
          disabled={page >= pageCount}
          onClick={() => {
            onPage(page + 1);
          }}
        >
          <span className="flex items-center gap-1">
            Next <ChevronRight className="size-4" aria-hidden />
          </span>
        </button>
      </div>
    </nav>
  );
}
