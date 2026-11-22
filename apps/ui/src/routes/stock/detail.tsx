import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { ChevronLeft, Download, OctagonAlert, PackagePlus, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { ConsoleError, saveFile, stockApi, type StockDetail } from '../../auth/api.ts';
import { Card, Figure } from '../../components/Card.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { Button } from '../../kit/Button.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { cn } from '../../lib/cn.ts';
import { formatInt, londonDayKey } from '../../lib/format.ts';
import { StockByChannel } from './allocation.tsx';
import { AdjustDialog, StockInDialog } from './dialogs.tsx';
import { MovementsTable, StockStatus } from './parts.tsx';
import { signed, stateOf } from './rules.ts';

const route = getRouteApi('/stock/$skuId');

export function StockDetailPage() {
  return (
    <TabGate tab="stock">
      <Page />
    </TabGate>
  );
}

function Page() {
  const { skuId } = route.useParams();
  const { session, persona } = useAppState();
  const query = useQuery({
    queryKey: ['stock-detail', skuId, persona],
    queryFn: () => stockApi.get(skuId),
    enabled: !!session,
    retry: (n, e) => !(e instanceof ConsoleError && e.status === 404) && n < 2,
    // While a write is on its way, look again until its result is in (INV-8).
    refetchInterval: (q) =>
      q.state.data?.listings.some((l) => l.last_push?.result === 'pending') ? 2_000 : false,
  });
  const missing = query.error instanceof ConsoleError && query.error.status === 404;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <Link
          to="/stock"
          className="-ml-1 inline-flex h-8 items-center gap-1 rounded-ctl px-1 text-13 text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden /> Back to stock
        </Link>
        {query.isError ? (
          <Card className="mt-4 max-w-xl">
            {missing ? (
              <EmptyState
                title="This SKU is not available"
                body="The link may be wrong. Search for the SKU in the stock list."
              />
            ) : (
              <ErrorState
                title="Stock could not load"
                body="The server did not answer. Try again."
                action={{ label: 'Try again', onClick: () => void query.refetch() }}
              />
            )}
          </Card>
        ) : query.data ? (
          <Detail d={query.data} />
        ) : (
          <div aria-busy className="mt-4 h-40" />
        )}
      </div>
    </div>
  );
}

