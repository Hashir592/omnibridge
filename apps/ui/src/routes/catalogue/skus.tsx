import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { PackagePlus, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { catalogueApi, type MasterSkuSummary, type VatRate } from '../../auth/api.ts';
import { PageHeader } from '../../components/Card.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { StatusLabel } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { DateCell, EmptyCell, MoneyCell, Sub } from '../../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../../kit/table/DataTable.tsx';
import { Pager } from '../../kit/table/Pager.tsx';
import {
  FilterChips,
  ListToolbar,
  SearchBox,
  ViewTabs,
  type Chip,
} from '../../kit/table/Toolbar.tsx';
import { todayLondon } from '../../lib/dates.ts';
import { formatInt } from '../../lib/format.ts';
import type { PageSize } from '../../lib/paging.ts';
import { NewSkuSheet } from './forms.tsx';
import { ImportCsvDialog, SectionNav } from './parts.tsx';
import { bundleText, ratesOn, vatLabel } from './rules.ts';

export type SkuView = 'all' | 'active' | 'inactive' | 'bundles';

export interface SkusSearch {
  view?: SkuView | undefined;
  q?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/stock/skus');

const VIEWS: Array<{ id: SkuView; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'bundles', label: 'Bundles' },
];

/** The list query for a view (CAT-1, CAT-3). */
export function viewQuery(view: SkuView): { active?: 'true' | 'false'; bundles?: 'true' } {
  if (view === 'active') return { active: 'true' };
  if (view === 'inactive') return { active: 'false' };
  if (view === 'bundles') return { bundles: 'true' };
  return {};
}

export function skuColumns(rates: VatRate[]): Array<DataColumn<MasterSkuSummary>> {
  const current = ratesOn(rates, todayLondon());
  return [
    {
      id: 'sku',
      header: 'SKU',
      width: 280,
      cell: (s) => (
        <>
          <Link
            to="/stock/skus/$skuId"
            params={{ skuId: s.id }}
            className="ref truncate text-13 leading-[18px] font-medium text-ink hover:text-brand-600 hover:underline"
          >
            {s.sku}
          </Link>
          <Sub>{s.title}</Sub>
        </>
      ),
    },
    {
      id: 'kind',
      header: 'Type',
      width: 200,
      cell: (s) =>
        s.bundle ? (
          <>
            <span className="text-13 leading-[18px]">Bundle</span>
            <Sub className="ref">{bundleText(s.bundle)}</Sub>
          </>
        ) : (
          <span className="text-13">Single</span>
        ),
    },
    {
      id: 'vat',
      header: 'VAT type',
      width: 152,
      cell: (s) => (
        <>
          <span className="truncate text-13 leading-[18px]">{vatLabel(s.vat_type, current)}</span>
          {s.bundle && <Sub>From its component</Sub>}
        </>
      ),
    },
    {
      id: 'cogs',
      header: 'COGS',
      width: 120,
      align: 'right',
      cell: (s) =>
        s.cogs_pence === null ? (
          <span className="text-13 text-warning">Not set</span>
        ) : (
          <MoneyCell pence={s.cogs_pence} sub={s.bundle ? 'pack, derived' : 'per unit, ex VAT'} />
        ),
    },
    {
      id: 'listings',
      header: 'Listings',
      width: 96,
      align: 'right',
      cell: (s) =>
        s.listing_count === 0 ? (
          <EmptyCell label="No listings mapped" />
        ) : (
          <span className="num text-13">{formatInt(s.listing_count)}</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 104,
      cell: (s) =>
        s.active ? (
          <StatusLabel tone="success">Active</StatusLabel>
        ) : (
          <StatusLabel tone="neutral">Inactive</StatusLabel>
        ),
    },
    {
      id: 'updated',
      header: 'Updated',
      width: 'minmax(112px,1fr)',
      cell: (s) => <DateCell iso={s.updated_at} />,
    },
  ];
}

export function SkusPage() {
  return (
    <TabGate tab="stock">
      <SkuList />
    </TabGate>
  );
}

function SkuList() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/stock/skus' });
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const view = search.view ?? 'all';
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const setSearch = (patch: Partial<SkusSearch>) =>
    void navigate({
      search: (prev: SkusSearch) => ({ ...prev, page: undefined, ...patch }),
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
    queryKey: ['catalogue-skus', persona, view, search.q, page, size],
    queryFn: () => catalogueApi.skus({ page, limit: size, q: search.q, ...viewQuery(view) }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const rates = useQuery({
    queryKey: ['vat-rates', persona],
    queryFn: catalogueApi.vatRates,
    enabled: !!session,
    staleTime: 60_000,
  });
  const columns = useMemo(() => skuColumns(rates.data ?? []), [rates.data]);
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
          <>
            <Button
              icon={<Upload />}
              className="hidden md:inline-flex"
              onClick={() => {
                setImporting(true);
              }}
            >
              Import COGS
            </Button>
            <Button
              variant="primary"
              icon={<PackagePlus />}
              onClick={() => {
                setCreating(true);
              }}
            >
              New SKU
            </Button>
          </>
        }
      />
      <SectionNav />

      <div className="mt-4">
        <ViewTabs
          label="Master SKU views"
          value={view}
          onChange={(v) => {
            setSearch({ view: v === 'all' ? undefined : v });
          }}
          tabs={VIEWS.map((v) => ({ id: v.id, label: v.label }))}
        />
      </div>

      <ListToolbar>
        <SearchBox
          label="Search by SKU code, title or barcode"
          placeholder="SKU, title or barcode"
          value={qDraft}
          onChange={setQDraft}
        />
      </ListToolbar>
      <FilterChips chips={chips} onClearAll={clearAll} />

      <DataTable
        label="Master SKUs"
        rows={query.data?.items ?? []}
        rowId={(s) => s.id}
        columns={columns}
        rowOffset={(page - 1) * size}
        totalRows={total}
        scrollKey={JSON.stringify([view, page, size, search.q])}
        status={status}
        empty={
          search.q || view !== 'all' ? (
            <EmptyState
              title="No SKUs match"
              body="Clear the search or pick another view to see more SKUs."
              action={{ label: 'Clear filters', onClick: clearAll }}
            />
          ) : (
            <EmptyState
              title="No Master SKUs yet"
              body="Add your first SKU. Listings found on your channels map to these SKUs."
              action={{
                label: 'New SKU',
                onClick: () => {
                  setCreating(true);
                },
              }}
            />
          )
        }
        error={
          <ErrorState
            title="Master SKUs could not load"
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

      <NewSkuSheet
        open={creating}
        onOpenChange={setCreating}
        onCreated={(s) => {
          void qc.invalidateQueries({ queryKey: ['catalogue-skus'] });
          void navigate({ to: '/stock/skus/$skuId', params: { skuId: s.id } });
        }}
      />

      <ImportCsvDialog
        open={importing}
        onOpenChange={setImporting}
        title="Import COGS"
        noun="COGS rows"
        columns={
          <>
            Columns: <span className="ref">sku</span>, <span className="ref">cogs</span> (pounds ex
            VAT, for example 12.34) and <span className="ref">effective_from</span> (DD/MM/YYYY). A
            row with the same SKU and date as an existing one replaces it. Bundles take their
            component&rsquo;s COGS, so leave them out.
          </>
        }
        run={catalogueApi.importCogs}
        onApplied={(r) => {
          void qc.invalidateQueries({ queryKey: ['catalogue-skus'] });
          void qc.invalidateQueries({ queryKey: ['catalogue-sku'] });
          toast({
            title: 'COGS imported',
            description: `${formatInt(r.rows)} rows applied.`,
            tone: 'success',
          });
        }}
      />
    </div>
  );
}
