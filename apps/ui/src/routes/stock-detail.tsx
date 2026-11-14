import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import {
  ChevronLeft,
  CircleCheck,
  CircleSlash,
  Clock,
  OctagonAlert,
  PackagePlus,
  Pencil,
  SlidersHorizontal,
  TriangleAlert,
  Warehouse,
} from 'lucide-react';
import { useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanySwatch } from '../components/badges.tsx';
import { Card, DetailRow, Figure, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { SkuStatus, coverText } from '../components/stock.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { SignalLabel, StatusLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { ConfirmDialog, Dialog } from '../kit/Dialog.tsx';
import { Field, Input } from '../kit/Field.tsx';
import { Select } from '../kit/Select.tsx';
import { EmptyState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatDateTime, formatInt, formatPence, formatTime } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import {
  VAT_LABEL,
  autoPushResults,
  targetOf,
  type Listing,
  type SkuDetail,
} from '../mocks/stock.ts';

const route = getRouteApi('/stock/$skuId');

export function StockDetailPage() {
  return (
    <TabGate tab="stock">
      <StockDetail />
    </TabGate>
  );
}

function StockDetail() {
  const { skuId } = route.useParams();
  const { session, persona } = useAppState();
  const query = useQuery({
    queryKey: ['sku', skuId, persona],
    queryFn: () => mockApi.sku(skuId),
    enabled: !!session,
    retry: false,
  });
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
            <EmptyState
              title="This SKU is not available"
              body="The link may be wrong, or the SKU was deleted. Search for it in the stock list."
            />
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

function Detail({ d }: { d: SkuDetail }) {
  const s = d.sku;
  const toast = useToast();
  const [adjust, setAdjust] = useState(false);
  const merchant = d.listings.filter((l) => l.fulfilment === 'MFN');
  const fba = d.listings.filter((l) => l.fulfilment === 'FBA');

  return (
    <>
      <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="ref text-[22px] leading-7 font-semibold tracking-[-0.01em]">{s.sku}</h1>
            <SkuStatus state={s.state} />
          </div>
          <p className="mt-1 text-sm text-ink">{s.title}</p>
          <p className="mt-0.5 text-13 text-ink-muted">
            {s.manufacturer} · {VAT_LABEL[s.vat]}
            {s.bundle && (
              <>
                {' '}
                · Bundle of {s.bundle.pack} ×{' '}
                <Link
                  to="/stock/$skuId"
                  params={{ skuId: s.bundle.componentId }}
                  className="ref text-brand-600 hover:underline"
                >
                  {s.bundle.componentSku}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button icon={<Pencil />}>Edit SKU</Button>
          {!s.bundle && (
            <>
              <Button
                icon={<SlidersHorizontal />}
                onClick={() => {
                  setAdjust(true);
                }}
              >
                Adjust stock
              </Button>
              <Button variant="primary" icon={<PackagePlus />}>
                Stock in
              </Button>
            </>
          )}
        </div>
      </div>

      {s.state === 'oversold' && (
        <p className="mt-4 flex items-start gap-2 text-13 text-danger" role="alert">
          <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Oversold by {formatInt(-s.available)}.</span>{' '}
            <span className="text-ink">
              Orders reserve more than you have on hand. Count the shelf, then stock in or adjust.
            </span>
          </span>
        </p>
      )}
      {s.state === 'sync_failed' && (
        <p className="mt-4 flex items-start gap-2 text-13 text-warning" role="status">
          <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">A stock push failed after every retry.</span>{' '}
            <span className="text-ink">
              The listing below shows the last result. It retries on the next change.
            </span>
          </span>
        </p>
      )}

      <Card className="mt-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-5">
          <Figure
            label="On hand"
            value={s.bundle ? '-' : formatInt(s.onHand ?? 0)}
            sub={s.bundle ? 'Uses the component’s stock' : 'Counted in your stock'}
          />
          <Figure
            label="Reserved"
            value={s.bundle ? '-' : formatInt(s.reserved)}
            sub="In orders not yet dispatched"
          />
          <Figure
            label="Available"
            value={
              <span className={cn(s.available < 0 && 'text-danger')}>{formatInt(s.available)}</span>
            }
            sub={
              s.bundle ? `floor(component ÷ ${String(s.bundle.pack)})` : 'On hand minus reserved'
            }
          />
          <Figure
            label={
              <>
                Cover <SignalLabel signal="Estimate" />
              </>
            }
            value={coverText(s.coverDays)}
            sub={`${formatInt(d.sold30)} sold in 30 days`}
          />
          <Figure
            label={
              <>
                Suggested reorder <SignalLabel signal="Estimate" />
              </>
            }
            value={s.bundle ? '-' : `${formatInt(d.reorder.suggestUnits)} units`}
            sub={`Lead time ${String(d.reorder.leadDays)} days`}
          />
        </div>
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <StockByChannel key={d.sku.id} d={d} />

          <Card title="Stock movements" aside={<Button size="sm">Export</Button>}>
            {d.movements.length === 0 ? (
              <EmptyState
                title="No movements of its own"
                body="A bundle moves its component's stock. Open the component SKU to see its movements."
              />
            ) : (
              <SimpleTable
                label="Stock movements"
                head={[
                  { label: 'When' },
                  { label: 'Change', align: 'right' },
                  { label: 'On hand after', align: 'right' },
                  { label: 'Reason' },
                  { label: 'Listings pushed' },
                ]}
              >
                {d.movements.map((m) => (
                  <Tr key={m.id}>
                    <Td>
                      <Stack
                        value={<span className="num">{formatDate(m.at)}</span>}
                        sub={formatTime(m.at)}
                      />
                    </Td>
                    <Td align="right">
                      <span className={cn('font-medium', m.change > 0 && 'text-success')}>
                        {m.change > 0
                          ? `+${String(m.change)}`
                          : m.change === 0
                            ? '0'
                            : `−${String(-m.change)}`}
                      </span>
                    </Td>
                    <Td align="right">{formatInt(m.onHandAfter)}</Td>
                    <Td>
                      <Stack
                        value={m.reason}
                        sub={
                          m.source.type === 'order' ? (
                            <Link
                              to="/orders/$orderId"
                              params={{ orderId: m.source.orderId }}
                              className="ref text-brand-600 hover:underline"
                            >
                              Order {m.source.ref}
                            </Link>
                          ) : (
                            `By ${m.source.name}`
                          )
                        }
                      />
                    </Td>
                    <Td>
                      {m.pushed === 0 ? (
                        <span className="text-ink-muted">No change to push</span>
                      ) : m.pushFailed > 0 ? (
                        <StatusLabel tone="warning">
                          {m.pushed - m.pushFailed} of {m.pushed} sent
                        </StatusLabel>
                      ) : (
                        <StatusLabel tone="success">{m.pushed} sent</StatusLabel>
                      )}
                    </Td>
                  </Tr>
                ))}
              </SimpleTable>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Card title="Stock by location">
            <dl className="px-5 py-1.5">
              <DetailRow
                label={
                  <span className="flex items-center gap-2">
                    <Warehouse className="size-4" aria-hidden /> Your stock
                  </span>
                }
              >
                <Stack
                  value={
                    <span className="num">
                      {s.bundle ? 'From component' : `${formatInt(s.onHand ?? 0)} on hand`}
                    </span>
                  }
                  sub={`Feeds ${String(merchant.length)} merchant-fulfilled listing${merchant.length === 1 ? '' : 's'}`}
                />
              </DetailRow>
              {fba.map((l) => (
                <AccountLocation key={l.id} l={l} />
              ))}
            </dl>
            <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
              Amazon manages FBA stock. OmniBridge shows it but never pushes to it (INV-9).
            </p>
          </Card>

          <Card
            title="Details"
            aside={
              <Button size="sm" variant="ghost">
                Edit
              </Button>
            }
          >
            <dl className="px-5 py-1.5">
              <DetailRow label="Short description">{d.description}</DetailRow>
              <DetailRow label="Barcode">
                {d.barcode ? (
                  <span className="ref">{d.barcode}</span>
                ) : (
                  <span className="text-ink-muted">Not set</span>
                )}
              </DetailRow>
              <DetailRow label="Weight">
                <span className="num">{formatInt(d.weightGrams)} g</span>
              </DetailRow>
              <DetailRow label="Dimensions">
                {d.dimensionsMm ? (
                  <span className="num">{d.dimensionsMm.join(' × ')} mm</span>
                ) : (
                  <span className="text-ink-muted">Not set</span>
                )}
              </DetailRow>
              <DetailRow label="VAT type">{VAT_LABEL[s.vat]}</DetailRow>
              <DetailRow label="Status">{s.active ? 'Active' : 'Inactive'}</DetailRow>
            </dl>
          </Card>

          <Card
            title="COGS per unit"
            aside={
              <Button size="sm" variant="ghost">
                Add new COGS
              </Button>
            }
          >
            <ul className="px-5 py-1.5">
              {d.cogsHistory.map((c, i) => (
                <li
                  key={c.from}
                  className="flex items-baseline justify-between gap-4 border-b border-divider py-2.5 text-13 last:border-0"
                >
                  <span className={cn(i > 0 && 'text-ink-muted')}>
                    {i === 0 ? 'Current, from ' : 'From '}
                    <span className="num">{formatDate(c.from)}</span>
                    <span className="block text-xs text-ink-muted">{c.by}</span>
                  </span>
                  <span className={cn('num', i === 0 ? 'font-semibold' : 'text-ink-muted')}>
                    {formatPence(c.pence)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
              Each order line keeps the COGS of the day it was placed, so a change never alters past
              profit (CAT-4).
            </p>
          </Card>

          <Card title="Reorder settings">
            <dl className="px-5 py-1.5">
              <DetailRow label="Lead time">{d.reorder.leadDays} days</DetailRow>
              <DetailRow label="Safety stock">{d.reorder.safetyDays} days</DetailRow>
              <DetailRow label="Target cover">{d.reorder.targetCoverDays} days</DetailRow>
            </dl>
          </Card>

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
                      className="ref text-brand-600 hover:underline"
                    >
                      {b.sku}
                    </Link>
                    <span className="num text-ink-muted">
                      {formatInt(b.available)} available ({b.pack}-pack)
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {adjust && (
        <AdjustDialog
          open
          onOpenChange={setAdjust}
          onHand={s.onHand ?? 0}
          onSave={() => {
            setAdjust(false);
            toast({
              title: 'Stock adjusted',
              description: 'The new quantity is queued for every listing.',
              tone: 'success',
            });
          }}
        />
      )}
    </>
  );
}

function ListingRow({ l }: { l: Listing }) {
  const { session, company } = useAppState();
  const account = session?.channelAccounts.find((a) => a.id === l.channelAccountId);
  const c = company(l.companyId);
  return (
    <Tr>
      <Td>
        <span className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          <ChannelMark channel={l.channel} />
          {c && (
            <>
              <span aria-hidden className="grid place-items-center">
                <CompanySwatch company={c} />
              </span>
              <span className="truncate text-xs text-ink-muted">{account?.name}</span>
            </>
          )}
        </span>
      </Td>
      <Td>
        <Stack
          value={<span className="ref">{l.externalSku}</span>}
          sub={<span className="ref">{l.externalId}</span>}
        />
      </Td>
      <Td align="right">
        {l.fulfilment === 'FBA' ? (
          <span className="text-ink-faint" aria-label="No buffer for FBA">
            -
          </span>
        ) : (
          <Stack
            value={formatInt(l.buffer)}
            sub={l.bufferOverride ? 'This listing' : 'Account default'}
          />
        )}
      </Td>
      <Td align="right">{l.channelQty === null ? '-' : formatInt(l.channelQty)}</Td>
      <Td>
        {l.fulfilment === 'FBA' ? (
          <Stack value="Fulfilled by Amazon" sub="Not pushed" />
        ) : l.lastPush ? (
          <Stack
            value={
              l.lastPush.result === 'sent' ? (
                <StatusLabel tone="success" icon={CircleCheck}>
                  Sent
                </StatusLabel>
              ) : l.lastPush.result === 'held' ? (
                <StatusLabel tone="warning" icon={Clock}>
                  Held: eBay revision limit
                </StatusLabel>
              ) : (
                <StatusLabel tone="warning">Sync failed</StatusLabel>
              )
            }
            sub={<span className="num">{formatDateTime(l.lastPush.at)}</span>}
          />
        ) : (
          <span className="text-ink-muted">Never pushed</span>
        )}
      </Td>
    </Tr>
  );
}

function AccountLocation({ l }: { l: Listing }) {
  const { session } = useAppState();
  const account = session?.channelAccounts.find((a) => a.id === l.channelAccountId);
  return (
    <DetailRow
      label={
        <span className="flex items-center gap-2">
          <Warehouse className="size-4" aria-hidden /> Amazon FBA
        </span>
      }
    >
      <Stack
        value={<span className="num">{formatInt(l.channelQty ?? 0)} at Amazon</span>}
        sub={account?.name}
      />
    </DetailRow>
  );
}

const REASONS = [
  { value: 'damaged', label: 'Damaged' },
  { value: 'count', label: 'Count correction' },
  { value: 'lost', label: 'Lost' },
  { value: 'other', label: 'Other' },
];

function AdjustDialog({
  open,
  onOpenChange,
  onHand,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onHand: number;
  onSave: () => void;
}) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const n = Number(qty);
  const qtyError =
    qty.trim() === '' || !Number.isInteger(n)
      ? 'Enter a whole number, for example -2 or 5'
      : onHand + n < 0
        ? `On hand cannot go below 0 (now ${String(onHand)})`
        : undefined;
  const reasonError = !reason
    ? 'Choose a reason'
    : reason === 'other' && note.trim() === ''
      ? 'Say what happened'
      : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust stock"
      description={`On hand now: ${formatInt(onHand)}. Every adjustment needs a reason and is logged (INV-3).`}
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setTried(true);
              if (!qtyError && !reasonError) onSave();
            }}
          >
            Save adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Change"
          hint="Use a minus sign to take stock off"
          error={tried ? qtyError : undefined}
          required
        >
          <Input value={qty} onChange={setQty} inputMode="numeric" placeholder="-2" />
        </Field>
        <Field label="Reason" error={tried && !reason ? reasonError : undefined} required>
          <Select options={REASONS} value={reason} onChange={setReason} />
        </Field>
        <Field
          label="Note"
          hint="Do not enter customer details"
          error={tried && reason === 'other' ? reasonError : undefined}
          required={reason === 'other'}
        >
          <Input value={note} onChange={setNote} />
        </Field>
      </div>
    </Dialog>
  );
}

/* ---------- Stock by channel, with manual allocation (client change C7, INV-10) ---------- */

type PushResult = { listingId: string; result: 'sent' | 'held' | 'failed' };

function StockByChannel({ d }: { d: SkuDetail }) {
  const toast = useToast();
  const available = d.sku.available;
  const mfn = d.listings.filter((l) => l.fulfilment === 'MFN');
  const startMode: 'auto' | 'manual' =
    mfn.length > 0 && mfn.every((l) => l.mode === 'manual') ? 'manual' : 'auto';
  const [mode, setMode] = useState<'auto' | 'manual'>(startMode);
  // The quantity typed per listing. Switching to Manual starts from what each listing shows now.
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(mfn.map((l) => [l.id, String(l.manual?.qty ?? l.channelQty ?? 0)])),
  );
  const [confirm, setConfirm] = useState<'save' | 'auto' | null>(null);
  const [results, setResults] = useState<PushResult[] | null>(null);
  const mixed = startMode === 'auto' && mfn.some((l) => l.mode === 'manual');

  const numberOf = (id: string) => {
    const n = Number(qty[id]);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const sold = (l: Listing) => (l.manual ? l.manual.sold : 0);
  const live = (l: Listing): Listing => {
    const n = numberOf(l.id);
    return mode === 'manual' && l.fulfilment === 'MFN'
      ? {
          ...l,
          mode: 'manual',
          manual: {
            qty: n ?? 0,
            sold: sold(l),
            setAt: l.manual?.setAt ?? '',
            setBy: l.manual?.setBy ?? '',
          },
        }
      : { ...l, mode: 'auto', manual: null };
  };
  const allocated = mfn.reduce((a, l) => a + (numberOf(l.id) ?? 0), 0);
  const invalid = mfn.some((l) => numberOf(l.id) === null);

  if (d.listings.length === 0)
    return (
      <Card title="Stock by channel">
        <EmptyState
          title="No listings on your channels"
          body="Map a listing to this SKU from Unmapped listings, or list it on a channel."
        />
      </Card>
    );

  return (
    <Card
      title="Stock by channel"
      aside={
        d.sku.bundle ? (
          <span className="text-xs text-ink-muted">A bundle follows its component's stock</span>
        ) : (
          <div role="radiogroup" aria-label="Stock sync" className="flex items-center gap-2">
            <span className="text-xs text-ink-muted">Stock sync</span>
            <span className="flex rounded-full border border-border p-0.5">
              {(['auto', 'manual'] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => {
                    if (m === mode) return;
                    if (m === 'auto') setConfirm('auto');
                    else {
                      setMode('manual');
                      setResults(null);
                    }
                  }}
                  className={cn(
                    'h-7 rounded-full px-3 text-13 font-medium',
                    mode === m ? 'bg-side text-white' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {m === 'auto' ? 'Auto' : 'Manual'}
                </button>
              ))}
            </span>
          </div>
        )
      }
    >
      <p className="border-b border-divider px-5 py-3 text-13 text-ink-muted">
        {mode === 'manual'
          ? 'You choose how many each listing shows. A listing never shows more than you have: target = the lower of (allocation − sold since set) and (available − buffer).'
          : mixed
            ? 'Mixed: some listings use a manual allocation, the rest follow available stock.'
            : 'Every listing shows available − buffer, never below 0.'}
      </p>

      {results && (
        <div role="status" className="border-b border-divider px-5 py-3">
          <p className="text-13 font-medium">Back on Auto: every listing was pushed</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {results.map((r) => {
              const l = d.listings.find((x) => x.id === r.listingId);
              const name = l ? accountName(l) : r.listingId;
              return (
                <li key={r.listingId} className="flex items-center justify-between gap-3 text-13">
                  <span>{name}</span>
                  {r.result === 'sent' ? (
                    <StatusLabel tone="success">
                      Sent:{' '}
                      {formatInt(l ? targetOf({ ...l, mode: 'auto', manual: null }, available) : 0)}
                    </StatusLabel>
                  ) : r.result === 'held' ? (
                    <StatusLabel tone="warning" icon={Clock}>
                      Held by eBay revision limit, sends later
                    </StatusLabel>
                  ) : (
                    <StatusLabel tone="danger">Failed, retrying</StatusLabel>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <SimpleTable
        label="Stock by channel"
        head={
          mode === 'manual'
            ? [
                { label: 'Channel account' },
                { label: 'Listing' },
                { label: 'Allocation', align: 'right' },
                { label: 'Sold since set', align: 'right' },
                { label: 'Live target', align: 'right' },
                { label: 'Note' },
              ]
            : [
                { label: 'Channel account' },
                { label: 'Listing' },
                { label: 'Buffer', align: 'right' },
                { label: 'On channel', align: 'right' },
                { label: 'Last push' },
              ]
        }
      >
        {d.listings.map((l) =>
          mode === 'manual' ? (
            <ManualRow
              key={l.id}
              l={live(l)}
              available={available}
              value={qty[l.id] ?? ''}
              invalid={l.fulfilment === 'MFN' && numberOf(l.id) === null}
              onChange={(v) => {
                setQty({ ...qty, [l.id]: v });
              }}
            />
          ) : (
            <ListingRow
              key={l.id}
              l={{
                ...l,
                // After "back to Auto" every listing follows stock; before, a mixed SKU keeps each
                // listing's own mode.
                channelQty:
                  l.fulfilment === 'FBA'
                    ? l.channelQty
                    : targetOf(results ? { ...l, mode: 'auto', manual: null } : l, available),
                lastPush: pushedNow(results, l),
              }}
            />
          ),
        )}
      </SimpleTable>

      {mode === 'manual' && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-divider px-5 py-3">
          <span className="num text-13 font-medium">
            Allocated {formatInt(allocated)} · Available {formatInt(available)}
          </span>
          {allocated > available && (
            <span className="flex items-center gap-1.5 text-13 text-warning">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              <span className="text-ink">
                More allocated than you have. Listings will be capped by stock.
              </span>
            </span>
          )}
          <Button
            variant="primary"
            className="ml-auto"
            disabled={invalid}
            onClick={() => {
              setConfirm('save');
            }}
          >
            Save allocation
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'save'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Save the manual allocation?"
        description={`Each listing then shows its live target. The new numbers go to the audit log and the stock change log. Allocated ${formatInt(allocated)}, available ${formatInt(available)}.`}
        confirmLabel="Save allocation"
        onConfirm={() => {
          toast({
            title: 'Allocation saved',
            description: 'Only listings whose target changed are updated.',
            tone: 'success',
          });
        }}
      />
      <ConfirmDialog
        open={confirm === 'auto'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Switch back to Auto?"
        description="The manual numbers are cleared and every listing is pushed available − buffer straight away."
        confirmLabel="Switch to Auto"
        onConfirm={() => {
          setMode('auto');
          setResults(autoPushResults(mfn));
        }}
      />
    </Card>
  );
}

/** The push just made by "back to Auto", if there was one for this listing. */
function pushedNow(results: PushResult[] | null, l: Listing): Listing['lastPush'] {
  const r = results?.find((x) => x.listingId === l.id);
  return r ? { at: new Date().toISOString(), result: r.result } : l.lastPush;
}

function accountName(l: Listing): string {
  return { amazon: 'Amazon', ebay: 'eBay', website: 'Website' }[l.channel] + ' · ' + l.externalId;
}

function ManualRow({
  l,
  available,
  value,
  invalid,
  onChange,
}: {
  l: Listing;
  available: number;
  value: string;
  invalid: boolean;
  onChange: (v: string) => void;
}) {
  const { session, company } = useAppState();
  const account = session?.channelAccounts.find((a) => a.id === l.channelAccountId);
  const c = company(l.companyId);
  const fba = l.fulfilment === 'FBA';
  const target = targetOf(l, available);
  const left = l.manual ? l.manual.qty - l.manual.sold : 0;
  const capped = !fba && l.manual !== null && left > Math.max(0, available - l.buffer);
  const usedUp = !fba && l.manual !== null && left <= 0 && l.manual.qty > 0;
  return (
    <Tr>
      <Td>
        <span className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          <ChannelMark channel={l.channel} />
          {c && (
            <>
              <span aria-hidden className="grid place-items-center">
                <CompanySwatch company={c} />
              </span>
              <span className="truncate text-xs text-ink-muted">{account?.name}</span>
            </>
          )}
        </span>
      </Td>
      <Td>
        <Stack
          value={<span className="ref">{l.externalId}</span>}
          sub={fba ? 'Fulfilled by Amazon' : `Buffer ${String(l.buffer)}`}
        />
      </Td>
      <Td align="right">
        {fba ? (
          <span className="text-ink-muted">Fulfilled by Amazon</span>
        ) : (
          <input
            aria-label={`Allocation for ${account?.name ?? l.externalId}`}
            aria-invalid={invalid || undefined}
            inputMode="numeric"
            value={value}
            onChange={(e) => {
              onChange(e.target.value.trim());
            }}
            className={cn(
              'num h-8 w-20 rounded-ctl border bg-card px-2 text-right text-13 shadow-card outline-none focus:border-brand-600',
              invalid ? 'border-danger' : 'border-border',
            )}
          />
        )}
      </Td>
      <Td align="right">{fba ? '-' : formatInt(l.manual?.sold ?? 0)}</Td>
      <Td align="right">
        <span className="font-semibold">
          {fba ? formatInt(l.channelQty ?? 0) : formatInt(target)}
        </span>
      </Td>
      <Td>
        {invalid ? (
          <span className="text-xs font-medium text-danger">Whole number, 0 or more</span>
        ) : usedUp ? (
          <StatusLabel tone="neutral" icon={CircleSlash}>
            Allocation used up
          </StatusLabel>
        ) : capped ? (
          <StatusLabel tone="warning" icon={TriangleAlert}>
            Capped by stock
          </StatusLabel>
        ) : fba ? (
          <span className="text-xs text-ink-muted">Amazon manages it</span>
        ) : (
          <StatusLabel tone="info">Manual</StatusLabel>
        )}
      </Td>
    </Tr>
  );
}
