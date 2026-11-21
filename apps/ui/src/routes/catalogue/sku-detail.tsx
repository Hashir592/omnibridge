import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { ChevronLeft, Link2Off, Lock, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { catalogueApi, ConsoleError, type MasterSku } from '../../auth/api.ts';
import { Card, DetailRow } from '../../components/Card.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { StatusLabel } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog } from '../../kit/Dialog.tsx';
import { EmptyState, ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { cn } from '../../lib/cn.ts';
import { formatUkDate, todayLondon } from '../../lib/dates.ts';
import { formatInt, formatPence } from '../../lib/format.ts';
import { CogsDialog, EditSkuSheet, VatChangeDialog } from './forms.tsx';
import { AccountCell, InlineError } from './parts.tsx';
import { VAT_NAME, currentOf, formatRate, ratesOn, refusalText, vatLabel } from './rules.ts';

const route = getRouteApi('/stock/skus/$skuId');

export function SkuDetailPage() {
  return (
    <TabGate tab="stock">
      <SkuDetail />
    </TabGate>
  );
}

function SkuDetail() {
  const { skuId } = route.useParams();
  const { session, persona } = useAppState();
  const query = useQuery({
    queryKey: ['catalogue-sku', skuId, persona],
    queryFn: () => catalogueApi.sku(skuId),
    enabled: !!session,
    retry: (n, e) => !(e instanceof ConsoleError && e.status === 404) && n < 2,
  });
  const missing = query.error instanceof ConsoleError && query.error.status === 404;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <Link
          to="/stock/skus"
          className="-ml-1 inline-flex h-8 items-center gap-1 rounded-ctl px-1 text-13 text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden /> Back to Master SKUs
        </Link>
        {query.isError ? (
          <Card className="mt-4 max-w-xl">
            {missing ? (
              <EmptyState
                title="This SKU is not available"
                body="The link may be wrong. Search for the SKU in Master SKUs."
              />
            ) : (
              <ErrorState
                title="The SKU could not load"
                body="The server did not answer. Try again."
                action={{ label: 'Try again', onClick: () => void query.refetch() }}
              />
            )}
          </Card>
        ) : query.data ? (
          <Detail sku={query.data} />
        ) : (
          <div aria-busy className="mt-4 h-40" />
        )}
      </div>
    </div>
  );
}

export function Detail({ sku }: { sku: MasterSku }) {
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [vat, setVat] = useState(false);
  const [cogs, setCogs] = useState(false);
  const [unmap, setUnmap] = useState<MasterSku['listings'][number] | null>(null);
  const [unmapError, setUnmapError] = useState<string | null>(null);
  const rates = useQuery({
    queryKey: ['vat-rates', persona],
    queryFn: catalogueApi.vatRates,
    enabled: !!session,
    staleTime: 60_000,
  });
  const today = todayLondon();
  const current = ratesOn(rates.data ?? [], today);
  const vatNow = currentOf(sku.vat_history, today);
  const cogsNow = currentOf(sku.cogs_history, today);
  const key = ['catalogue-sku', sku.id, persona];
  const saved = (s: MasterSku) => {
    qc.setQueryData(key, s);
    void qc.invalidateQueries({ queryKey: ['catalogue-skus'] });
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['catalogue-sku', sku.id] });
    void qc.invalidateQueries({ queryKey: ['catalogue-skus'] });
  };

  const doUnmap = async (listingId: string) => {
    setUnmapError(null);
    try {
      const r = await catalogueApi.unmapListing(listingId);
      if (!r.ok) {
        setUnmapError(refusalText(r, 'The listing could not be unmapped. Try again.'));
        return;
      }
      refresh();
      void qc.invalidateQueries({ queryKey: ['catalogue-listings'] });
      toast({
        title: 'Listing unmapped',
        description: 'It is back in the Unmapped queue and gets no stock updates.',
        tone: 'info',
      });
    } catch {
      setUnmapError('The server did not answer. Try again.');
    }
  };

  return (
    <>
      <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="ref text-[22px] leading-7 font-semibold tracking-[-0.01em]">
              {sku.sku}
            </h1>
            {sku.active ? (
              <StatusLabel tone="success">Active</StatusLabel>
            ) : (
              <StatusLabel tone="neutral">Inactive</StatusLabel>
            )}
          </div>
          <p className="mt-1 text-sm text-ink">{sku.title}</p>
          <p className="mt-0.5 text-13 text-ink-muted">
            {vatLabel(sku.vat_type, current)}
            {sku.manufacturer && <> · {sku.manufacturer}</>}
            {sku.bundle && (
              <>
                {' '}
                · Bundle of {sku.bundle.pack_size} ×{' '}
                <Link
                  to="/stock/skus/$skuId"
                  params={{ skuId: sku.bundle.component_id }}
                  className="ref text-brand-600 underline underline-offset-2"
                >
                  {sku.bundle.component_sku}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            icon={<Pencil />}
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit details
          </Button>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Details">
            <dl className="px-5 py-1.5">
              <DetailRow label="Short description">{sku.short_description}</DetailRow>
              <DetailRow label="Barcode">
                {sku.barcode ? <span className="ref">{sku.barcode}</span> : <NotSet />}
              </DetailRow>
              <DetailRow label="Manufacturer">{sku.manufacturer ?? <NotSet />}</DetailRow>
              <DetailRow label="Weight">
                <span className="num">{formatInt(sku.weight_g)} g</span>
              </DetailRow>
              <DetailRow label="Dimensions">
                {sku.dimensions ? (
                  <span className="num">
                    {sku.dimensions.length_mm} × {sku.dimensions.width_mm} ×{' '}
                    {sku.dimensions.height_mm} mm
                  </span>
                ) : (
                  <NotSet />
                )}
              </DetailRow>
              <DetailRow label="Purchase VAT rate">
                {sku.purchase_vat_rate_bp === null ? (
                  <span className="text-ink-muted">Same as the VAT type</span>
                ) : (
                  <span className="num">{formatRate(sku.purchase_vat_rate_bp)}</span>
                )}
              </DetailRow>
              <DetailRow label="Reorder">
                <span className="num">
                  {sku.reorder.lead_time_days} days lead, {sku.reorder.safety_days} days safety,{' '}
                  {sku.reorder.target_cover_days} days cover
                </span>
              </DetailRow>
            </dl>
          </Card>

          <Card
            title={`Listings (${formatInt(sku.listings.length)})`}
            aside={
              <Link to="/stock/listings" className="text-brand-600 hover:underline">
                Map more
              </Link>
            }
          >
            {sku.listings.length === 0 ? (
              <EmptyState
                title="No listings mapped"
                body="Map a channel listing to this SKU from the Unmapped queue so its stock syncs."
              />
            ) : (
              <ul aria-label="Mapped listings" className="px-5 py-1.5">
                {sku.listings.map((l) => (
                  <li
                    key={l.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-divider py-2.5 last:border-0"
                  >
                    <span className="min-w-0">
                      <span className="ref block truncate text-13 font-medium">
                        {l.external_sku}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">
                        {l.title ?? 'No title'} · <span className="ref">{l.external_id}</span>
                      </span>
                      <span className="mt-1 block">
                        <AccountCell listing={l} />
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Link2Off />}
                      aria-label={`Unmap listing ${l.external_sku}`}
                      onClick={() => {
                        setUnmap(l);
                      }}
                    >
                      Unmap
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {unmapError && (
              <div className="border-t border-divider px-5 py-3">
                <InlineError>{unmapError}</InlineError>
              </div>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="VAT type"
            aside={
              sku.bundle ? undefined : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setVat(true);
                  }}
                >
                  Change VAT type
                </Button>
              )
            }
          >
            {sku.bundle && <Locked component={sku.bundle.component_sku} what="VAT type" />}
            <History
              label="VAT type history"
              rows={sku.vat_history.map((v) => ({
                key: v.effective_from,
                from: v.effective_from,
                value: vatLabel(v.vat_type, ratesOn(rates.data ?? [], v.effective_from)),
                now: v === vatNow,
                future: v.effective_from > today,
              }))}
              empty="No VAT type set."
            />
            <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
              {VAT_NAME.zero} and {VAT_NAME.no_vat} stay separate: zero-rated sales still go on the
              VAT return. Each order line keeps the type of the day it was placed.
            </p>
          </Card>

          <Card
            title="COGS per unit"
            aside={
              sku.bundle ? undefined : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCogs(true);
                  }}
                >
                  Set COGS
                </Button>
              )
            }
          >
            {sku.bundle ? (
              <>
                <Locked component={sku.bundle.component_sku} what="COGS" />
                <p className="px-5 py-3 text-13">
                  {sku.cogs_pence === null ? (
                    <span className="text-warning">
                      The component has no COGS yet, so this bundle has none.
                    </span>
                  ) : (
                    <>
                      <span className="num font-semibold">{formatPence(sku.cogs_pence)}</span>{' '}
                      <span className="text-ink-muted">
                        today: the component&rsquo;s COGS × {sku.bundle.pack_size}
                      </span>
                    </>
                  )}
                </p>
              </>
            ) : (
              <History
                label="COGS history"
                rows={sku.cogs_history.map((c) => ({
                  key: c.effective_from,
                  from: c.effective_from,
                  value: formatPence(c.cogs_pence),
                  now: c === cogsNow,
                  future: c.effective_from > today,
                  num: true,
                }))}
                empty="No COGS yet. Profit for this SKU shows as missing COGS until you set one."
              />
            )}
            <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
              Ex VAT. Each order line keeps the COGS of the day it was placed, so a change never
              alters past profit.
            </p>
          </Card>
        </div>
      </div>

      {editing && <EditSkuSheet sku={sku} open onOpenChange={setEditing} onSaved={saved} />}
      <VatChangeDialog
        sku={sku}
        open={vat}
        onOpenChange={setVat}
        onSaved={(s) => {
          saved(s);
          toast({ title: 'VAT type changed', description: sku.sku, tone: 'success' });
        }}
      />
      <CogsDialog
        sku={sku}
        open={cogs}
        onOpenChange={setCogs}
        onSaved={() => {
          refresh();
          toast({ title: 'COGS saved', description: sku.sku, tone: 'success' });
        }}
      />
      <ConfirmDialog
        open={unmap !== null}
        onOpenChange={(o) => {
          if (!o) setUnmap(null);
        }}
        title="Unmap this listing?"
        description={
          <>
            <span className="ref">{unmap?.external_sku}</span> goes back to the Unmapped queue and
            gets no stock updates until you map it again.
          </>
        }
        confirmLabel="Unmap listing"
        onConfirm={() => {
          if (unmap) void doUnmap(unmap.id);
          setUnmap(null);
        }}
      />
    </>
  );
}

function NotSet() {
  return <span className="text-ink-muted">Not set</span>;
}

function Locked({ component, what }: { component: string; what: string }) {
  return (
    <p className="flex items-start gap-2 border-b border-divider px-5 py-3 text-13 text-ink-muted">
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        A bundle&rsquo;s {what} follows its component, <span className="ref">{component}</span>.
        Change it there.
      </span>
    </p>
  );
}

function History({
  label,
  rows,
  empty,
}: {
  label: string;
  rows: Array<{
    key: string;
    from: string;
    value: string;
    now: boolean;
    future: boolean;
    num?: boolean;
  }>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="px-5 py-3 text-13 text-ink-muted">{empty}</p>;
  return (
    <ul aria-label={label} className="px-5 py-1.5">
      {rows.map((r) => (
        <li
          key={r.key}
          className="flex items-baseline justify-between gap-4 border-b border-divider py-2.5 text-13 last:border-0"
        >
          <span className={cn(!r.now && !r.future && 'text-ink-muted')}>
            {r.now ? 'Current, from ' : r.future ? 'Scheduled from ' : 'From '}
            <span className="num">{formatUkDate(r.from)}</span>
          </span>
          <span
            className={cn(
              r.num && 'num',
              r.now ? 'font-semibold' : r.future ? 'text-ink' : 'text-ink-muted',
            )}
          >
            {r.value}
          </span>
        </li>
      ))}
    </ul>
  );
}
