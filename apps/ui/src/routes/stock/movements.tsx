import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Clock, Download } from 'lucide-react';
import { useMemo } from 'react';
import { useAppState } from '../../app/session.tsx';
import {
  saveFile,
  stockApi,
  type Movement,
  type MovementFilter,
  type MovementKind,
} from '../../auth/api.ts';
import { PageHeader } from '../../components/Card.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { StatusLabel } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { DatePicker } from '../../kit/DatePicker.tsx';
import { Select } from '../../kit/Select.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { DateCell, Sub } from '../../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../../kit/table/DataTable.tsx';
import { Pager } from '../../kit/table/Pager.tsx';
import { FilterChips, ListToolbar, type Chip } from '../../kit/table/Toolbar.tsx';
import { cn } from '../../lib/cn.ts';
import { formatUkDate } from '../../lib/dates.ts';
import { formatInt, londonDayKey } from '../../lib/format.ts';
import type { PageSize } from '../../lib/paging.ts';
import { SectionNav } from '../catalogue/parts.tsx';
import { KIND_LABEL, REASON_LABEL, pushesText, signed, sourceText } from './rules.ts';

export interface MovementsSearch {
  sku?: string | undefined;
  kind?: MovementKind | undefined;
  source?: 'order' | 'user' | 'system' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/stock/movements');

export const KINDS = Object.keys(KIND_LABEL) as MovementKind[];
const SOURCES = [
  { value: 'order', label: 'Orders' },
  { value: 'user', label: 'People' },
  { value: 'system', label: 'OmniBridge' },
] as const;

/** The URL's filters as the route's query (INV-5: filter and export share them). */
export function movementFilter(s: MovementsSearch): MovementFilter {
  return { sku_id: s.sku, kind: s.kind, source: s.source, from: s.from, to: s.to };
}

function columns(me: string | undefined): Array<DataColumn<Movement>> {
  return [
    { id: 'at', header: 'When', width: 120, cell: (m) => <DateCell iso={m.at} /> },
    {
      id: 'sku',
      header: 'SKU',
      width: 180,
      cell: (m) => (
        <Link
          to="/stock/$skuId"
          params={{ skuId: m.sku_id }}
          className="ref truncate text-13 text-ink hover:text-brand-600 hover:underline"
        >
          {m.sku}
        </Link>
      ),
    },
    {
      id: 'change',
      header: 'Change',
      width: 104,
      align: 'right',
      cell: (m) => (
        <>
          <span
            className={cn(
              'num text-13 leading-[18px] font-medium',
              m.on_hand_change > 0 && 'text-success',
            )}
          >
            {signed(m.on_hand_change)}
          </span>
          {m.reserved_change !== 0 && (
            <Sub className="num">{signed(m.reserved_change)} reserved</Sub>
          )}
        </>
      ),
    },
    {
      id: 'after',
      header: 'On hand after',
      width: 112,
      align: 'right',
      cell: (m) => <span className="num text-13">{formatInt(m.on_hand_after)}</span>,
    },
    {
      id: 'what',
      header: 'What',
      width: 'minmax(260px,1fr)',
      cell: (m) => {
        const detail = [
          m.reason ? REASON_LABEL[m.reason] : null,
          m.supplier ? `From ${m.supplier}` : null,
          m.note,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <>
            <span className="truncate text-13 leading-[18px]">{KIND_LABEL[m.kind]}</span>
            <Sub>
              {sourceText(m.source, me)}
              {detail && ` · ${detail}`}
            </Sub>
          </>
        );
      },
    },
    {
      id: 'pushes',
      header: 'Listings pushed',
      width: 168,
      cell: (m) => {
        const p = pushesText(m.pushes);
        return p.tone === 'none' ? (
          <span className="text-13 text-ink-muted">{p.text}</span>
        ) : (
          <StatusLabel
            tone={p.tone === 'ok' ? 'success' : p.tone === 'bad' ? 'danger' : 'warning'}
            {...(p.tone === 'wait' ? { icon: Clock } : {})}
          >
            {p.text}
          </StatusLabel>
        );
      },
    },
  ];
}

export function MovementsPage() {
  return (
    <TabGate tab="stock">
      <Movements />
    </TabGate>
  );
}

function Movements() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/stock/movements' });
  const { session, persona } = useAppState();
  const toast = useToast();
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const setSearch = (patch: Partial<MovementsSearch>) =>
    void navigate({
      search: (prev: MovementsSearch) => ({ ...prev, page: undefined, ...patch }),
      replace: !('page' in patch),
    });
  const filter = movementFilter(search);

