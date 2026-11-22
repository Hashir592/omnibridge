import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { stockApi, type StockRow } from '../../auth/api.ts';
import { PageHeader } from '../../components/Card.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { Badge } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { DateCell, EmptyCell, Sub } from '../../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../../kit/table/DataTable.tsx';
import { Pager } from '../../kit/table/Pager.tsx';
import {
  FilterChips,
  ListToolbar,
  SearchBox,
  ViewTabs,
  type Chip,
} from '../../kit/table/Toolbar.tsx';
import { cn } from '../../lib/cn.ts';
import { formatInt } from '../../lib/format.ts';
import type { PageSize } from '../../lib/paging.ts';
import { ImportCsvDialog, SectionNav } from '../catalogue/parts.tsx';
import { StockStatus } from './parts.tsx';
import { filterOf, stateOf, syncLabel, type StockView } from './rules.ts';

export interface StockSearch {
  /** 'unmapped' is an old link to the queue that moved to Listings (T-0316). */
  view?: Exclude<StockView, 'all'> | 'unmapped' | undefined;
  q?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/stock');

const VIEWS: Array<{ id: StockView; label: string; alarm?: boolean }> = [
  { id: 'all', label: 'All SKUs' },
  { id: 'oversold', label: 'Oversold', alarm: true },
  { id: 'sync', label: 'Sync failed' },
  { id: 'manual', label: 'Manual allocation' },
  { id: 'bundles', label: 'Bundles' },
];

export const stockColumns: Array<DataColumn<StockRow>> = [
  {
    id: 'sku',
    header: 'SKU',
    width: 260,
    cell: (s) => (
      <>
        <Link
          to="/stock/$skuId"
          params={{ skuId: s.sku_id }}
          className="ref truncate text-13 leading-[18px] font-medium text-ink hover:text-brand-600 hover:underline"
        >
          {s.sku}
        </Link>
        <Sub>{s.title}</Sub>
      </>
    ),
  },
  { id: 'state', header: 'Status', width: 132, cell: (s) => <StockStatus state={stateOf(s)} /> },
  {
    id: 'available',
    header: 'Available',
    width: 136,
    align: 'right',
    cell: (s) => (
      <>
        <span
          className={cn('num text-13 leading-[18px] font-medium', s.available < 0 && 'text-danger')}
        >
          {formatInt(s.available)}
        </span>
        <Sub className="num">
          {s.bundle
            ? `${String(s.bundle.pack_size)}-pack of ${s.bundle.component_sku}`
            : `of ${formatInt(s.on_hand ?? 0)} on hand`}
        </Sub>
      </>
    ),
  },
  {
    id: 'reserved',
    header: 'Reserved',
    width: 88,
    align: 'right',
    cell: (s) =>
      s.bundle ? (
        <EmptyCell label="Bundles have no stock of their own" />
      ) : (
        <span className="num text-13">{formatInt(s.reserved)}</span>
      ),
  },
  {
    id: 'listings',
    header: 'Listings',
    width: 176,
    cell: (s) =>
      s.listing_count === 0 ? (
        <>
          <span className="text-13 leading-[18px] text-ink-muted">No listings</span>
          <Sub>Map one in Listings</Sub>
        </>
      ) : (
        <>
          <span className="num text-13 leading-[18px]">
            {formatInt(s.listing_count)} listing{s.listing_count === 1 ? '' : 's'}
          </span>
          {s.sync_mode === 'auto' ? (
            <Sub>{s.fba_count > 0 ? `${String(s.fba_count)} Fulfilled by Amazon` : 'Auto'}</Sub>
          ) : (
            <span
              title={
                s.sync_mode === 'manual'
                  ? 'Manual allocation on every merchant-fulfilled listing'
                  : 'Some listings use a manual allocation'
              }
            >
              <Badge>{syncLabel(s.sync_mode)}</Badge>
            </span>
          )}
        </>
      ),
  },
  {
    id: 'moved',
    header: 'Last movement',
    width: 'minmax(120px,1fr)',
    cell: (s) =>
      s.last_movement_at ? (
        <DateCell iso={s.last_movement_at} />
      ) : (
        <EmptyCell label="No movements yet" />
      ),
  },
];

export function StockPage() {
  return (
    <TabGate tab="stock">
      <StockList />
    </TabGate>
  );
}

function StockList() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/stock' });
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const [taking, setTaking] = useState(false);