function Detail({ d }: { d: StockDetail }) {
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<'in' | 'adjust' | null>(null);
  const movements = useQuery({
    queryKey: ['movements', persona, { sku_id: d.sku_id }, 1, 20],
    queryFn: () => stockApi.movements({ sku_id: d.sku_id, page: 1, limit: 20 }),
    enabled: !!session && d.bundle === null,
  });
  const fba = d.listings.filter((l) => l.fulfilment === 'fba');
  const moved = () => {
    void qc.invalidateQueries({ queryKey: ['stock-detail'] });
    void qc.invalidateQueries({ queryKey: ['stock'] });
    void qc.invalidateQueries({ queryKey: ['movements'] });
  };
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await stockApi.exportMovements({ sku_id: d.sku_id });
      if (!r.ok) throw new Error(String(r.status));
      saveFile(r.body as Blob, `stock-change-log-${d.sku}-${londonDayKey()}.csv`);
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

  return (
    <>
      <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="ref text-[22px] leading-7 font-semibold tracking-[-0.01em]">{d.sku}</h1>
            <StockStatus state={stateOf(d)} />
          </div>
          <p className="mt-1 text-sm text-ink">{d.title}</p>
          <p className="mt-0.5 text-13 text-ink-muted">
            {d.bundle ? (
              <>
                Bundle of {d.bundle.pack_size} ×{' '}
                <Link
                  to="/stock/$skuId"
                  params={{ skuId: d.bundle.component_id }}
                  className="ref text-brand-600 underline underline-offset-2"
                >
                  {d.bundle.component_sku}
                </Link>
                {' · '}
              </>
            ) : null}
            <Link
              to="/stock/skus/$skuId"
              params={{ skuId: d.sku_id }}
              className="text-brand-600 underline underline-offset-2"
            >
              Catalogue details
            </Link>
          </p>
        </div>
        {!d.bundle && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              icon={<SlidersHorizontal />}
              onClick={() => {
                setDialog('adjust');
              }}
            >
              Adjust stock
            </Button>
            <Button
              variant="primary"
              icon={<PackagePlus />}
              onClick={() => {
                setDialog('in');
              }}
            >
              Stock in
            </Button>
          </div>
        )}
      </div>

      {d.oversold && (
        <p className="mt-4 flex items-start gap-2 text-13 text-danger" role="alert">
          <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Oversold by {formatInt(-d.available)}.</span>{' '}
            <span className="text-ink">
              Orders reserve more than you have on hand. Count the shelf, then stock in or adjust.
            </span>
          </span>
        </p>
      )}
      {d.sync_failed && (
        <p className="mt-4 flex items-start gap-2 text-13 text-warning" role="status">
          <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">A stock push failed after every retry.</span>{' '}
            <span className="text-ink">
              The listing below shows it. It is tried again on the next change.
            </span>
          </span>
        </p>
      )}

      <Card className="mt-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-4">
          <Figure
            label="On hand"
            value={d.bundle ? '-' : formatInt(d.on_hand ?? 0)}
            sub={d.bundle ? 'Uses the component’s stock' : 'Counted in your stock'}
          />
          <Figure
            label="Reserved"
            value={d.bundle ? '-' : formatInt(d.reserved)}
            sub="In orders not yet dispatched"
          />
          <Figure
            label="Available"
            value={
              <span className={cn(d.available < 0 && 'text-danger')}>{formatInt(d.available)}</span>
            }
            sub={
              d.bundle
                ? `Component ÷ ${String(d.bundle.pack_size)}, rounded down`
                : 'On hand minus reserved'
            }
          />
          <Figure
            label="Listings"
            value={formatInt(d.listing_count)}
            sub={
              d.fba_count > 0
                ? `${String(d.fba_count)} Fulfilled by Amazon`
                : 'All merchant fulfilled'
            }
          />
        </div>
      </Card>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <StockByChannel key={d.sku_id} d={d} />

          <Card
            title="Stock movements"
            aside={
              d.bundle ? undefined : (
                <>
                  <Link
                    to="/stock/movements"
                    search={{ sku: d.sku_id }}
                    className="text-brand-600 hover:underline"
                  >
                    All movements
                  </Link>
                  <Button
                    size="sm"
                    icon={<Download />}
                    busy={exporting}
                    onClick={() => void exportCsv()}
                  >
                    Export
                  </Button>
                </>
              )
            }
          >
            {d.bundle ? (
              <EmptyState
                title="No movements of its own"
                body="A bundle moves its component's stock. Open the component to see its movements."
              />
            ) : movements.isError ? (
              <ErrorState
                title="Movements could not load"
                body="The server did not answer. Try again."
                action={{ label: 'Try again', onClick: () => void movements.refetch() }}
              />
            ) : movements.data && movements.data.items.length === 0 ? (
              <EmptyState title="No movements yet" body="Book stock in to start the change log." />
            ) : movements.data ? (
              <MovementsTable rows={movements.data.items} showSku={false} />
            ) : (
              <div aria-busy className="h-24" />
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {fba.length > 0 && (
            <Card title="At Amazon (FBA)">
              <ul className="px-5 py-1.5">
                {fba.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-baseline justify-between gap-4 border-b border-divider py-2.5 text-13 last:border-0"
                  >
                    <span className="ref truncate text-ink-muted">{l.external_id}</span>
                    <span className="num">{formatInt(l.channel_qty ?? 0)} units</span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
                Amazon manages FBA stock. OmniBridge shows it but never pushes to it.
              </p>
            </Card>
          )}
          {d.bundles.length > 0 && (
            <Card title="Bundles of this SKU">
              <ul className="px-5 py-1.5">
                {d.bundles.map((b) => (
                  <li
                    key={b.id}
                    className="flex items-baseline justify-between gap-4 border-b border-divider py-2.5 text-13 last:border-0"
                  >
                    <Link
                      to="/stock/$skuId"
                      params={{ skuId: b.id }}
                      className="ref text-brand-600 underline underline-offset-2"
                    >
                      {b.sku}
                    </Link>
                    <span className="num text-ink-muted">
                      {formatInt(b.available)} available ({b.pack_size}-pack)
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {dialog === 'in' && (
        <StockInDialog
          skuId={d.sku_id}
          sku={d.sku}
          onClose={() => {
            setDialog(null);
          }}
          onDone={(m) => {
            setDialog(null);
            moved();
            toast({
              title: 'Stock booked in',
              description: `${d.sku}: ${signed(m.on_hand_change)}, now ${formatInt(m.on_hand_after)} on hand.`,
              tone: 'success',
            });
          }}
        />
      )}
      {dialog === 'adjust' && (
        <AdjustDialog
          skuId={d.sku_id}
          sku={d.sku}
          onHand={d.on_hand ?? 0}
          onClose={() => {
            setDialog(null);
          }}
          onDone={(m) => {
            setDialog(null);
            moved();
            toast({
              title: 'Stock adjusted',
              description: `${d.sku}: ${signed(m.on_hand_change)}, now ${formatInt(m.on_hand_after)} on hand.`,
              tone: 'success',
            });
          }}
        />
      )}
    </>
  );
}
