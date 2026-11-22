/**
 * Stock by channel with manual allocation (C7, INV-10, T-0317). The view shows each listing's
 * target, buffer, channel quantity and last push. Manual opens one form for the SKU's
 * merchant-fulfilled listings (and, if chosen, its bundles' listings); it is saved once with the
 * SKU's version, and a stale save asks the user to review again (C7.2).
 */
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { CircleSlash, Pencil, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import {
  stockApi,
  type AllocationPush,
  type ApiProblem,
  type StockDetail,
  type StockListing,
  type StockMode,
} from '../../auth/api.ts';
import { Card, SimpleTable, Stack, Td, Tr } from '../../components/Card.tsx';
import { StatusLabel } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog } from '../../kit/Dialog.tsx';
import { EmptyState } from '../../kit/states.tsx';
import { cn } from '../../lib/cn.ts';
import { formatInt } from '../../lib/format.ts';
import { AccountCell, InlineError } from '../catalogue/parts.tsx';
import { refusalText } from '../catalogue/rules.ts';
import { ListingBufferDialog } from './dialogs.tsx';
import { LastPush } from './parts.tsx';
import {
  OVER_ALLOCATED,
  VERSION_CONFLICT,
  allocatedOf,
  allocationBody,
  formRows,
  previewTarget,
  pushText,
  syncLabel,
  wholeUnits,
  type AllocRow,
} from './rules.ts';

type Results = { title: string; pushes: AllocationPush[] };

