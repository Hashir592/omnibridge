import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Download, Link2, PackagePlus, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanyBadge } from '../components/badges.tsx';
import { PageHeader } from '../components/Card.tsx';
import { SkuStatus, coverText } from '../components/stock.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { Badge, SignalLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { Combobox } from '../kit/Combobox.tsx';
import { Dialog } from '../kit/Dialog.tsx';
import { Field } from '../kit/Field.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { DateCell, EmptyCell, MoneyCell, Sub } from '../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../kit/table/DataTable.tsx';
import { Pager } from '../kit/table/Pager.tsx';
import {
  ColumnPicker,
  FilterChips,
  FilterMenu,
  ListToolbar,
  SearchBox,
  ViewTabs,
  type Chip,
} from '../kit/table/Toolbar.tsx';
import { cn } from '../lib/cn.ts';
import { formatInt } from '../lib/format.ts';
import type { PageSize } from '../lib/paging.ts';
import { mockApi } from '../mocks/api.ts';
import {
  VAT_LABEL,
  VAT_PARTS,
  type SkuRow,
  type StockView,
  type UnmappedListing,
  type UnmappedPage,
  type VatType,
} from '../mocks/stock.ts';
import type { Company } from '../mocks/types.ts';

export interface StockSearch {
  view?: StockView | undefined;
  q?: string | undefined;
  vat?: string | undefined;
  channel?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/stock');

const VIEWS: Array<{ id: StockView; label: string; alarm?: boolean }> = [
  { id: 'all', label: 'All SKUs' },
  { id: 'low', label: 'Low or out' },
  { id: 'oversold', label: 'Oversold', alarm: true },
  { id: 'sync', label: 'Sync failed' },
  { id: 'bundles', label: 'Bundles' },
  { id: 'unmapped', label: 'Unmapped listings' },
];

const isTablet = () => typeof window !== 'undefined' && window.innerWidth < 1024;
const split = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);

function skuColumns(): Array<DataColumn<SkuRow>> {
  return [
    {
      id: 'sku',
      header: 'SKU',
      width: 248,
      cell: (s) => (
        <>
          <Link
            to="/stock/$skuId"
            params={{ skuId: s.id }}
            className="ref truncate text-13 leading-[18px] font-medium text-ink hover:text-brand-600 hover:underline"
          >
            {s.sku}
          </Link>
          <Sub>{s.title}</Sub>
        </>
      ),
    },
    { id: 'state', header: 'Status', width: 128, cell: (s) => <SkuStatus state={s.state} /> },
    {
      id: 'available',
      header: 'Available',
      width: 112,
      align: 'right',
      cell: (s) => (
        <>
          <span
            className={cn(
              'num text-13 leading-[18px] font-medium',
              s.available < 0 && 'text-danger',
            )}
          >
            {formatInt(s.available)}
          </span>
          <Sub className="num">
            {s.bundle
              ? `${String(s.bundle.pack)}-pack of ${s.bundle.componentSku}`
              : `of ${formatInt(s.onHand ?? 0)} on hand`}
          </Sub>
        </>
      ),
    },
    {
      id: 'reserved',
      header: 'Reserved',
      width: 80,
      align: 'right',
      optional: true,
      cell: (s) =>
        s.bundle ? (
          <EmptyCell label="Bundles have no stock of their own" />
        ) : (
          <span className="num text-13">{formatInt(s.reserved)}</span>
        ),
    },
    {
      id: 'cover',
      header: 'Cover',
      width: 104,
      align: 'right',
      optional: true,
      cell: (s) => (
        <>
          <span
            className={cn(
              'num text-13 leading-[18px]',
              s.coverDays !== null && s.coverDays < 14 && 'font-medium text-warning',
            )}
          >
            {coverText(s.coverDays)}
          </span>
          <Sub>at 30-day rate</Sub>
        </>
      ),
    },
    {
      id: 'listings',
      header: 'Listings',
      width: 172,
      cell: (s) => (
        <>
          <span className="flex items-center gap-1.5">
            {s.listings.channels.map((c) => (
              <span key={c} className="inline-grid grid-cols-[18px] items-center">
                <ChannelMarkGlyph channel={c} />
              </span>
            ))}
            <span className="num text-13 whitespace-nowrap text-ink">
              {formatInt(s.listings.total)} listing{s.listings.total === 1 ? '' : 's'}
            </span>
          </span>
          {s.syncMode === 'auto' ? (
            <Sub>
              {s.listings.fba > 0
                ? `${String(s.listings.fba)} Fulfilled by Amazon`
                : 'Merchant fulfilled'}
            </Sub>
          ) : (
            <span
              title={
                s.syncMode === 'manual'
                  ? 'Manual stock allocation on every listing'
                  : 'Some listings use a manual allocation'
              }
            >
              <Badge>{s.syncMode === 'manual' ? 'Manual' : 'Mixed'}</Badge>
            </span>
          )}
        </>
      ),
    },
    {
      id: 'vat',
      header: 'VAT',
      width: 112,
      optional: true,
      cell: (s) => (
        <>
          <span className="truncate text-13 leading-[18px]">{VAT_PARTS[s.vat][0]}</span>
          <Sub>{VAT_PARTS[s.vat][1]}</Sub>
        </>
      ),
    },
    {
      id: 'cogs',
      header: 'COGS',
      width: 84,
      align: 'right',
      optional: true,
      cell: (s) => <MoneyCell pence={s.cogsPence} sub="per unit" />,
    },
    {
      id: 'moved',
      header: 'Last movement',
      width: 'minmax(112px,1fr)',
      optional: true,
      cell: (s) => <DateCell iso={s.lastMovementAt} />,
    },
  ];
}

