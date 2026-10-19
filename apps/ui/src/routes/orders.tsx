import { Menu } from '@base-ui/react/menu';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  OctagonAlert,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { rememberOrdersSearch } from '../app/lastSearch.ts';
import { useAppState } from '../app/session.tsx';
import {
  ChannelMark,
  CompanyBadge,
  FLAG,
  FlagMark,
  STATUS,
  StatusChip,
} from '../components/badges.tsx';
import { cn } from '../lib/cn.ts';
import { PAGE_SIZES, pageList, type PageSize } from '../lib/paging.ts';
import {
  daysFromToday,
  formatDate,
  formatInt,
  formatPence,
  formatTime,
  overdueText,
} from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import type { OrderFlag, OrderRow, OrderStatus } from '../mocks/types.ts';

export interface OrdersSearch {
  view?: 'all' | 'awaiting' | 'overdue' | 'today' | 'flagged' | undefined;
  q?: string | undefined;
  channel?: string | undefined;
  status?: string | undefined;
  flag?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/orders');

type ColId =
  | 'select'
  | 'order'
  | 'channel'
  | 'shipTo'
  | 'status'
  | 'items'
  | 'total'
  | 'shipBy'
  | 'shipping'
  | 'flags';

interface Col {
  id: ColId;
  header: string;
  width: string;
  align?: 'right';
  optional?: boolean;
}

const COLS: Col[] = [
  { id: 'select', header: '', width: '40px' },
  { id: 'order', header: 'Order', width: '192px' },
  { id: 'channel', header: 'Channel', width: '152px' },
  { id: 'status', header: 'Status', width: '148px' },
  { id: 'shipBy', header: 'Ship by', width: '140px' },
  { id: 'total', header: 'Total', width: '84px', align: 'right' },
  { id: 'items', header: 'Items', width: '52px', align: 'right', optional: true },
  { id: 'shipTo', header: 'Ship to', width: '108px', optional: true },
  { id: 'shipping', header: 'Shipping', width: '124px', optional: true },
  { id: 'flags', header: 'Flags', width: 'minmax(104px,1fr)', optional: true },
];

/** Tablet (NFR-8): taller rows for touch, and the columns a packer needs first. */
const isTablet = () => typeof window !== 'undefined' && window.innerWidth < 1024;

const VIEWS: Array<{ id: NonNullable<OrdersSearch['view']>; label: string }> = [
  { id: 'all', label: 'All orders' },
  { id: 'awaiting', label: 'Awaiting dispatch' },
  { id: 'today', label: 'Due today' },
  { id: 'overdue', label: 'Past ship-by' },
  { id: 'flagged', label: 'Needs attention' },
];

const split = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);