export function StockByChannel({ d }: { d: StockDetail }) {
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const key = ['stock-detail', d.sku_id, persona];
  const [rows, setRows] = useState<AllocRow[] | null>(null);
  const [withBundles, setWithBundles] = useState(false);
  const [confirm, setConfirm] = useState<'save' | 'auto' | { listing: StockListing } | null>(null);
  const [autoBundles, setAutoBundles] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [buffer, setBuffer] = useState<StockListing | null>(null);
  const editing = rows !== null;
  const mfn = d.listings.filter((l) => l.fulfilment !== 'fba');

  // C7.3: the product switch may cover the bundle listings too; their rows come from each
  // bundle's own stock page.
  const bundleDetails = useQueries({
    queries: d.bundles.map((b) => ({
      queryKey: ['stock-detail', b.id, persona],
      queryFn: () => stockApi.get(b.id),
      enabled: !!session && editing && withBundles,
    })),
  });
  const bundleListings = bundleDetails.flatMap((q, i) => {
    const b = d.bundles[i];
    return q.data && b ? [{ sku: b.sku, pack: b.pack_size, listings: q.data.listings }] : [];
  });

  // A fresh read (after a conflict, or a push settling) keeps what the user typed, but takes the
  // new sold counts and buffers for the preview.
  useEffect(() => {
    if (!rows) return;
    const fresh = new Map(
      [...d.listings, ...bundleListings.flatMap((b) => b.listings)].map((l) => [l.id, l]),
    );
    setRows(
      (prev) => prev?.map((r) => ({ ...r, listing: fresh.get(r.listing.id) ?? r.listing })) ?? null,
    );
  }, [d, bundleDetails.map((q) => q.dataUpdatedAt).join()]);

  useEffect(() => {
    if (!rows) return;
    if (!withBundles) {
      setRows((prev) => prev?.filter((r) => r.bundleSku === null) ?? null);
      return;
    }
    const have = new Set(rows.map((r) => r.listing.id));
    const extra = formRows([], bundleListings, true).filter((r) => !have.has(r.listing.id));
    if (extra.length > 0) setRows((prev) => [...(prev ?? []), ...extra]);
  }, [withBundles, bundleListings.length]);

  const startEditing = (allManual: boolean) => {
    setResults(null);
    setProblem(null);
    setWithBundles(false);
    setRows(formRows(d.listings, [], allManual));
  };
  const stopEditing = () => {
    setRows(null);
    setProblem(null);
  };
  const setRow = (id: string, patch: Partial<AllocRow>) => {
    setRows((prev) => prev?.map((r) => (r.listing.id === id ? { ...r, ...patch } : r)) ?? null);
  };

  const done = (r: { stock: StockDetail; pushes: AllocationPush[] }, title: string) => {
    qc.setQueryData(key, r.stock);
    void qc.invalidateQueries({ queryKey: ['stock'] });
    void qc.invalidateQueries({ queryKey: ['movements'] });
    for (const b of d.bundles) void qc.invalidateQueries({ queryKey: ['stock-detail', b.id] });
    setResults({ title, pushes: r.pushes });
  };

  const save = async () => {
    if (!rows) return;
    const body = allocationBody(d.version, rows);
    if (!body) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await stockApi.saveAllocation(d.sku_id, body);
      if (r.ok) {
        setRows(null);
        done(r.body as { stock: StockDetail; pushes: AllocationPush[] }, 'Allocation saved');
      } else if (
        r.status === 409 &&
        (r.body as ApiProblem | undefined)?.code === 'version_conflict'
      ) {
        // C7.2: something moved while the user typed. Reload, keep their numbers, ask again.
        setProblem(VERSION_CONFLICT);
        void qc.invalidateQueries({ queryKey: key });
        for (const b of d.bundles) void qc.invalidateQueries({ queryKey: ['stock-detail', b.id] });
      } else {
        setProblem(refusalText(r, 'The allocation could not be saved. Try again.'));
      }
    } catch {
      setProblem('The server did not answer. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const toAuto = async (listingIds?: string[]) => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await stockApi.backToAuto(d.sku_id, {
        ...(listingIds ? { listing_ids: listingIds } : {}),
        ...(!listingIds && autoBundles ? { include_bundles: true } : {}),
      });
      if (r.ok) {
        setRows(null);
        done(
          r.body as { stock: StockDetail; pushes: AllocationPush[] },
          listingIds ? 'Listing back on Auto' : 'Back on Auto: every listing was pushed',
        );
      } else setProblem(refusalText(r, 'Back to Auto did not go through. Try again.'));
    } catch {
      setProblem('The server did not answer. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const accountName = (l: Pick<StockListing, 'channel_account_id' | 'provider'>) =>
    session?.channelAccounts.find((a) => a.id === l.channel_account_id)?.name ?? l.provider;
  const allListings = [...d.listings, ...bundleListings.flatMap((b) => b.listings)];

  if (d.listings.length === 0)
    return (
      <Card title="Stock by channel">
        <EmptyState
          title="No listings on your channels"
          body="Map a listing to this SKU in Listings so its stock syncs."
        />
      </Card>
    );

  const allocated = rows ? allocatedOf(rows) : d.allocation.allocated;
  const over =
    allocated > d.available &&
    (rows ? rows.some((r) => r.mode === 'manual') : d.sync_mode !== 'auto');
  const invalid = rows?.some((r) => r.mode === 'manual' && wholeUnits(r.qty) === null) ?? false;
  // The bundle rows must be in the form before a save can name them.
  const loadingBundles = withBundles && bundleDetails.some((q) => q.isPending);

  return (
    <Card
      title="Stock by channel"
      aside={
        mfn.length === 0 ? (
          <span className="text-xs text-ink-muted">Amazon manages FBA stock</span>
        ) : (
          <div className="flex items-center gap-2">
            <span id="sync-label" className="text-xs text-ink-muted">
              Stock sync
            </span>
            <span
              role="radiogroup"
              aria-labelledby="sync-label"
              className="flex rounded-full border border-border p-0.5"
            >
              {(['auto', 'manual'] as const).map((m) => {
                const on = editing ? m === 'manual' : d.sync_mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={busy}
                    onClick={() => {
                      if (m === 'manual' && !editing) startEditing(true);
                      if (m === 'auto') {
                        if (editing) stopEditing();
                        if (d.sync_mode !== 'auto') {
                          setAutoBundles(false);
                          setConfirm('auto');
                        }
                      }
                    }}
                    className={cn(
                      'h-7 rounded-full px-3 text-13 font-medium',
                      on ? 'bg-side text-white' : 'text-ink-muted hover:text-ink',
                    )}
                  >
                    {m === 'auto' ? 'Auto' : 'Manual'}
                  </button>
                );
              })}
            </span>
            {!editing && d.sync_mode === 'mixed' && (
              <span className="text-13 font-medium">{syncLabel('mixed')}</span>
            )}
          </div>
        )
      }
    >
      <p className="border-b border-divider px-5 py-3 text-13 text-ink-muted">
        {editing
          ? 'Type how many each listing shows, or leave it on Auto. A listing never shows more than you have: it gets the lower of (allocation − sold since set) and (available − buffer). 0 stops selling there.'
          : d.sync_mode === 'manual'
            ? 'Manual: each merchant-fulfilled listing shows its own allocation, capped by stock.'
            : d.sync_mode === 'mixed'
              ? 'Mixed: some listings use a manual allocation, the rest follow available stock.'
              : 'Every listing shows available − buffer, never below 0.'}
      </p>

      {results && !editing && (
        <div role="status" className="border-b border-divider px-5 py-3">
          <p className="text-13 font-medium">{results.title}</p>
          <ul aria-label="Push results" className="mt-2 flex flex-col gap-1.5">
            {results.pushes.map((p) => {
              const l = allListings.find((x) => x.id === p.listing_id);
              return (
                <li
                  key={p.listing_id}
                  className="flex flex-wrap items-center justify-between gap-x-3 text-13"
                >
                  <span>
                    {l ? accountName(l) : 'Listing'}{' '}
                    {l && <span className="ref text-ink-muted">{l.external_sku}</span>}
                  </span>
                  <StatusLabel
                    tone={
                      p.result === 'held' ? 'warning' : p.result === 'queued' ? 'info' : 'neutral'
                    }
                  >
                    {pushText(p.result)}
                  </StatusLabel>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-ink-muted">
            The final result (sent, held or failed) shows under Last push below.
          </p>
        </div>
      )}

      {rows ? (
        <EditTable rows={rows} available={d.available} accountName={accountName} onRow={setRow} />
      ) : (
        <ViewTable
          d={d}
          busy={busy}
          onBuffer={setBuffer}
          onAuto={(l) => {
            setConfirm({ listing: l });
          }}
          onEdit={() => {
            startEditing(false);
          }}
        />
      )}

      {(editing || d.sync_mode !== 'auto') && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-divider px-5 py-3">
          <span className="num text-13 font-medium">
            Allocated {formatInt(allocated)} · Available {formatInt(d.available)}
          </span>
          {over && (
            <span className="flex items-center gap-1.5 text-13">
              <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
              {OVER_ALLOCATED}
            </span>
          )}
          {editing && d.bundles.length > 0 && (
            <label className="flex items-center gap-2 text-13">
              <input
                type="checkbox"
                checked={withBundles}
                onChange={(e) => {
                  setWithBundles(e.target.checked);
                }}
                className="size-4 accent-brand-600"
              />
              Include the listings of its{' '}
              {d.bundles.length === 1 ? 'bundle' : `${String(d.bundles.length)} bundles`}
            </label>
          )}
          {editing && (
            <span className="ml-auto flex gap-2">
              <Button onClick={stopEditing}>Cancel</Button>
              <Button
                variant="primary"
                disabled={invalid || busy || loadingBundles}
                onClick={() => {
                  setConfirm('save');
                }}
              >
                Save allocation
              </Button>
            </span>
          )}
        </div>
      )}
      {problem && (
        <div className="border-t border-divider px-5 py-3">
          <InlineError>{problem}</InlineError>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'save'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Save the allocation?"
        description={`Each listing then shows its live target, and only listings whose number changes are updated. Every change goes to the audit log and the change log. Allocated ${formatInt(allocated)}, available ${formatInt(d.available)}.`}
        confirmLabel="Save allocation"
        onConfirm={() => {
          setConfirm(null);
          void save();
        }}
      />
      <ConfirmDialog
        open={confirm === 'auto'}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Switch back to Auto?"
        description={
          <span className="flex flex-col gap-3">
            <span>
              The manual numbers are cleared and every listing is sent available − buffer straight
              away.
            </span>
            {d.bundles.length > 0 && (
              <label className="flex items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  checked={autoBundles}
                  onChange={(e) => {
                    setAutoBundles(e.target.checked);
                  }}
                  className="size-4 accent-brand-600"
                />
                Its bundles&rsquo; listings too
              </label>
            )}
          </span>
        }
        confirmLabel="Switch to Auto"
        onConfirm={() => {
          setConfirm(null);
          void toAuto();
        }}
      />
      <ConfirmDialog
        open={typeof confirm === 'object' && confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Put this listing back on Auto?"
        description="Its manual number is cleared and it is sent available − buffer straight away."
        confirmLabel="Back to Auto"
        onConfirm={() => {
          const l = typeof confirm === 'object' && confirm !== null ? confirm.listing : null;
          setConfirm(null);
          if (l) void toAuto([l.id]);
        }}
      />
      {buffer && (
        <ListingBufferDialog
          listing={buffer}
          name={accountName(buffer)}
          onClose={() => {
            setBuffer(null);
          }}
          onDone={() => {
            setBuffer(null);
            void qc.invalidateQueries({ queryKey: key });
          }}
        />
      )}
    </Card>
  );
}

function ViewTable({
  d,
  busy,
  onBuffer,
  onAuto,
  onEdit,
}: {
  d: StockDetail;
  busy: boolean;
  onBuffer: (l: StockListing) => void;
  onAuto: (l: StockListing) => void;
  onEdit: () => void;
}) {
  return (
    <>
      <SimpleTable
        label="Stock by channel"
        head={[
          { label: 'Channel account' },
          { label: 'Listing' },
          { label: 'Buffer', align: 'right' },
          { label: 'Shows', align: 'right' },
          { label: 'Sync' },
          { label: 'Last push' },
        ]}
      >
        {d.listings.map((l) => {
          const fba = l.fulfilment === 'fba';
          const left = l.manual ? l.manual.qty - l.manual.sold : 0;
          return (
            <Tr key={l.id}>
              <Td>
                <AccountCell listing={l} />
              </Td>
              <Td>
                <Stack
                  value={<span className="ref">{l.external_sku}</span>}
                  sub={<span className="ref">{l.external_id}</span>}
                />
              </Td>
              <Td align="right">
                {fba ? (
                  <span className="text-ink-faint" aria-label="No buffer for FBA">
                    -
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onBuffer(l);
                    }}
                    aria-label={`Change the buffer of ${l.external_sku}`}
                    className="rounded-ctl px-1 text-right hover:bg-hover"
                  >
                    <Stack
                      value={<span className="num">{formatInt(l.buffer)}</span>}
                      sub={l.buffer_override ? 'This listing' : 'Account'}
                    />
                  </button>
                )}
              </Td>
              <Td align="right">
                {fba ? (
                  <Stack
                    value={<span className="num">{formatInt(l.channel_qty ?? 0)}</span>}
                    sub="At Amazon"
                  />
                ) : (
                  <Stack
                    value={<span className="num font-semibold">{formatInt(l.target ?? 0)}</span>}
                    sub={
                      l.channel_qty !== null && l.channel_qty !== l.target
                        ? `Channel shows ${formatInt(l.channel_qty)}`
                        : undefined
                    }
                  />
                )}
              </Td>
              <Td>
                {fba ? (
                  <span className="text-ink-muted">Fulfilled by Amazon</span>
                ) : l.mode === 'manual' && l.manual ? (
                  <span className="flex items-center gap-2">
                    <Stack
                      value={
                        l.capped_by_stock ? (
                          <StatusLabel tone="warning" icon={TriangleAlert}>
                            Capped by stock
                          </StatusLabel>
                        ) : l.manual.qty === 0 ? (
                          <StatusLabel tone="neutral" icon={CircleSlash}>
                            Stops selling here
                          </StatusLabel>
                        ) : left <= 0 ? (
                          <StatusLabel tone="neutral" icon={CircleSlash}>
                            Allocation used up
                          </StatusLabel>
                        ) : (
                          <StatusLabel tone="info">Manual</StatusLabel>
                        )
                      }
                      sub={
                        <span className="num">{`${formatInt(l.manual.qty)} set, ${formatInt(l.manual.sold)} sold`}</span>
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Undo2 />}
                      disabled={busy}
                      aria-label={`Put ${l.external_sku} back on Auto`}
                      onClick={() => {
                        onAuto(l);
                      }}
                    >
                      Auto
                    </Button>
                  </span>
                ) : (
                  <span className="text-ink-muted">Auto</span>
                )}
              </Td>
              <Td>
                <LastPush l={l} />
              </Td>
            </Tr>
          );
        })}
      </SimpleTable>
      {d.sync_mode !== 'auto' && (
        <div className="flex justify-end border-t border-divider px-5 py-2">
          <Button size="sm" variant="ghost" icon={<Pencil />} onClick={onEdit} disabled={busy}>
            Edit allocation
          </Button>
        </div>
      )}
    </>
  );
}

function EditTable({
  rows,
  available,
  accountName,
  onRow,
}: {
  rows: AllocRow[];
  available: number;
  accountName: (l: StockListing) => string;
  onRow: (id: string, patch: Partial<AllocRow>) => void;
}) {
  return (
    <SimpleTable
      label="Allocation per listing"
      head={[
        { label: 'Channel account' },
        { label: 'Listing' },
        { label: 'Sync' },
        { label: 'Allocation', align: 'right' },
        { label: 'Sold since set', align: 'right' },
        { label: 'Will show', align: 'right' },
        { label: 'Note' },
      ]}
    >
      {rows.map((r) => {
        const l = r.listing;
        const n = wholeUnits(r.qty);
        const bad = r.mode === 'manual' && n === null;
        // A number unchanged keeps its sold count; a new number starts counting again.
        const sold = l.mode === 'manual' && l.manual && n === l.manual.qty ? l.manual.sold : 0;
        const p = previewTarget({
          available,
          buffer: l.buffer,
          pack: r.pack,
          mode: r.mode,
          qty: n ?? 0,
          sold,
        });
        const name = accountName(l);
        return (
          <Tr key={l.id}>
            <Td>
              <AccountCell listing={l} />
            </Td>
            <Td>
              <Stack
                value={<span className="ref">{l.external_sku}</span>}
                sub={
                  r.bundleSku
                    ? `Bundle ${r.bundleSku} (${String(r.pack)}-pack)`
                    : `Buffer ${String(l.buffer)}`
                }
              />
            </Td>
            <Td>
              <select
                aria-label={`Sync for ${name} ${l.external_sku}`}
                value={r.mode}
                onChange={(e) => {
                  const mode = e.target.value as StockMode;
                  onRow(l.id, { mode });
                }}
                className="h-8 rounded-ctl border border-border bg-card px-2 text-13 shadow-card outline-none focus:border-brand-600"
              >
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
            </Td>
            <Td align="right">
              {r.mode === 'manual' ? (
                <input
                  aria-label={`Allocation for ${name} ${l.external_sku}`}
                  aria-invalid={bad || undefined}
                  inputMode="numeric"
                  value={r.qty}
                  onChange={(e) => {
                    onRow(l.id, { qty: e.target.value.trim() });
                  }}
                  className={cn(
                    'num h-8 w-20 rounded-ctl border bg-card px-2 text-right text-13 shadow-card outline-none focus:border-brand-600',
                    bad ? 'border-danger' : 'border-border',
                  )}
                />
              ) : (
                <span className="text-ink-muted">Follows stock</span>
              )}
            </Td>
            <Td align="right">
              <span className="num">{r.mode === 'manual' ? formatInt(sold) : '-'}</span>
            </Td>
            <Td align="right">
              <span className="num font-semibold">{bad ? '-' : formatInt(p.target)}</span>
            </Td>
            <Td>
              {bad ? (
                <span className="text-xs font-medium text-danger">Whole number, 0 or more</span>
              ) : p.capped ? (
                <StatusLabel tone="warning" icon={TriangleAlert}>
                  Capped by stock
                </StatusLabel>
              ) : r.mode === 'manual' && n === 0 ? (
                <StatusLabel tone="neutral" icon={CircleSlash}>
                  Stops selling here
                </StatusLabel>
              ) : null}
            </Td>
          </Tr>
        );
      })}
    </SimpleTable>
  );
}