/** Just the channel glyph (ChannelMark renders glyph and name as two grid cells). */
function ChannelMarkGlyph({ channel }: { channel: SkuRow['listings']['channels'][number] }) {
  return (
    <span className="contents [&>span:last-child]:sr-only">
      <ChannelMark channel={channel} />
    </span>
  );
}

function unmappedColumns(
  company: (id: string) => Company | undefined,
  onMap: (u: UnmappedListing) => void,
): Array<DataColumn<UnmappedListing>> {
  return [
    {
      id: 'listing',
      header: 'Listing',
      width: 280,
      cell: (u) => (
        <>
          <span className="ref truncate text-13 leading-[18px] font-medium">{u.externalSku}</span>
          <Sub>{u.title}</Sub>
        </>
      ),
    },
    {
      id: 'channel',
      header: 'Channel',
      width: 168,
      cell: (u) => {
        const c = company(u.companyId);
        return (
          <span className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
            <ChannelMark channel={u.channel} />
            {c && <CompanyBadge company={c} full />}
          </span>
        );
      },
    },
    {
      id: 'id',
      header: 'Listing ID',
      width: 144,
      cell: (u) => (
        <>
          <span className="ref truncate text-13 leading-[18px]">{u.externalId}</span>
          <Sub>{u.fulfilment === 'FBA' ? 'Fulfilled by Amazon' : 'Merchant fulfilled'}</Sub>
        </>
      ),
    },
    {
      id: 'found',
      header: 'Found',
      width: 108,
      cell: (u) => <DateCell iso={u.foundAt} time={false} />,
    },
    {
      id: 'orders',
      header: 'Open orders',
      width: 104,
      align: 'right',
      cell: (u) =>
        u.openOrders > 0 ? (
          <>
            <span className="num text-13 leading-[18px] font-medium text-warning">
              {formatInt(u.openOrders)}
            </span>
            <Sub>stock not moving</Sub>
          </>
        ) : (
          <EmptyCell label="No open orders" />
        ),
    },
    {
      id: 'suggest',
      header: 'Suggested match',
      width: 'minmax(200px,1fr)',
      cell: (u) =>
        u.suggestion ? (
          <>
            <span className="ref truncate text-13 leading-[18px]">{u.suggestion.sku}</span>
            <Sub>Similar SKU, not an exact match</Sub>
          </>
        ) : (
          <span className="text-13 text-ink-muted">No close match</span>
        ),
    },
    {
      id: 'action',
      header: 'Action',
      width: 96,
      cell: (u) => (
        <Button
          size="sm"
          icon={<Link2 />}
          onClick={() => {
            onMap(u);
          }}
          aria-label={`Map listing ${u.externalSku}`}
        >
          Map
        </Button>
      ),
    },
  ];
}

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
  const { session, persona, companyId, company } = useAppState();
  const toast = useToast();
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(isTablet() ? ['reserved', 'vat', 'cogs', 'moved'] : []),
  );
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const [mapping, setMapping] = useState<UnmappedListing | null>(null);
  const [mapTo, setMapTo] = useState<string | null>(null);

  const view = search.view ?? 'all';
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
    queryKey: ['skus', persona, companyId, view, search.q, search.vat, search.channel, page, size],
    // The view travels with the answer: SKU rows and unmapped listings have different shapes.
    queryFn: async () => ({
      view,
      page: await mockApi.skus({
        company: companyId,
        view,
        q: search.q,
        vat: search.vat,
        channel: search.channel,
        cursor: (page - 1) * size,
        limit: size,
      }),
    }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const skuCols = useMemo(() => skuColumns(), []);
  const unmappedCols = useMemo(
    () =>
      unmappedColumns(company, (u) => {
        setMapping(u);
        setMapTo(u.suggestion?.id ?? null);
      }),
    [company],
  );
  const allSkus = useQuery({
    queryKey: ['skus-all', persona],
    queryFn: () => mockApi.skus({ limit: 100 }),
    enabled: mapping !== null,
  });

  const data = query.data?.page;
  const counts = data?.counts;
  const total = data?.total ?? 0;
  const sameView = query.data?.view === view;
  const skuRows = sameView && view !== 'unmapped' ? (data?.items as SkuRow[]) : [];
  const unmappedRows = sameView && view === 'unmapped' ? (data as UnmappedPage).items : [];
  const skuOptions = ((allSkus.data?.items ?? []) as SkuRow[]).map((s) => ({
    value: s.id,
    label: `${s.sku} · ${s.title}`,
  }));
  if (mapping?.suggestion && !skuOptions.some((o) => o.value === mapping.suggestion?.id))
    skuOptions.unshift({
      value: mapping.suggestion.id,
      label: `${mapping.suggestion.sku} · ${mapping.suggestion.title}`,
    });
  const status = query.isError ? 'error' : query.isPending ? 'loading' : 'ready';
  const unmapped = view === 'unmapped';

  const clearAll = () => {
    setQDraft('');
    void navigate({ search: { view: search.view, size: search.size }, replace: true });
  };
  const chips: Chip[] = [
    ...split(search.vat).map((v) => ({
      key: `v-${v}`,
      label: `VAT: ${v in VAT_LABEL ? VAT_LABEL[v as VatType] : v}`,
      onRemove: () => {
        setSearch({
          vat:
            split(search.vat)
              .filter((x) => x !== v)
              .join(',') || undefined,
        });
      },
    })),
    ...split(search.channel).map((id) => ({
      key: `c-${id}`,
      label: `Channel: ${session?.channelAccounts.find((a) => a.id === id)?.name ?? id}`,
      onRemove: () => {
        setSearch({
          channel:
            split(search.channel)
              .filter((x) => x !== id)
              .join(',') || undefined,
        });
      },
    })),
  ];
  if (search.q)
    chips.push({
      key: 'q',
      label: `Search: ${search.q}`,
      onRemove: () => {
        setQDraft('');
      },
    });

  const empty = (
    <EmptyState
      title={unmapped ? 'Every listing is mapped' : 'No SKUs match these filters'}
      body={
        unmapped
          ? 'New listings found on your channels appear here when their SKU does not match a Master SKU.'
          : 'Remove a filter or clear the search to see more SKUs.'
      }
      action={unmapped ? undefined : { label: 'Clear filters', onClick: clearAll }}
    />
  );
  const error = (
    <ErrorState
      title="Stock could not load"
      body="The server did not answer. Try again; if it keeps failing, check Status."
      action={{ label: 'Try again', onClick: () => void query.refetch() }}
    />
  );

  return (
    <div className="flex h-full flex-col px-4 pt-2 pb-3 lg:px-6">
      <PageHeader
        title="Stock & Catalogue"
        actions={
          <>
            <Button icon={<Upload />} className="hidden md:inline-flex">
              Import CSV
            </Button>
            <Button icon={<Download />} className="hidden md:inline-flex">
              Export CSV
            </Button>
            <Button variant="primary" icon={<PackagePlus />}>
              Stock in
            </Button>
          </>
        }
      />

      <div className="mt-4">
        <ViewTabs
          label="Stock views"
          value={view}
          onChange={(v) => {
            setSearch({ view: v === 'all' ? undefined : v, vat: undefined });
          }}
          tabs={VIEWS.map((v) => ({
            id: v.id,
            label: v.label,
            ...(v.alarm ? { alarm: true } : {}),
            count: counts?.[v.id],
          }))}
        />
      </div>

      <ListToolbar>
        <SearchBox
          label={unmapped ? 'Search by listing SKU or title' : 'Search by SKU or title'}
          placeholder={unmapped ? 'Listing SKU or title' : 'SKU or title'}
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
        {!unmapped && (
          <FilterMenu
            label="VAT type"
            options={Object.entries(VAT_LABEL).map(([value, label]) => ({ value, label }))}
            value={split(search.vat)}
            onChange={(v) => {
              setSearch({ vat: v.join(',') || undefined });
            }}
          />
        )}
        {!unmapped && (
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-ink-muted xl:flex">
              Cover{' '}
              <SignalLabel
                signal="Estimate"
                title="Days of stock at the last 30 days' sales rate"
              />
            </span>
            <ColumnPicker columns={skuCols} hidden={hidden} onChange={setHidden} />
          </div>
        )}
      </ListToolbar>

      <FilterChips chips={chips} onClearAll={clearAll} />

      {unmapped ? (
        <DataTable
          label="Unmapped listings"
          rows={unmappedRows}
          rowId={(u) => u.id}
          columns={unmappedCols}
          rowOffset={(page - 1) * size}
          totalRows={total}
          scrollKey={JSON.stringify([view, page, size, search.q, search.channel])}
          status={status}
          empty={empty}
          error={error}
        />
      ) : (
        <DataTable
          label="Master SKUs"
          rows={skuRows}
          rowId={(s) => s.id}
          columns={skuCols}
          hidden={hidden}
          rowOffset={(page - 1) * size}
          totalRows={total}
          scrollKey={JSON.stringify([view, page, size, search.q, search.vat, search.channel])}
          status={status}
          empty={empty}
          error={error}
        />
      )}

      <Pager
        page={page}
        size={size}
        total={total}
        noun={unmapped ? 'listings' : 'SKUs'}
        onPage={(p) => {
          setSearch({ page: p === 1 ? undefined : p });
        }}
        onSize={(s) => {
          setSearch({ size: s === 50 ? undefined : s });
        }}
      />

      <Dialog
        open={mapping !== null}
        onOpenChange={(o) => {
          if (!o) setMapping(null);
        }}
        title="Map listing to a Master SKU"
        description={
          mapping && (
            <>
              <span className="ref">{mapping.externalSku}</span> on{' '}
              {session?.channelAccounts.find((a) => a.id === mapping.channelAccountId)?.name}. One
              listing maps to exactly one Master SKU.
            </>
          )
        }
        footer={
          <>
            <Button
              onClick={() => {
                setMapping(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!mapTo}
              onClick={() => {
                setMapping(null);
                toast({
                  title: 'Listing mapped',
                  description: 'Stock now syncs to this listing. Open orders were back-filled.',
                  tone: 'success',
                });
              }}
            >
              Map listing
            </Button>
          </>
        }
      >
        <Field
          label="Master SKU"
          hint={
            mapping && mapping.openOrders > 0
              ? `${String(mapping.openOrders)} open order${mapping.openOrders === 1 ? '' : 's'} will reserve stock once mapped (CAT-6).`
              : 'Stock is pushed to the listing after mapping.'
          }
        >
          <Combobox
            value={mapTo}
            onChange={setMapTo}
            placeholder="Type a SKU or title"
            options={skuOptions}
          />
        </Field>
      </Dialog>
    </div>
  );
}