  const query = useQuery({
    queryKey: ['movements', persona, filter, page, size],
    queryFn: () => stockApi.movements({ ...filter, page, limit: size }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const cols = useMemo(() => columns(session?.userId), [session?.userId]);
  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const status = query.isError ? 'error' : query.isPending ? 'loading' : 'ready';
  const skuCode = rows.find((m) => m.sku_id === search.sku)?.sku;

  const chips: Chip[] = [];
  if (search.sku)
    chips.push({
      key: 'sku',
      label: `SKU: ${skuCode ?? 'one SKU'}`,
      onRemove: () => {
        setSearch({ sku: undefined });
      },
    });
  if (search.from)
    chips.push({
      key: 'from',
      label: `From ${formatUkDate(search.from)}`,
      onRemove: () => {
        setSearch({ from: undefined });
      },
    });
  if (search.to)
    chips.push({
      key: 'to',
      label: `To ${formatUkDate(search.to)}`,
      onRemove: () => {
        setSearch({ to: undefined });
      },
    });
  const clearAll = () => {
    void navigate({ search: { size: search.size }, replace: true });
  };

  const exportCsv = async () => {
    try {
      const r = await stockApi.exportMovements(filter);
      if (!r.ok) throw new Error(String(r.status));
      saveFile(r.body as Blob, `stock-change-log-${londonDayKey()}.csv`);
    } catch {
      toast({
        title: 'The export could not be downloaded',
        description: 'Narrow the dates or pick a SKU, then try again.',
        tone: 'error',
      });
    }
  };

  return (
    <div className="flex h-full flex-col px-4 pt-2 pb-3 lg:px-6">
      <PageHeader
        title="Stock & Catalogue"
        actions={
          <Button icon={<Download />} onClick={() => void exportCsv()}>
            Export CSV
          </Button>
        }
      />
      <SectionNav />

      <ListToolbar>
        <Select
          label="Kind"
          className="w-48"
          options={[
            { value: 'all', label: 'Every kind' },
            ...KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
          ]}
          value={search.kind ?? 'all'}
          onChange={(v) => {
            setSearch({ kind: v && v !== 'all' ? (v as MovementKind) : undefined });
          }}
        />
        <Select
          label="Source"
          className="w-40"
          options={[{ value: 'all', label: 'Every source' }, ...SOURCES]}
          value={search.source ?? 'all'}
          onChange={(v) => {
            setSearch({
              source: v && v !== 'all' ? (v as MovementsSearch['source']) : undefined,
            });
          }}
        />
        <span className="flex items-center gap-2 text-13 text-ink-muted">
          From
          <DatePicker
            className="w-40"
            value={search.from ?? null}
            {...(search.to ? { max: search.to } : {})}
            onChange={(v) => {
              setSearch({ from: v ?? undefined });
            }}
          />
          to
          <DatePicker
            className="w-40"
            value={search.to ?? null}
            {...(search.from ? { min: search.from } : {})}
            onChange={(v) => {
              setSearch({ to: v ?? undefined });
            }}
          />
        </span>
      </ListToolbar>
      <FilterChips chips={chips} onClearAll={clearAll} />

      <DataTable
        label="Stock change log"
        rows={rows}
        rowId={(m) => m.id}
        columns={cols}
        rowOffset={(page - 1) * size}
        totalRows={total}
        scrollKey={JSON.stringify([filter, page, size])}
        status={status}
        empty={
          <EmptyState
            title="No movements match"
            body="Widen the dates or clear a filter. Every order, stock-in, adjustment and stock-take shows here."
            action={{ label: 'Clear filters', onClick: clearAll }}
          />
        }
        error={
          <ErrorState
            title="The change log could not load"
            body="The server did not answer. Try again."
            action={{ label: 'Try again', onClick: () => void query.refetch() }}
          />
        }
      />
      <Pager
        page={page}
        size={size}
        total={total}
        totalCapped={query.data?.totalCapped ?? false}
        noun="movements"
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
