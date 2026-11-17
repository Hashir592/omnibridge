import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Tooltip } from '@base-ui/react/tooltip';
import { Download, Link2Off, OctagonAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import {
  GROUP_TONE,
  GroupChip,
  GroupNotes,
  GroupPosition,
  GroupRail,
  NotSameBuyerDialog,
  ShipTogetherDialog,
} from '../components/sameBuyer.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { EmptyCell, MoneyCell, Sub } from '../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../kit/table/DataTable.tsx';
import { Pager } from '../kit/table/Pager.tsx';
import {
  BulkAction,
  BulkBar,
  ColumnPicker,
  FilterChips,
  FilterMenu,
  ListToolbar,
  SearchBox,
  ViewTabs,
  type Chip,
} from '../kit/table/Toolbar.tsx';
import { cn } from '../lib/cn.ts';
import { daysFromToday, formatDate, formatInt, formatTime, overdueText } from '../lib/format.ts';
import type { PageSize } from '../lib/paging.ts';
import { mockApi } from '../mocks/api.ts';
import type {
  Company,
  OrderFlag,
  OrderListItem,
  OrderRow,
  OrderRowGroup,
  OrderStatus,
} from '../mocks/types.ts';

export interface OrdersSearch {
  view?: 'all' | 'awaiting' | 'overdue' | 'today' | 'flagged' | undefined;
  q?: string | undefined;
  channel?: string | undefined;
  status?: string | undefined;
  flag?: string | undefined;
  /** C1 "View all": orders placed today (London day). */
  placed?: 'today' | undefined;
  /** C3 "+1 related order not shown": only this same-buyer group, whatever the filters. */
  group?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/orders');

interface GroupActions {
  shipTogether: (groupId: string) => void;
  notSame: (group: OrderRowGroup) => void;
  showGroup: (groupId: string) => void;
}

/** The same-buyer rail at the row's left edge (C3); module scope keeps it stable for the table. */
const groupAccent = (o: OrderListItem) => (o.group ? <GroupRail group={o.group} /> : null);
const groupTone = (o: OrderListItem) => (o.group ? GROUP_TONE : undefined);

function orderColumns(
  company: (id: string) => Company | undefined,
  groups: GroupActions,
): Array<DataColumn<OrderListItem>> {
  return [
    {
      id: 'order',
      header: 'Order',
      width: 212,
      cell: (o) => (
        <>
          <Link
            to="/orders/$orderId"
            params={{ orderId: o.id }}
            className="ref truncate text-13 leading-[18px] font-medium text-ink hover:text-brand-600 hover:underline"
          >
            {o.ref}
          </Link>
          <span className="flex min-w-0 items-center gap-2">
            <Sub className="num shrink-0">{whenLabel(o.placedAt)}</Sub>
            {o.group && o.group.index > 0 && <GroupPosition group={o.group} />}
            {o.group?.index === 0 && (
              <GroupChip
                group={o.group}
                onShipTogether={() => {
                  groups.shipTogether(o.group?.id ?? '');
                }}
                onNotSame={() => {
                  if (o.group) groups.notSame(o.group);
                }}
                onShowGroup={() => {
                  groups.showGroup(o.group?.id ?? '');
                }}
              />
            )}
          </span>
        </>
      ),
    },
    {
      id: 'sku',
      header: 'SKU',
      width: 160,
      optional: true,
      cell: (o) => <SkuCell o={o} />,
    },
    {
      id: 'channel',
      header: 'Channel',
      width: 140,
      cell: (o) => {
        const c = company(o.companyId);
        return (
          <span className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
            <ChannelMark channel={o.channel} />
            {c && <CompanyBadge company={c} full />}
          </span>
        );
      },
    },
    { id: 'status', header: 'Status', width: 136, cell: (o) => <StatusChip status={o.status} /> },
    { id: 'shipBy', header: 'Ship by', width: 132, cell: (o) => <ShipBy o={o} /> },
    {
      id: 'total',
      header: 'Total',
      width: 84,
      align: 'right',
      cell: (o) => <MoneyCell pence={o.totalPence} strong />,
    },
    {
      id: 'items',
      header: 'Items',
      width: 52,
      align: 'right',
      optional: true,
      cell: (o) => <span className="num text-13">{o.itemCount}</span>,
    },
    {
      id: 'shipTo',
      header: 'Ship to',
      width: 108,
      optional: true,
      cell: (o) => <span className="truncate text-13 text-ink-muted">{o.shipToMasked}</span>,
    },
    {
      id: 'shipping',
      header: 'Shipping',
      width: 124,
      optional: true,
      cell: (o) => <Shipping o={o} />,
    },
    {
      id: 'flags',
      header: 'Flags',
      width: 'minmax(104px,1fr)',
      optional: true,
      cell: (o) =>
        o.group?.index === 0 && (o.group.warnings.length > 0 || o.group.hidden > 0) ? (
          <GroupNotes
            group={o.group}
            onShowGroup={() => {
              groups.showGroup(o.group?.id ?? '');
            }}
          />
        ) : o.flags.length === 0 ? (
          <EmptyCell label="No flags" />
        ) : (
          <span className="flex max-h-[18px] min-w-0 flex-wrap gap-x-2.5 overflow-hidden">
            {o.flags.map((x) => (
              <FlagMark key={x} flag={x} />
            ))}
          </span>
        ),
    },
  ];
}

/** Tablet (NFR-8): the columns a packer needs first. */
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
  const [hidden, setHidden] = useState<Set<string>>(
    // Items, Ship to and Shipping start in the Columns menu: the SKU column shows "+N", and the
    // Flags column needs room for same-buyer group notes (C2, C3).
    () =>
      new Set(
        isTablet() ? ['items', 'shipTo', 'shipping', 'sku'] : ['items', 'shipTo', 'shipping'],
      ),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const [shipGroup, setShipGroup] = useState<string | null>(null);
  const [notSame, setNotSame] = useState<OrderRowGroup | null>(null);

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

  const columns = useMemo(
    () =>
      orderColumns(company, {
        shipTogether: setShipGroup,
        notSame: setNotSame,
        showGroup: (groupId) => {
          setQDraft('');
          void navigate({ search: { group: groupId } });
        },
      }),
    [company, navigate],
  );

  const view = search.view ?? 'all';
  const filterKey = [
    companyId,
    persona,
    view,
    search.q,
    search.channel,
    search.status,
    search.flag,
    search.placed,
    search.group,
  ];
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const scrollKey = JSON.stringify([...filterKey, page, size]);

  // Selection belongs to the page on screen, so the bulk counts always match the rows shown.
  useEffect(() => {
    setSelected(new Set());
  }, [scrollKey]);

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
        placed: search.placed,
        group: search.group,
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

  // A page past the end (an old link, or fewer orders after switching company) goes to the last page.
  useEffect(() => {
    if (query.data && page > pageCount)
      setSearch({ page: pageCount === 1 ? undefined : pageCount });
  }, [query.data, page, pageCount]);

  const removeFrom = (key: 'channel' | 'status' | 'flag', id: string) => () => {
    setSearch({
      [key]:
        split(search[key])
          .filter((x) => x !== id)
          .join(',') || undefined,
    });
  };
  const chips: Chip[] = [
    ...split(search.channel).map((id) => ({
      key: `c-${id}`,
      label: `Channel: ${session?.channelAccounts.find((x) => x.id === id)?.name ?? id}`,
      onRemove: removeFrom('channel', id),
    })),
    ...split(search.status).map((id) => ({
      key: `s-${id}`,
      label: `Status: ${id in STATUS ? STATUS[id as OrderStatus].label : id}`,
      onRemove: removeFrom('status', id),
    })),
    ...split(search.flag).map((id) => ({
      key: `f-${id}`,
      label: `Flag: ${id in FLAG ? FLAG[id as OrderFlag].label : id}`,
      onRemove: removeFrom('flag', id),
    })),
  ];
  if (search.placed)
    chips.push({
      key: 'placed',
      label: 'Placed: Today',
      onRemove: () => {
        setSearch({ placed: undefined });
      },
    });
  if (search.group)
    chips.push({
      key: 'group',
      label: 'Same-buyer group',
      onRemove: () => {
        setSearch({ group: undefined });
      },
    });
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
      <div className="mt-4">
        <ViewTabs
          label="Order views"
          value={view}
          onChange={(v) => {
            setSearch({ view: v === 'all' ? undefined : v });
          }}
          tabs={VIEWS.map((v) => ({
            ...v,
            alarm: v.id === 'overdue',
            count:
              counts &&
              {
                all: counts.all,
                awaiting: counts.awaiting,
                today: counts.dueToday,
                overdue: counts.overdue,
                flagged: counts.flagged,
              }[v.id],
          }))}
        />
      </div>

      <ListToolbar
        bulk={
          selected.size > 0 && (
            <BulkBar
              count={selected.size}
              pageRows={rows.length}
              onSelectPage={() => {
                setSelected(new Set(rows.map((r) => r.id)));
              }}
              onClear={() => {
                setSelected(new Set());
              }}
              note={
                labelable < selected.size &&
                `${formatInt(selected.size - labelable)} not awaiting dispatch will be skipped for labels`
              }
            >
              <BulkAction primary disabled={labelable === 0}>
                Create labels{labelable > 0 ? ` (${formatInt(labelable)})` : ''}
              </BulkAction>
              <BulkAction>Print packing slips</BulkAction>
              <BulkAction>Export selected</BulkAction>
            </BulkBar>
          )
        }
      >
        <SearchBox
          label="Search by order ref or SKU"
          placeholder="Order ref or SKU"
          value={qDraft}
          onChange={setQDraft}
        />
        <FilterMenu
          label="Channel"
          options={(session?.channelAccounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
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
          <ColumnPicker columns={columns} hidden={hidden} onChange={setHidden} />
        </div>
      </ListToolbar>

      <FilterChips chips={chips} onClearAll={clearAll} />

      <DataTable
        label="Orders"
        rows={rows}
        rowId={(o) => o.id}
        rowLabel={(o) => `Select order ${o.ref}`}
        columns={columns}
        rowAccent={groupAccent}
        rowTone={groupTone}
        hidden={hidden}
        selected={selected}
        onSelectedChange={setSelected}
        rowOffset={(page - 1) * size}
        totalRows={total}
        scrollKey={scrollKey}
        status={query.isError ? 'error' : query.isPending ? 'loading' : 'ready'}
        empty={
          <EmptyState
            title="No orders match these filters"
            body="Remove a filter or switch to Combined to see more orders."
            action={{ label: 'Clear filters', onClick: clearAll }}
          />
        }
        error={
          <ErrorState
            title="Orders could not load"
            body="The server did not answer. Try again; if it keeps failing, check Status."
            action={{ label: 'Try again', onClick: () => void query.refetch() }}
          />
        }
      />

      {shipGroup && (
        <ShipTogetherDialog
          groupId={shipGroup}
          onOpenChange={(o) => {
            if (!o) setShipGroup(null);
          }}
        />
      )}
      {notSame && (
        <NotSameBuyerDialog
          group={notSame}
          onOpenChange={(o) => {
            if (!o) setNotSame(null);
          }}
        />
      )}

      <Pager
        page={page}
        size={size}
        total={total}
        noun="orders"
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

/** C2: the first line's SKU, and "+N" with a tooltip listing every SKU and quantity. */
function SkuCell({ o }: { o: OrderListItem }) {
  const [first, ...rest] = o.skus;
  if (!first) return <EmptyCell label="No items" />;
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        {!first.mapped && (
          <Link2Off className="size-3.5 shrink-0 text-warning" aria-label="Unmapped" />
        )}
        <span className="ref truncate text-13 leading-[18px]">{first.sku}</span>
        {rest.length > 0 && (
          <Tooltip.Root>
            <Tooltip.Trigger
              aria-label={`All SKUs: ${o.skus.map((l) => `${l.sku} × ${String(l.qty)}`).join(', ')}`}
              className="num shrink-0 rounded-full bg-[#e2e5ea] px-1.5 text-[11px] leading-4 font-medium text-ink-muted hover:bg-[#d6dae0]"
            >
              +{rest.length}
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Positioner sideOffset={6} className="z-50">
                <Tooltip.Popup className="rounded-ctl border border-border bg-card px-3 py-2 text-xs shadow-pop">
                  <ul className="flex flex-col gap-1">
                    {o.skus.map((l) => (
                      <li key={l.sku} className="flex justify-between gap-4">
                        <span className="ref">{l.sku}</span>
                        <span className="num text-ink-muted">× {l.qty}</span>
                      </li>
                    ))}
                  </ul>
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        )}
      </span>
      <Sub className="num">
        {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
        {!first.mapped && ', unmapped'}
      </Sub>
    </>
  );
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