  const view: StockView = search.view === 'unmapped' ? 'all' : (search.view ?? 'all');
  useEffect(() => {
    if (search.view === 'unmapped') void navigate({ to: '/stock/listings', replace: true });
  }, [search.view]);
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const setSearch = (patch: Partial<StockSearch>) =>
    void navigate({
      search: (prev: StockSearch) => ({ ...prev, page: undefined, ...patch }),
      replace: !('page' in patch),
    });

  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== qDraft) setSearch({ q: qDraft || undefined });
    }, 200);
    return () => {
      clearTimeout(t);
    };
  }, [qDraft]);

  const query = useQuery({
    queryKey: ['stock', persona, view, search.q, page, size],
    queryFn: () => stockApi.list({ page, limit: size, q: search.q, filter: filterOf(view) }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  // The Oversold count is worth showing on its tab (INV-6); the server pages it cheaply.
  const oversold = useQuery({
    queryKey: ['stock-oversold-count', persona],
    queryFn: () => stockApi.list({ page: 1, limit: 20, filter: 'oversold' }),
    enabled: !!session,
  });
  const total = query.data?.total ?? 0;
  const status = query.isError ? 'error' : query.isPending ? 'loading' : 'ready';

  const clearAll = () => {
    setQDraft('');
    void navigate({ search: { view: search.view, size: search.size }, replace: true });
  };
  const chips: Chip[] = search.q
    ? [
        {
          key: 'q',
          label: `Search: ${search.q}`,
          onRemove: () => {
            setQDraft('');
          },
        },
      ]
    : [];

  return (
    <div className="flex h-full flex-col px-4 pt-2 pb-3 lg:px-6">
      <PageHeader
        title="Stock & Catalogue"
        actions={
          <Button
            icon={<Upload />}
            className="hidden md:inline-flex"
            onClick={() => {
              setTaking(true);
            }}
          >
            Import stock-take
          </Button>
        }
      />
      <SectionNav />

      <div className="mt-4">
        <ViewTabs
          label="Stock views"
          value={view}
          onChange={(v) => {
            setSearch({ view: v === 'all' ? undefined : v });
          }}
          tabs={VIEWS.map((v) =>
            v.id === 'oversold'
              ? { id: v.id, label: v.label, alarm: true, count: oversold.data?.total }
              : { id: v.id, label: v.label },
          )}
        />
      </div>

      <ListToolbar>
        <SearchBox
          label="Search by SKU or title"
          placeholder="SKU or title"
          value={qDraft}
          onChange={setQDraft}
        />
      </ListToolbar>
      <FilterChips chips={chips} onClearAll={clearAll} />

      <DataTable
        label="Stock by SKU"
        rows={query.data?.items ?? []}
        rowId={(s) => s.sku_id}
        columns={stockColumns}
        rowOffset={(page - 1) * size}
        totalRows={total}
        scrollKey={JSON.stringify([view, page, size, search.q])}
        status={status}
        empty={
          view === 'oversold' && !search.q ? (
            <EmptyState
              title="Nothing is oversold"
              body="A SKU shows here when orders reserve more than you have on hand."
            />
          ) : (
            <EmptyState
              title="No SKUs match"
              body="Clear the search or pick another view to see more SKUs."
              action={{ label: 'Clear filters', onClick: clearAll }}
            />
          )
        }
        error={
          <ErrorState
            title="Stock could not load"
            body="The server did not answer. Try again; if it keeps failing, check Status."
            action={{ label: 'Try again', onClick: () => void query.refetch() }}
          />
        }
      />

      <Pager
        page={page}
        size={size}
        total={total}
        totalCapped={query.data?.totalCapped ?? false}
        noun="SKUs"
        onPage={(p) => {
          setSearch({ page: p === 1 ? undefined : p });
        }}
        onSize={(s) => {
          setSearch({ size: s === 50 ? undefined : s });
        }}
      />

      <ImportCsvDialog
        open={taking}
        onOpenChange={setTaking}
        title="Import stock-take"
        noun="counts"
        columns={
          <>
            Columns: <span className="ref">sku</span> and <span className="ref">on_hand</span> (the
            number you counted). Each SKU whose count differs gets one stock-take movement, and its
            listings are updated. Bundles have no stock of their own, so count their component.
          </>
        }
        run={stockApi.importStockTake}
        onApplied={(r) => {
          void qc.invalidateQueries({ queryKey: ['stock'] });
          void qc.invalidateQueries({ queryKey: ['stock-detail'] });
          void qc.invalidateQueries({ queryKey: ['movements'] });
          toast({
            title: 'Stock-take imported',
            description: `${formatInt(r.rows)} counts applied.`,
            tone: 'success',
          });
        }}
      />
    </div>
  );
}