export function OrdersPage() {
  const search = route.useSearch();
  useEffect(() => {
    rememberOrdersSearch(search);
  }, [search]);
  const navigate = useNavigate({ from: '/orders' });
  const { session, persona, companyId, company } = useAppState();
  // One row height for all screens (Hashir, 19/10): roomy enough for the two-line cells and touch.
  const density = 56;
  const [hidden, setHidden] = useState<Set<ColId>>(
    () => new Set(isTablet() ? (['items', 'shipTo'] as ColId[]) : []),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qDraft, setQDraft] = useState(search.q ?? '');

  // Any filter change goes back to page 1; paging itself passes `page` explicitly.
  const setSearch = (patch: Partial<OrdersSearch>) =>
    void navigate({
      search: (prev: OrdersSearch) => ({ ...prev, page: undefined, ...patch }),
      replace: !('page' in patch),
    });

  // Debounce the search box into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== qDraft) setSearch({ q: qDraft || undefined });
    }, 200);
    return () => {
      clearTimeout(t);
    };
  }, [qDraft]);

  const view = search.view ?? 'all';
  const filterKey = [
    companyId,
    persona,
    view,
    search.q,
    search.channel,
    search.status,
    search.flag,
  ];
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;

  // Selection belongs to the page on screen, so the bulk counts always match the rows shown.
  useEffect(() => {
    setSelected(new Set());
  }, [...filterKey, page, size]);

  const query = useQuery({
    queryKey: ['orders', ...filterKey, page, size],
    queryFn: () =>
      mockApi.orders({
        company: companyId,
        view,
        q: search.q,
        channel: search.channel,
        status: search.status,
        flag: search.flag,
        cursor: (page - 1) * size,
        limit: size,
      }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });

  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const total = query.data?.total ?? 0;
  const counts = query.data?.counts;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);

  // A page past the end (an old link, or fewer orders after switching company) goes to the last page.
  useEffect(() => {
    if (query.data && page > pageCount)
      setSearch({ page: pageCount === 1 ? undefined : pageCount });
  }, [query.data, page, pageCount]);

  const cols = COLS.filter((c) => !hidden.has(c.id));
  const grid = cols.map((c) => c.width).join(' ');

  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => density,
    overscan: 12,
  });
  useEffect(() => {
    virtual.measure();
  }, [density, virtual]);

  const items = virtual.getVirtualItems();

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [...filterKey, page, size]);

  const allLoadedSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = selected.size > 0 && !allLoadedSelected;
  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
  for (const id of split(search.channel)) {
    const a = session?.channelAccounts.find((x) => x.id === id);
    chips.push({
      key: `c-${id}`,
      label: `Channel: ${a?.name ?? id}`,
      onRemove: () => {
        setSearch({
          channel:
            split(search.channel)
              .filter((x) => x !== id)
              .join(',') || undefined,
        });
      },
    });
  }
  for (const id of split(search.status)) {
    chips.push({
      key: `s-${id}`,
      label: `Status: ${id in STATUS ? STATUS[id as OrderStatus].label : id}`,
      onRemove: () => {
        setSearch({
          status:
            split(search.status)
              .filter((x) => x !== id)
              .join(',') || undefined,
        });
      },
    });
  }
  for (const id of split(search.flag)) {
    chips.push({
      key: `f-${id}`,
      label: `Flag: ${id in FLAG ? FLAG[id as OrderFlag].label : id}`,
      onRemove: () => {
        setSearch({
          flag:
            split(search.flag)
              .filter((x) => x !== id)
              .join(',') || undefined,
        });
      },
    });
  }
  if (search.q)
    chips.push({
      key: 'q',
      label: `Search: ${search.q}`,
      onRemove: () => {
        setQDraft('');
      },
    });

  const clearAll = () => {
    setQDraft('');
    void navigate({ search: { view: search.view, size: search.size }, replace: true });
  };

  const selectedRows = rows.filter((r) => selected.has(r.id));
  const labelable = selectedRows.filter((r) => r.status === 'awaiting_dispatch').length;

  return (
    <div className="flex h-full flex-col px-4 pt-2 pb-3 lg:px-6">
      <div className="flex items-center gap-3">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">Orders</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="flex h-9 items-center gap-1.5 rounded-ctl border border-border bg-card px-3.5 text-13 font-medium shadow-card hover:bg-hover"
            title="CSV export never includes customer details (ORD-8)"
          >
            <Download className="size-4 text-ink-muted" aria-hidden />
            Export CSV
          </button>
        </div>
      </div>

      {/* Saved views: the dispatch picture at a glance, and one click to act on it. */}
      <div
        role="tablist"
        aria-label="Order views"
        className="mt-4 flex gap-1 overflow-x-auto overflow-y-hidden p-px"
      >
        {VIEWS.map((v) => {
          const n =
            counts &&
            {
              all: counts.all,
              awaiting: counts.awaiting,
              today: counts.dueToday,
              overdue: counts.overdue,
              flagged: counts.flagged,
            }[v.id];
          const active = view === v.id;
          const alarm = v.id === 'overdue' && (n ?? 0) > 0;
          return (
            <button
              key={v.id}
              role="tab"
              aria-selected={active}
              onClick={() => {
                setSearch({ view: v.id === 'all' ? undefined : v.id });
              }}
              className={cn(
                'flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-13 whitespace-nowrap',
                active
                  ? 'bg-side font-medium text-white shadow-card'
                  : 'text-ink-muted hover:bg-card hover:text-ink',
              )}
            >
              {alarm && (
                <OctagonAlert
                  className={cn('size-3.5', active ? 'text-white' : 'text-danger')}
                  aria-hidden
                />
              )}
              {v.label}
              <span
                className={cn(
                  'num rounded-full px-2 text-xs leading-[18px] font-medium',
                  alarm && !active
                    ? 'bg-danger-bg text-danger'
                    : active
                      ? 'bg-white/15 text-white'
                      : 'bg-[#e2e5ea] text-ink-muted',
                )}
              >
                {n === undefined ? '-' : formatInt(n)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Toolbar, or the bulk bar in the same 44 px slot so nothing shifts. */}
      <div className="flex h-14 shrink-0 items-center gap-2 py-2.5">
        {selected.size > 0 ? (
          <div
            role="region"
            aria-label="Bulk actions"
            className="flex h-full flex-1 items-center gap-3 rounded-ctl bg-side pr-1.5 pl-3.5 text-white shadow-pop"
          >
            <span className="num text-13 font-medium text-white">
              {formatInt(selected.size)} selected
            </span>
            {!allLoadedSelected && rows.length > selected.size && (
              <button
                className="text-13 text-side-text underline-offset-2 hover:text-white hover:underline"
                onClick={() => {
                  setSelected(new Set(rows.map((r) => r.id)));
                }}
              >
                Select all {formatInt(rows.length)} on this page
              </button>
            )}
            {labelable < selected.size && (
              <span className="hidden text-xs text-side-muted md:inline">
                {formatInt(selected.size - labelable)} not awaiting dispatch will be skipped for
                labels
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <button
                disabled={labelable === 0}
                className="h-7 rounded-[6px] bg-white px-3 text-13 font-medium text-ink hover:bg-[#e9ecf0] disabled:opacity-50"
              >
                Create labels{labelable > 0 ? ` (${formatInt(labelable)})` : ''}
              </button>
              <ToolbarButton>Print packing slips</ToolbarButton>
              <ToolbarButton>Export selected</ToolbarButton>
              <button
                onClick={() => {
                  setSelected(new Set());
                }}
                className="flex h-7 items-center gap-1 rounded-[6px] px-2 text-13 text-side-text hover:bg-side-hover hover:text-white"
              >
                <X className="size-4" aria-hidden /> Clear
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="relative flex h-9 w-full max-w-64 items-center">
              <span className="sr-only">Search by order ref or SKU</span>
              <Search
                className="pointer-events-none absolute left-2.5 size-4 text-ink-muted"
                aria-hidden
              />
              <input
                value={qDraft}
                onChange={(e) => {
                  setQDraft(e.target.value);
                }}
                placeholder="Order ref or SKU"
                className="h-9 w-full rounded-ctl border border-border bg-card pr-2 pl-8 text-13 shadow-card outline-none placeholder:text-ink-muted focus:border-brand-600"
              />
            </label>
            <FilterMenu
              label="Channel"
              options={(session?.channelAccounts ?? []).map((a) => ({
                value: a.id,
                label: a.name,
              }))}
              value={split(search.channel)}
              onChange={(v) => {
                setSearch({ channel: v.join(',') || undefined });
              }}
            />
            <FilterMenu
              label="Status"
              options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))}
              value={split(search.status)}
              onChange={(v) => {
                setSearch({ status: v.join(',') || undefined });
              }}
            />
            <FilterMenu
              label="Flag"
              options={Object.entries(FLAG).map(([value, f]) => ({ value, label: f.label }))}
              value={split(search.flag)}
              onChange={(v) => {
                setSearch({ flag: v.join(',') || undefined });
              }}
            />
            <div className="ml-auto flex items-center gap-1.5">
              <ColumnPicker hidden={hidden} setHidden={setHidden} />
            </div>
          </>
        )}
      </div>

      {chips.length > 0 && (
        <div className="-mt-0.5 mb-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-selected pr-1 pl-2.5 text-xs font-medium text-ink"
            >
              {c.label}
              <button
                aria-label={`Remove ${c.label}`}
                onClick={c.onRemove}
                className="grid size-4 place-items-center rounded-full hover:bg-ink/10"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <button onClick={clearAll} className="ml-1 text-xs text-brand-600 hover:underline">
            Clear all
          </button>
        </div>
      )}

      {/* The table */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-card border border-border bg-card shadow-card">
        <div
          ref={scroller}
          className="h-full overflow-auto"
          role="table"
          aria-label="Orders"
          aria-rowcount={total + 1}
        >
          <div style={{ minWidth: 'fit-content' }}>
            <div
              role="row"
              className="sticky top-0 z-20 grid h-10 border-b border-border bg-rail text-xs font-medium text-ink-muted"
              style={{ gridTemplateColumns: grid }}
            >
              {cols.map((c) => (
                <div
                  key={c.id}
                  role="columnheader"
                  className={cn(
                    'flex items-center px-3',
                    c.align === 'right' && 'justify-end',
                    c.id === 'select' && 'sticky left-0 z-10 justify-center bg-rail px-0',
                    c.id === 'order' && 'sticky left-10 z-10 border-r border-divider bg-rail',
                  )}
                >
                  {c.id === 'select' ? (
                    <input
                      type="checkbox"
                      aria-label="Select all orders on this page"
                      className="size-4"
                      checked={allLoadedSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={() => {
                        setSelected(allLoadedSelected ? new Set() : new Set(rows.map((r) => r.id)));
                      }}
                    />
                  ) : (
                    c.header
                  )}
                </div>
              ))}
            </div>

            <div role="rowgroup" style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {items.map((vi) => {
                const o = rows[vi.index];
                if (!o) return null;
                const isSel = selected.has(o.id);
                return (
                  <div
                    key={o.id}
                    role="row"
                    aria-rowindex={(page - 1) * size + vi.index + 2}
                    aria-selected={isSel}
                    className={cn(
                      'group absolute inset-x-0 grid border-b border-divider text-13',
                      isSel ? 'bg-selected' : 'bg-card hover:bg-hover',
                    )}
                    style={{
                      gridTemplateColumns: grid,
                      height: density,
                      transform: `translateY(${String(vi.start)}px)`,
                    }}
                  >
                    {cols.map((c) => (
                      <Cell key={c.id} col={c} selected={isSel} density={density}>
                        {renderCell(c.id, o, { isSel, toggle, company, density })}
                      </Cell>
                    ))}
                  </div>
                );
              })}
            </div>

            {query.isSuccess && rows.length === 0 && (
              <div className="sticky left-0 flex w-full max-w-[min(100%,100vw)] flex-col items-center gap-2 px-6 py-16 text-center">
                <p className="text-sm font-medium">No orders match these filters</p>
                <p className="text-13 text-ink-muted">
                  Remove a filter or switch to Combined to see more orders.
                </p>
                <button
                  onClick={clearAll}
                  className="mt-2 h-8 rounded-ctl border border-border px-3 text-13 font-medium hover:bg-hover"
                >
                  Clear filters
                </button>
              </div>
            )}
            {query.isError && (
              <div className="sticky left-0 flex flex-col items-center gap-2 px-6 py-16 text-center">
                <p className="text-sm font-medium">Orders could not load</p>
                <p className="text-13 text-ink-muted">
                  The server did not answer. Try again; if it keeps failing, check Status.
                </p>
                <button
                  onClick={() => void query.refetch()}
                  className="mt-2 h-8 rounded-ctl border border-border px-3 text-13 font-medium hover:bg-hover"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
        <DelayedSkeleton show={query.isPending} density={density} />
      </div>

      <Pager
        page={page}
        pageCount={pageCount}
        size={size}
        from={from}
        to={to}
        total={total}
        onPage={(p) => {
          setSearch({ page: p === 1 ? undefined : p });
        }}
        onSize={(s) => {
          setSearch({ size: s === 50 ? undefined : s });
        }}
      />
    </div>
  );
}

function Pager(props: {
  page: number;
  pageCount: number;
  size: PageSize;
  from: number;
  to: number;
  total: number;
  onPage: (p: number) => void;
  onSize: (s: PageSize) => void;
}) {
  const { page, pageCount, size, from, to, total, onPage, onSize } = props;
  const btn =
    'grid h-8 min-w-8 place-items-center rounded-ctl px-2 text-13 num text-ink hover:bg-card disabled:pointer-events-none disabled:text-ink-faint';
  return (
    <nav
      aria-label="Pagination"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 pt-3 text-13 text-ink-muted"
    >
      <span className="num">
        {formatInt(from)}-{formatInt(to)} of {formatInt(total)} orders
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

function Cell({
  col,
  selected,
  density,
  children,
}: {
  col: Col;
  selected: boolean;
  density: number;
  children: ReactNode;
}) {
  return (
    <div
      role="cell"
      className={cn(
        'flex min-w-0 flex-col justify-center px-3',
        density === 44 ? 'gap-0.5' : 'gap-1',
        col.align === 'right' && 'items-end text-right',
        col.id === 'select' && 'sticky left-0 z-10 items-center px-0',
        col.id === 'order' && 'sticky left-10 z-10 border-r border-divider',
        (col.id === 'select' || col.id === 'order') &&
          (selected ? 'bg-selected' : 'bg-card group-hover:bg-hover'),
      )}
    >
      {children}
    </div>
  );
}

const Sub = ({ children, className }: { children: ReactNode; className?: string | undefined }) => (
  <span className={cn('truncate text-xs leading-4 text-ink-muted', className)}>{children}</span>
);

function renderCell(
  id: ColId,
  o: OrderRow,
  ctx: {
    isSel: boolean;
    toggle: (id: string) => void;
    company: (id: string) => ReturnType<ReturnType<typeof useAppState>['company']>;
    density: number;
  },
): ReactNode {
  switch (id) {
    case 'select':
      // The whole cell is the hit area, so it is at least 40 px on a tablet.
      return (
        <label className="grid h-full w-full cursor-pointer place-items-center">
          <input
            type="checkbox"
            aria-label={`Select order ${o.ref}`}
            className="size-4"
            checked={ctx.isSel}
            onChange={() => {
              ctx.toggle(o.id);
            }}
          />
        </label>
      );
    case 'order':
      return (
        <>
          <Link
            to="/orders/$orderId"
            params={{ orderId: o.id }}
            className="ref truncate text-13 leading-[18px] font-medium text-ink hover:text-brand-600 hover:underline"
          >
            {o.ref}
          </Link>
          <Sub className="num">{whenLabel(o.placedAt)}</Sub>
        </>
      );
    case 'channel': {
      const c = ctx.company(o.companyId);
      return (
        <span className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          <ChannelMark channel={o.channel} />
          {c && <CompanyBadge company={c} full />}
        </span>
      );
    }
    case 'shipTo':
      return <span className="truncate text-13 text-ink-muted">{o.shipToMasked}</span>;
    case 'status':
      return <StatusChip status={o.status} />;
    case 'items':
      return <span className="num text-13">{o.itemCount}</span>;
    case 'total':
      return <span className="num text-13 font-medium">{formatPence(o.totalPence)}</span>;
    case 'shipBy':
      return <ShipBy o={o} />;
    case 'shipping':
      return <Shipping o={o} />;
    case 'flags': {
      const f = o.flags;
      if (f.length === 0)
        return (
          <span className="text-13 text-ink-faint" aria-label="No flags">
            -
          </span>
        );
      return (
        <span
          className="flex min-w-0 flex-wrap gap-x-2.5 overflow-hidden"
          style={{ maxHeight: 18 }}
        >
          {f.map((x) => (
            <FlagMark key={x} flag={x} />
          ))}
        </span>
      );
    }
  }
}

/** "Today, 18:05", "Yesterday, 17:45", else "16/10/2026, 22:31" (UK time). */
function whenLabel(iso: string): string {
  const d = daysFromToday(iso);
  const day = d === 0 ? 'Today' : d === -1 ? 'Yesterday' : formatDate(iso);
  return `${day}, ${formatTime(iso)}`;
}

function ShipBy({ o }: { o: OrderRow }) {
  const date = formatDate(o.shipBy);
  if (o.status !== 'awaiting_dispatch')
    return <span className="num text-13 text-ink-muted">{date}</span>;
  const d = daysFromToday(o.shipBy);
  if (Date.parse(o.shipBy) < Date.now()) {
    return (
      <>
        <span className="flex items-center gap-1 text-13 leading-[18px] font-medium whitespace-nowrap text-danger">
          <OctagonAlert className="size-3.5 shrink-0" aria-hidden />
          {overdueText(o.shipBy)}
        </span>
        <Sub className="num">was due {date}</Sub>
      </>
    );
  }
  const time = formatTime(o.shipBy);
  const label = d === 0 ? `Today, ${time}` : d === 1 ? `Tomorrow, ${time}` : `In ${String(d)} days`;
  return (
    <>
      <span
        className={cn(
          'num text-13 leading-[18px] whitespace-nowrap text-ink',
          d === 0 && 'font-medium',
        )}
      >
        {label}
      </span>
      <Sub className="num">{d <= 1 ? date : `${date}, ${time}`}</Sub>
    </>
  );
}

const TRACKING: Record<OrderRow['tracking'], string> = {
  none: '',
  pending: 'Awaiting first scan',
  pushed: 'Tracking sent to channel',
  confirmed: 'Tracking confirmed',
  not_confirmed: 'Channel has not confirmed',
};

function Shipping({ o }: { o: OrderRow }) {
  if (!o.shipping) return <span className="text-13 text-ink-muted">Not shipped</span>;
  return (
    <>
      <span className="truncate text-13 leading-[18px]">
        {o.shipping.carrier} {o.shipping.service}
      </span>
      <Sub className={o.tracking === 'not_confirmed' ? 'text-warning' : undefined}>
        {TRACKING[o.tracking]}
      </Sub>
    </>
  );
}

function ToolbarButton({ children }: { children: ReactNode }) {
  return (
    <button className="h-7 rounded-[6px] border border-white/20 px-3 text-13 font-medium text-white hover:bg-side-hover">
      {children}
    </button>
  );
}

const popup =
  'min-w-56 max-h-80 overflow-y-auto rounded-card border border-border bg-card p-1.5 text-13 text-ink shadow-pop outline-none';
const menuItem =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 outline-none select-none data-[highlighted]:bg-hover';

function CheckBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[4px] border',
        on ? 'border-side bg-side text-white' : 'border-[#c3c8d0] bg-card',
      )}
    >
      {on && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function FilterMenu({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const active = value.length > 0;
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 rounded-ctl border px-3 text-13 font-medium shadow-card',
          active ? 'border-[#c3c8d0] bg-selected text-ink' : 'border-border bg-card hover:bg-hover',
        )}
      >
        {label}
        {active && (
          <span className="num rounded-full bg-side px-1.5 text-[11px] leading-4 text-white">
            {value.length}
          </span>
        )}
        <ChevronDown className="size-3.5 text-ink-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={popup}>
            {options.map((o) => {
              const on = value.includes(o.value);
              return (
                <Menu.CheckboxItem
                  key={o.value}
                  checked={on}
                  closeOnClick={false}
                  onCheckedChange={(c) => {
                    onChange(c ? [...value, o.value] : value.filter((x) => x !== o.value));
                  }}
                  className={menuItem}
                >
                  <CheckBox on={on} />
                  {o.label}
                </Menu.CheckboxItem>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ColumnPicker({
  hidden,
  setHidden,
}: {
  hidden: Set<ColId>;
  setHidden: (s: Set<ColId>) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="flex h-9 items-center gap-1.5 rounded-ctl border border-border bg-card px-3 text-13 font-medium shadow-card hover:bg-hover">
        <Columns3 className="size-4 text-ink-muted" aria-hidden />
        Columns
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={popup}>
            {COLS.filter((c) => c.optional).map((c) => {
              const on = !hidden.has(c.id);
              return (
                <Menu.CheckboxItem
                  key={c.id}
                  checked={on}
                  closeOnClick={false}
                  onCheckedChange={(v) => {
                    const n = new Set(hidden);
                    if (v) n.delete(c.id);
                    else n.add(c.id);
                    setHidden(n);
                  }}
                  className={menuItem}
                >
                  <CheckBox on={on} />
                  {c.header}
                </Menu.CheckboxItem>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Skeleton only when loading takes longer than 300 ms (DIRECTION §5). */
function DelayedSkeleton({ show, density }: { show: boolean; density: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => {
      setVisible(true);
    }, 300);
    return () => {
      clearTimeout(t);
    };
  }, [show]);
  if (!visible) return null;
  return (
    <div aria-hidden className="absolute inset-x-0 top-10 bottom-0 bg-card">
      {Array.from({ length: 14 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-6 border-b border-divider px-3"
          style={{ height: density }}
        >
          <div className="h-3 w-40 rounded bg-surface" />
          <div className="h-3 w-24 rounded bg-surface" />
          <div className="h-3 w-28 rounded bg-surface" />
          <div className="ml-auto h-3 w-16 rounded bg-surface" />
        </div>
      ))}
    </div>
  );
}
