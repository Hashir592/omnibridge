import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Download, Link2, Link2Off, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { catalogueApi, saveFile, type CatalogueListing } from '../../auth/api.ts';
import { PageHeader } from '../../components/Card.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog, Dialog } from '../../kit/Dialog.tsx';
import { Field } from '../../kit/Field.tsx';
import { Select } from '../../kit/Select.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { DateCell, Sub } from '../../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../../kit/table/DataTable.tsx';
import { Pager } from '../../kit/table/Pager.tsx';
import {
  FilterChips,
  ListToolbar,
  SearchBox,
  ViewTabs,
  type Chip,
} from '../../kit/table/Toolbar.tsx';
import { formatDate, londonDayKey } from '../../lib/format.ts';
import type { PageSize } from '../../lib/paging.ts';
import { AccountCell, ImportCsvDialog, InlineError, SectionNav, SkuPicker } from './parts.tsx';
import { refusalText } from './rules.ts';

export type ListingView = 'unmapped' | 'mapped' | 'all';

export interface ListingsSearch {
  view?: Exclude<ListingView, 'unmapped'> | undefined;
  q?: string | undefined;
  account?: string | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/stock/listings');

const VIEWS: Array<{ id: ListingView; label: string }> = [
  { id: 'unmapped', label: 'Unmapped' },
  { id: 'mapped', label: 'Mapped' },
  { id: 'all', label: 'All listings' },
];

/** CAT-5: the Unmapped queue is `mapped=false`. */
export function mappedParam(view: ListingView): 'true' | 'false' | undefined {
  return view === 'unmapped' ? 'false' : view === 'mapped' ? 'true' : undefined;
}

/** "Fulfilled by Amazon", "Merchant fulfilled", "Inventory API" or nothing. */
export function fulfilmentText(
  l: Pick<CatalogueListing, 'fulfilment' | 'inventory_api'>,
): string | null {
  if (l.fulfilment === 'fba') return 'Fulfilled by Amazon';
  if (l.fulfilment === 'mfn') return 'Merchant fulfilled';
  if (l.inventory_api === true) return 'Inventory API';
  if (l.inventory_api === false) return 'Trading API listing';
  return null;
}

export function listingColumns(
  onMap: (l: CatalogueListing) => void,
  onUnmap: (l: CatalogueListing) => void,
): Array<DataColumn<CatalogueListing>> {
  return [
    {
      id: 'listing',
      header: 'Listing',
      width: 300,
      cell: (l) => (
        <>
          <span className="ref truncate text-13 leading-[18px] font-medium">{l.external_sku}</span>
          <Sub>{l.title ?? 'No title'}</Sub>
        </>
      ),
    },
    {
      id: 'account',
      header: 'Channel',
      width: 200,
      cell: (l) => <AccountCell listing={l} />,
    },
    {
      id: 'id',
      header: 'Listing ID',
      width: 168,
      cell: (l) => {
        const f = fulfilmentText(l);
        return (
          <>
            <span className="ref truncate text-13 leading-[18px]">{l.external_id}</span>
            {f && <Sub>{f}</Sub>}
          </>
        );
      },
    },
    {
      id: 'found',
      header: 'Found',
      width: 112,
      cell: (l) => <DateCell iso={l.discovered_at} time={false} />,
    },
    {
      id: 'sku',
      header: 'Master SKU',
      width: 'minmax(180px,1fr)',
      cell: (l) =>
        l.master_sku ? (
          <>
            <Link
              to="/stock/skus/$skuId"
              params={{ skuId: l.master_sku.id }}
              className="ref truncate text-13 leading-[18px] text-brand-600 hover:underline"
            >
              {l.master_sku.sku}
            </Link>
            {l.mapped_at && <Sub className="num">Mapped {formatDate(l.mapped_at)}</Sub>}
          </>
        ) : (
          <>
            <span className="text-13 leading-[18px] text-warning">Not mapped</span>
            <Sub>No stock updates</Sub>
          </>
        ),
    },
    {
      id: 'action',
      header: 'Action',
      width: 112,
      cell: (l) =>
        l.master_sku ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Link2Off />}
            onClick={() => {
              onUnmap(l);
            }}
            aria-label={`Unmap listing ${l.external_sku}`}
          >
            Unmap
          </Button>
        ) : (
          <Button
            size="sm"
            icon={<Link2 />}
            onClick={() => {
              onMap(l);
            }}
            aria-label={`Map listing ${l.external_sku}`}
          >
            Map
          </Button>
        ),
    },
  ];
}

