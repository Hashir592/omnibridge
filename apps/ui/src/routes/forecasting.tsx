import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { CircleCheck, CircleSlash, Clock, Download, OctagonAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { PageHeader } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { SignalLabel, StatusLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { Sub } from '../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../kit/table/DataTable.tsx';
import { Pager } from '../kit/table/Pager.tsx';
import { ColumnPicker, ListToolbar, SearchBox, ViewTabs } from '../kit/table/Toolbar.tsx';
import { formatInt } from '../lib/format.ts';
import type { PageSize } from '../lib/paging.ts';
import { mockApi } from '../mocks/api.ts';
import type { ForecastRow } from '../mocks/forecast.ts';

export interface ForecastSearch {
  view?: 'now' | 'all' | undefined;
  q?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/forecasting');

const v = (n: number) => `${n.toFixed(1)}/day`;

function Urgency({ f }: { f: ForecastRow }) {
  if (f.urgency === 'now')
    return (
      <StatusLabel tone="danger" icon={OctagonAlert}>
        Reorder now
      </StatusLabel>
    );
  if (f.urgency === 'soon')
    return (
      <StatusLabel tone="warning" icon={Clock}>
        Reorder soon
      </StatusLabel>
    );
  if (f.urgency === 'no_sales')
    return (
      <StatusLabel tone="neutral" icon={CircleSlash}>
        No recent sales
      </StatusLabel>
    );
  return (
    <StatusLabel tone="success" icon={CircleCheck}>
      Enough cover
    </StatusLabel>
  );
}

const columns: Array<DataColumn<ForecastRow>> = [
  {
    id: 'sku',
    header: 'SKU',
    width: 240,
    cell: (f) => (
      <>
        <Link
          to="/stock/$skuId"
          params={{ skuId: f.id }}
          className="ref truncate text-13 leading-[18px] font-medium text-ink hover:text-brand-600 hover:underline"
        >
          {f.sku}
        </Link>
        <Sub>{f.title}</Sub>
      </>
    ),
  },
  { id: 'urgency', header: 'Status', width: 140, cell: (f) => <Urgency f={f} /> },
  {
    id: 'cover',
    header: 'Days of cover',
    width: 120,
    align: 'right',
    cell: (f) => (
      <>
        <span className="num text-13 leading-[18px] font-medium">
          {f.coverDays === null ? '-' : formatInt(f.coverDays)}
        </span>
        <Sub className="num">needs {f.leadDays + f.safetyDays}</Sub>
      </>
    ),
  },
  {
    id: 'available',
    header: 'Available',
    width: 92,
    align: 'right',
    cell: (f) => <span className="num text-13">{formatInt(f.available)}</span>,
  },
  {
    id: 'blended',
    header: 'Blended sales',
    width: 120,
    align: 'right',
    cell: (f) => (
      <>
        <span className="num text-13 leading-[18px]">{v(f.blended)}</span>
        <Sub className="num">weighted 7, 30, 90 days</Sub>
      </>
    ),
  },
  {
    id: 'v7',
    header: '7 days',
    width: 80,
    align: 'right',
    optional: true,
    cell: (f) => <span className="num text-13">{v(f.v7)}</span>,
  },
  {
    id: 'v30',
    header: '30 days',
    width: 80,
    align: 'right',
    optional: true,
    cell: (f) => <span className="num text-13">{v(f.v30)}</span>,
  },
  {
    id: 'v90',
    header: '90 days',
    width: 80,
    align: 'right',
    optional: true,
    cell: (f) => <span className="num text-13">{v(f.v90)}</span>,
  },
  {
    id: 'point',
    header: 'Reorder point',
    width: 112,
    align: 'right',
    cell: (f) => <span className="num text-13">{formatInt(f.reorderPoint)}</span>,
  },
  {
    id: 'suggest',
    header: 'Suggested order',
    width: 'minmax(128px,1fr)',
    align: 'right',
    cell: (f) => (
      <>
        <span className="num text-13 leading-[18px] font-semibold">
          {formatInt(f.suggestQty)} units
        </span>
        <Sub className="num">for {f.targetCoverDays} days of cover</Sub>
      </>
    ),
  },
];

export function ForecastingPage() {
  return (
    <TabGate tab="forecasting">
      <Forecasting />
    </TabGate>
  );
}

function Forecasting() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/forecasting' });
  const { session, persona } = useAppState();
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(['v7', 'v30', 'v90']));
  const view = search.view ?? 'reorder';
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const setSearch = (patch: Partial<ForecastSearch>) =>
    void navigate({
      search: (prev: ForecastSearch) => ({ ...prev, page: undefined, ...patch }),
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
  const q = useQuery({
    queryKey: ['forecast', persona, view, search.q, page, size],
    queryFn: () => mockApi.forecast({ view, q: search.q, cursor: (page - 1) * size, limit: size }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const cols = useMemo(() => columns, []);

  return (
    <div className="flex h-full flex-col px-4 pt-2 pb-3 lg:px-6">
      <PageHeader
        title="Forecasting"
        sub={
          <span className="flex items-center gap-1.5">
            Statistical formulas only, from your own sales <SignalLabel signal="Estimate" />
          </span>
        }
        actions={<Button icon={<Download />}>Export CSV</Button>}
      />
      <div className="mt-4">
        <ViewTabs<'now' | 'reorder' | 'all'>
          label="Forecast views"
          value={view}
          onChange={(x) => {
            setSearch({ view: x === 'reorder' ? undefined : x });
          }}
          tabs={[
            { id: 'now', label: 'Reorder now', alarm: true, count: q.data?.counts.now },
            { id: 'reorder', label: 'Now or soon', count: q.data?.counts.reorder },
            { id: 'all', label: 'All SKUs', count: q.data?.counts.all },
          ]}
        />
      </div>
      <ListToolbar>
        <SearchBox
          label="Search by SKU or title"
          placeholder="SKU or title"
          value={qDraft}
          onChange={setQDraft}
        />
        <span className="hidden text-xs text-ink-muted lg:inline">
          Reorder when days of cover fall below lead time plus safety days.
        </span>
        <div className="ml-auto">
          <ColumnPicker columns={cols} hidden={hidden} onChange={setHidden} />
        </div>
      </ListToolbar>
      <DataTable
        label="Forecast"
        rows={q.data?.items ?? []}
        rowId={(f) => f.id}
        columns={cols}
        hidden={hidden}
        rowOffset={(page - 1) * size}
        totalRows={q.data?.total ?? 0}
        scrollKey={JSON.stringify([view, search.q, page, size])}
        status={q.isError ? 'error' : q.isPending ? 'loading' : 'ready'}
        empty={
          <EmptyState
            title="Nothing needs reordering"
            body="Every SKU has more cover than its lead time and safety days. Check All SKUs for the full list."
          />
        }
        error={
          <ErrorState
            title="The forecast could not load"
            body="The server did not answer. Try again; if it keeps failing, check Status."
            action={{ label: 'Try again', onClick: () => void q.refetch() }}
          />
        }
      />
      <Pager
        page={page}
        size={size}
        total={q.data?.total ?? 0}
        noun="SKUs"
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