export function ListingsPage() {
  return (
    <TabGate tab="stock">
      <Listings />
    </TabGate>
  );
}

function Listings() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/stock/listings' });
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const [mapping, setMapping] = useState<CatalogueListing | null>(null);
  const [unmapping, setUnmapping] = useState<CatalogueListing | null>(null);
  const [importing, setImporting] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const view: ListingView = search.view ?? 'unmapped';
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const setSearch = (patch: Partial<ListingsSearch>) =>
    void navigate({
      search: (prev: ListingsSearch) => ({ ...prev, page: undefined, ...patch }),
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
    queryKey: ['catalogue-listings', persona, view, search.q, search.account, page, size],
    queryFn: () =>
      catalogueApi.listings({
        page,
        limit: size,
        q: search.q,
        mapped: mappedParam(view),
        channel_account_id: search.account,
      }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const columns = useMemo(
    () =>
      listingColumns(
        (l) => {
          setRowError(null);
          setMapping(l);
        },
        (l) => {
          setRowError(null);
          setUnmapping(l);
        },
      ),
    [],
  );
  const total = query.data?.total ?? 0;
  const status = query.isError ? 'error' : query.isPending ? 'loading' : 'ready';
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ['catalogue-listings'] });
    void qc.invalidateQueries({ queryKey: ['catalogue-skus'] });
    void qc.invalidateQueries({ queryKey: ['catalogue-sku'] });
  };

  const accounts = session?.channelAccounts ?? [];
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'Another account';
  const clearAll = () => {
    setQDraft('');
    void navigate({ search: { view: search.view, size: search.size }, replace: true });
  };
  const chips: Chip[] = [];
  if (search.account)
    chips.push({
      key: 'a',
      label: `Account: ${accountName(search.account)}`,
      onRemove: () => {
        setSearch({ account: undefined });
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

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await catalogueApi.exportMappings();
      if (!r.ok) throw new Error(String(r.status));
      saveFile(r.body as Blob, `listing-mappings-${londonDayKey()}.csv`);
    } catch {
      toast({
        title: 'The export could not be downloaded',
        description: 'Try again.',
        tone: 'error',
      });
    } finally {
      setExporting(false);
    }
  };

  const unmap = async (l: CatalogueListing) => {
    try {
      const r = await catalogueApi.unmapListing(l.id);
      if (!r.ok) {
        setRowError(refusalText(r, 'The listing could not be unmapped. Try again.'));
        return;
      }
      changed();
      toast({
        title: 'Listing unmapped',
        description: `${l.external_sku} is back in the Unmapped queue.`,
        tone: 'info',
      });
    } catch {
      setRowError('The server did not answer. Try again.');
    }
  };

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
              Import mappings
            </Button>
            <Button
              icon={<Download />}
              className="hidden md:inline-flex"
              busy={exporting}
              onClick={() => void exportCsv()}
            >
              Export mappings
            </Button>
          </>
        }
      />
      <SectionNav />

      <div className="mt-4">
        <ViewTabs
          label="Listing views"
          value={view}
          onChange={(v) => {
            setSearch({ view: v === 'unmapped' ? undefined : v });
          }}
          tabs={VIEWS.map((v) => ({ id: v.id, label: v.label }))}
        />
      </div>

      <ListToolbar>
        <SearchBox
          label="Search by listing SKU, listing ID or title"
          placeholder="Listing SKU, ID or title"
          value={qDraft}
          onChange={setQDraft}
        />
        <Select
          label="Channel account"
          className="w-56"
          options={[
            { value: 'all', label: 'All accounts' },
            ...accounts.map((a) => ({ value: a.id, label: a.name })),
            // A shared link may name an account of a company this user does not hold.
            ...(search.account && !accounts.some((a) => a.id === search.account)
              ? [{ value: search.account, label: 'Another account' }]
              : []),
          ]}
          value={search.account ?? 'all'}
          onChange={(v) => {
            setSearch({ account: v && v !== 'all' ? v : undefined });
          }}
        />
      </ListToolbar>
      <FilterChips chips={chips} onClearAll={clearAll} />
      {rowError && (
        <div className="mb-2">
          <InlineError>{rowError}</InlineError>
        </div>
      )}

      <DataTable
        label={view === 'unmapped' ? 'Unmapped listings' : 'Listings'}
        rows={query.data?.items ?? []}
        rowId={(l) => l.id}
        columns={columns}
        rowOffset={(page - 1) * size}
        totalRows={total}
        scrollKey={JSON.stringify([view, page, size, search.q, search.account])}
        status={status}
        empty={
          view === 'unmapped' && !search.q && !search.account ? (
            <EmptyState
              title="Every listing is mapped"
              body="Listings found on your channels appear here when their SKU matches no Master SKU. Stock syncs only to mapped listings."
              action={{
                label: 'See all listings',
                onClick: () => {
                  setSearch({ view: 'all' });
                },
              }}
            />
          ) : (
            <EmptyState
              title="No listings match"
              body="Clear the search or the account filter to see more listings."
              action={{ label: 'Clear filters', onClick: clearAll }}
            />
          )
        }
        error={
          <ErrorState
            title="Listings could not load"
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
        noun="listings"
        onPage={(p) => {
          setSearch({ page: p === 1 ? undefined : p });
        }}
        onSize={(s) => {
          setSearch({ size: s === 50 ? undefined : s });
        }}
      />

      {mapping && (
        <MapDialog
          listing={mapping}
          accountName={accountName(mapping.channel_account_id)}
          onClose={() => {
            setMapping(null);
          }}
          onMapped={(l) => {
            setMapping(null);
            changed();
            toast({
              title: 'Listing mapped',
              description: `${l.external_sku} → ${l.master_sku?.sku ?? ''}. Stock now syncs to it.`,
              tone: 'success',
            });
          }}
        />
      )}

      <ConfirmDialog
        open={unmapping !== null}
        onOpenChange={(o) => {
          if (!o) setUnmapping(null);
        }}
        title="Unmap this listing?"
        description={
          <>
            <span className="ref">{unmapping?.external_sku}</span> goes back to the Unmapped queue
            and gets no stock updates until you map it again.
          </>
        }
        confirmLabel="Unmap listing"
        onConfirm={() => {
          if (unmapping) void unmap(unmapping);
          setUnmapping(null);
        }}
      />

      <ImportCsvDialog
        open={importing}
        onOpenChange={setImporting}
        title="Import mappings"
        noun="mappings"
        columns={
          <>
            Columns: <span className="ref">listing_id</span> (from the export) and{' '}
            <span className="ref">sku</span> (the Master SKU code). An empty{' '}
            <span className="ref">sku</span> unmaps the listing. Start from Export mappings, edit
            the <span className="ref">sku</span> column, then import it.
          </>
        }
        run={catalogueApi.importMappings}
        onApplied={(r) => {
          changed();
          toast({
            title: 'Mappings imported',
            description: `${String(r.rows)} rows applied. Stock syncs to newly mapped listings.`,
            tone: 'success',
          });
        }}
      />
    </div>
  );
}

/** CAT-5: one listing maps to exactly one Master SKU; 409 when it is mapped to another. */
function MapDialog({
  listing,
  accountName,
  onClose,
  onMapped,
}: {
  listing: CatalogueListing;
  accountName: string;
  onClose: () => void;
  onMapped: (l: CatalogueListing) => void;
}) {
  const [skuId, setSkuId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!skuId) {
      setError('Choose the Master SKU for this listing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await catalogueApi.mapListing(listing.id, skuId);
      if (r.ok) onMapped(r.body as CatalogueListing);
      else setError(refusalText(r, 'The listing could not be mapped. Try again.'));
    } catch {
      setError('The server did not answer. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Map listing to a Master SKU"
      description={
        <>
          <span className="ref">{listing.external_sku}</span> on {accountName}. One listing maps to
          exactly one Master SKU.
        </>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Map listing
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Master SKU"
          hint="Stock is pushed to the listing once it is mapped. Open orders on it then reserve stock."
        >
          <SkuPicker value={skuId} onChange={setSkuId} initialQuery={listing.external_sku} />
        </Field>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Dialog>
  );
}
