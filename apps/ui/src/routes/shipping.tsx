import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import {
  CircleCheck,
  Eye,
  OctagonAlert,
  Printer,
  Tag,
  Truck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAppState } from '../app/session.tsx';
import { NumberField, parseKg, parseParcels } from '../components/NumberField.tsx';
import { ChannelMark, FLAG } from '../components/badges.tsx';
import { cn } from '../lib/cn.ts';
import {
  daysFromToday,
  formatDate,
  formatInt,
  formatPence,
  formatTime,
  overdueText,
} from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import {
  LABEL_FORMAT,
  PACKAGING_GRAMS,
  SERVICES,
  createLabels,
  defaultWeightGrams,
  ruleFor,
  type LabelResult,
} from '../mocks/shipping.ts';
import type { Channel, OrderRow } from '../mocks/types.ts';

export interface ShippingSearch {
  due?: Due | undefined;
  channel?: Channel | undefined;
}
type Due = 'late' | 'today' | 'tomorrow' | 'later';

const route = getRouteApi('/shipping');
const MAX_BATCH = 200; // SHP-2

const isLate = (o: OrderRow) => Date.parse(o.shipBy) < Date.now();
function dueOf(o: OrderRow): Due {
  if (isLate(o)) return 'late';
  const d = daysFromToday(o.shipBy);
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : 'later';
}

/** Shipping desk (SHP-1 queue, SHP-2 labels). Works on desktop and tablet (NFR-8). */
export function ShippingPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/shipping' });
  const { session, persona, companyId } = useAppState();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shipped, setShipped] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['shipping-queue', persona, companyId],
    queryFn: () => mockApi.orders({ company: companyId, view: 'awaiting', limit: 100, cursor: 0 }),
    enabled: !!session,
  });

  const queue = useMemo(
    () => (query.data?.items ?? []).filter((o) => !shipped.has(o.id)),
    [query.data, shipped],
  );
  const counts = useMemo(() => {
    const c = { all: 0, late: 0, today: 0, tomorrow: 0, later: 0 };
    for (const o of queue) {
      if (search.channel && o.channel !== search.channel) continue;
      c.all++;
      c[dueOf(o)]++;
    }
    return c;
  }, [queue, search.channel]);
  const shown = queue.filter(
    (o) =>
      (!search.due || dueOf(o) === search.due) && (!search.channel || o.channel === search.channel),
  );

  useEffect(() => {
    setSelected(new Set());
  }, [persona, companyId]);

  const setSearch = (patch: Partial<ShippingSearch>) =>
    void navigate({ search: (prev: ShippingSearch) => ({ ...prev, ...patch }), replace: true });

  const selectedRows = queue.filter((o) => selected.has(o.id));
  const toPanel = () => {
    if (window.innerWidth < 1024)
      requestAnimationFrame(() => document.getElementById('label-panel')?.scrollIntoView());
  };
  const allShownSelected = shown.length > 0 && shown.every((o) => selected.has(o.id));

  return (
    <div className="h-full overflow-y-auto lg:overflow-hidden">
      <div className="flex flex-col px-4 pt-3 pb-4 lg:h-full lg:px-6">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
          <div>
            <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
              Shipping desk
            </h1>
            <p className="num mt-0.5 text-13 text-ink-muted">
              {formatInt(counts.all)} to dispatch
              {counts.late > 0 && (
                <span className="font-medium text-danger">
                  , {formatInt(counts.late)} past ship-by
                </span>
              )}
            </p>
          </div>
          <p className="ml-auto text-xs text-ink-muted">Label format: {LABEL_FORMAT}</p>
        </div>

        <div className="mt-4 grid gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_448px]">
          {/* Queue */}
          <section
            aria-label="Dispatch queue"
            className="flex min-h-0 flex-col rounded-card border border-border bg-card shadow-card"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-3">
              <Pill
                active={!search.due}
                onClick={() => {
                  setSearch({ due: undefined });
                }}
                count={counts.all}
              >
                All
              </Pill>
              <Pill
                active={search.due === 'late'}
                onClick={() => {
                  setSearch({ due: 'late' });
                }}
                count={counts.late}
                alarm
              >
                Past ship-by
              </Pill>
              <Pill
                active={search.due === 'today'}
                onClick={() => {
                  setSearch({ due: 'today' });
                }}
                count={counts.today}
              >
                Today
              </Pill>
              <Pill
                active={search.due === 'tomorrow'}
                onClick={() => {
                  setSearch({ due: 'tomorrow' });
                }}
                count={counts.tomorrow}
              >
                Tomorrow
              </Pill>
              <Pill
                active={search.due === 'later'}
                onClick={() => {
                  setSearch({ due: 'later' });
                }}
                count={counts.later}
              >
                Later
              </Pill>
              <label className="ml-auto flex items-center gap-2 text-13 text-ink-muted">
                <span className="sr-only sm:not-sr-only">Channel</span>
                <select
                  value={search.channel ?? ''}
                  onChange={(e) => {
                    setSearch({ channel: (e.target.value || undefined) as Channel | undefined });
                  }}
                  className="h-8 rounded-ctl border border-border bg-card pr-7 pl-2.5 text-13 text-ink"
                >
                  <option value="">All channels</option>
                  <option value="amazon">Amazon</option>
                  <option value="ebay">eBay</option>
                  <option value="website">Website</option>
                </select>
              </label>
            </div>

            <div className="flex h-10 shrink-0 items-center gap-3 border-b border-divider bg-rail px-4 text-xs font-medium text-ink-muted">
              <input
                type="checkbox"
                className="size-4"
                aria-label="Select all orders shown"
                checked={allShownSelected}
                onChange={() => {
                  setSelected(
                    allShownSelected
                      ? new Set()
                      : new Set(shown.slice(0, MAX_BATCH).map((o) => o.id)),
                  );
                }}
              />
              <span>Order</span>
              <span className="ml-auto">Ship by</span>
            </div>

            <ul className="min-h-0 flex-1 overflow-y-auto max-lg:max-h-[520px]">
              {shown.map((o) => (
                <QueueRow
                  key={o.id}
                  o={o}
                  checked={selected.has(o.id)}
                  only={selected.size === 1 && selected.has(o.id)}
                  onCheck={() => {
                    setSelected((s) => {
                      const n = new Set(s);
                      if (n.has(o.id)) n.delete(o.id);
                      else n.add(o.id);
                      return n;
                    });
                  }}
                  onOpen={() => {
                    setSelected(new Set([o.id]));
                    toPanel();
                  }}
                />
              ))}
              {query.isSuccess && shown.length === 0 && (
                <li className="px-6 py-14 text-center">
                  <p className="text-sm font-medium">Nothing to dispatch here</p>
                  <p className="mt-1 text-13 text-ink-muted">
                    {counts.all > 0
                      ? 'Choose another ship-by filter to see the rest of the queue.'
                      : 'Every order is labelled. New orders appear here as they arrive.'}
                  </p>
                </li>
              )}
            </ul>
          </section>

          {/* Label panel */}
          <aside
            id="label-panel"
            aria-label="Labels"
            className="min-h-0 scroll-mt-4 lg:overflow-y-auto"
          >
            <LabelPanel
              key={[...selected].sort().join(',')}
              rows={selectedRows}
              lateCount={counts.late}
              todayCount={counts.today}
              onSelectDue={(d) => {
                setSelected(
                  new Set(
                    shown
                      .filter((o) => dueOf(o) === d)
                      .slice(0, MAX_BATCH)
                      .map((o) => o.id),
                  ),
                );
              }}
              onClear={() => {
                setSelected(new Set());
              }}
              onShipped={(ids) => {
                setShipped((s) => new Set([...s, ...ids]));
              }}
            />
          </aside>
        </div>
      </div>

      {/* Tablet: the panel sits below the queue, so keep a way to reach it. */}
      {selected.size > 0 && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-card px-4 py-3 shadow-pop lg:hidden">
          <span className="num text-sm font-medium">{formatInt(selected.size)} selected</span>
          <button
            onClick={toPanel}
            className="ml-auto h-10 rounded-ctl bg-brand-700 px-4 text-13 font-medium text-white hover:bg-brand-800"
          >
            Go to labels
          </button>
        </div>
      )}
    </div>
  );
}

function Pill({
  active,
  count,
  alarm,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  alarm?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex h-8 items-center gap-2 rounded-full px-3 text-13 whitespace-nowrap',
        active ? 'bg-side font-medium text-white' : 'text-ink-muted hover:bg-hover hover:text-ink',
      )}
    >
      {alarm && count > 0 && (
        <OctagonAlert
          className={cn('size-3.5', active ? 'text-white' : 'text-danger')}
          aria-hidden
        />
      )}
      {children}
      <span
        className={cn(
          'num rounded-full px-2 text-xs leading-[18px] font-medium',
          active
            ? 'bg-white/15 text-white'
            : alarm && count > 0
              ? 'bg-danger-bg text-danger'
              : 'bg-[#e2e5ea] text-ink-muted',
        )}
      >
        {formatInt(count)}
      </span>
    </button>
  );
}

function ShipByText({ o }: { o: OrderRow }) {
  const d = daysFromToday(o.shipBy);
  if (isLate(o)) {
    return (
      <span className="flex items-center justify-end gap-1 font-medium text-danger">
        <OctagonAlert className="size-3.5" aria-hidden />
        {overdueText(o.shipBy)}
      </span>
    );
  }
  if (d === 0) return <span className="font-medium">Today, {formatTime(o.shipBy)}</span>;
  if (d === 1) return <span>Tomorrow, {formatTime(o.shipBy)}</span>;
  return <span>In {d} days</span>;
}

function QueueRow({
  o,
  checked,
  only,
  onCheck,
  onOpen,
}: {
  o: OrderRow;
  checked: boolean;
  only: boolean;
  onCheck: () => void;
  onOpen: () => void;
}) {
  const warn = o.flags.filter((f) => f !== 'fba');
  return (
    <li
      className={cn(
        'flex min-h-16 items-center gap-3 border-b border-divider pr-4 pl-4 last:border-0',
        checked ? 'bg-selected' : 'hover:bg-hover',
        only && 'shadow-[inset_3px_0_0_var(--color-side)]',
      )}
    >
      <label className="-my-2 -ml-2 grid size-10 shrink-0 cursor-pointer place-items-center">
        <input
          type="checkbox"
          className="size-4"
          checked={checked}
          onChange={onCheck}
          aria-label={`Select order ${o.ref}`}
        />
      </label>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="ref truncate text-13 font-medium text-ink">{o.ref}</span>
            <span className="inline-grid grid-cols-[18px_auto] items-center gap-x-1.5 text-xs">
              <ChannelMark channel={o.channel} />
            </span>
          </span>
          <span className="num mt-0.5 block truncate text-xs text-ink-muted">
            {o.itemCount} item{o.itemCount === 1 ? '' : 's'}, {formatPence(o.totalPence)},{' '}
            {o.shipToMasked}
          </span>
          {warn.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-x-3">
              {warn.map((f) => {
                const F = FLAG[f];
                const Icon = F.icon;
                return (
                  <span
                    key={f}
                    className={cn(
                      'inline-flex items-center gap-1 text-xs font-medium',
                      F.className,
                    )}
                  >
                    <Icon className="size-3.5" aria-hidden /> {F.label}
                  </span>
                );
              })}
            </span>
          )}
        </span>
        <span className="num shrink-0 text-right text-13">
          <ShipByText o={o} />
          <span className="block text-xs text-ink-muted">{formatDate(o.shipBy)}</span>
        </span>
      </button>
    </li>
  );
}

/* ---------- label panel ---------- */

function Panel({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-border bg-card shadow-card">
      <header className="flex items-center gap-3 border-b border-divider px-5 py-3.5">
        <h2 className="min-w-0 text-sm font-semibold">{title}</h2>
        {aside && <div className="ml-auto shrink-0">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

const kg = (g: number) => (g / 1000).toFixed(2);

function LabelPanel(props: {
  rows: OrderRow[];
  lateCount: number;
  todayCount: number;
  onSelectDue: (d: Due) => void;
  onClear: () => void;
  onShipped: (ids: string[]) => void;
}) {
  const { rows } = props;
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(rows.map((o) => [o.id, defaultWeightGrams(o)])),
  );
  const [parcels, setParcels] = useState<Record<string, number>>(() =>
    Object.fromEntries(rows.map((o) => [o.id, 1])),
  );
  const [services, setServices] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((o) => [o.id, ruleFor(o, defaultWeightGrams(o)).serviceId])),
  );
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<LabelResult[] | null>(null);

  if (results) return <Results results={results} onDone={props.onClear} />;

  if (rows.length === 0) {
    return (
      <Panel title="Create labels">
        <div className="px-5 py-8 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-full bg-surface">
            <Truck className="size-5 text-ink-muted" aria-hidden />
          </span>
          <p className="mt-3 text-sm font-medium">Pick orders to ship</p>
          <p className="mt-1 text-13 text-ink-muted">
            Tick orders in the queue, or start with the ones that are due first.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            {props.lateCount > 0 && (
              <button
                onClick={() => {
                  props.onSelectDue('late');
                }}
                className="h-10 rounded-ctl bg-side text-13 font-medium text-white hover:bg-side-hover"
              >
                Select past ship-by ({formatInt(props.lateCount)})
              </button>
            )}
            {props.todayCount > 0 && (
              <button
                onClick={() => {
                  props.onSelectDue('today');
                }}
                className="h-10 rounded-ctl border border-border text-13 font-medium hover:bg-hover"
              >
                Select due today ({formatInt(props.todayCount)})
              </button>
            )}
          </div>
        </div>
      </Panel>
    );
  }

  const create = async () => {
    setBusy(true);
    const res = await createLabels(rows, services);
    setBusy(false);
    setResults(res);
    props.onShipped(res.filter((r) => r.ok).map((r) => r.orderId));
  };

  const tooMany = rows.length > MAX_BATCH;
  const action = (
    <div className="border-t border-divider px-5 py-4">
      {tooMany && (
        <p className="mb-2 text-13 text-danger">
          A batch can hold up to {MAX_BATCH} orders. Untick some first.
        </p>
      )}
      <button
        onClick={() => void create()}
        disabled={busy || tooMany}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-ctl bg-brand-700 text-sm font-medium text-white shadow-card hover:bg-brand-800 disabled:opacity-60"
      >
        <Tag className="size-4" aria-hidden />
        {busy
          ? 'Creating labels...'
          : rows.length === 1
            ? 'Create label'
            : `Create ${formatInt(rows.length)} labels`}
      </button>
      <p className="mt-2 text-center text-xs text-ink-muted" aria-live="polite">
        {busy
          ? 'Talking to the carrier. This takes a few seconds.'
          : 'Orders move to Dispatched when their label is created.'}
      </p>
    </div>
  );

  if (rows.length === 1) {
    const o = rows[0] as OrderRow;
    return (
      <Single
        o={o}
        grams={weights[o.id] ?? 0}
        setGrams={(g) => {
          setWeights({ ...weights, [o.id]: g });
        }}
        parcels={parcels[o.id] ?? 1}
        setParcels={(n) => {
          setParcels({ ...parcels, [o.id]: n });
        }}
        serviceId={services[o.id] ?? ''}
        setService={(s) => {
          setServices({ ...services, [o.id]: s });
        }}
        onClear={props.onClear}
        action={action}
      />
    );
  }

  return (
    <Panel
      title={`${formatInt(rows.length)} orders selected`}
      aside={
        <button
          onClick={props.onClear}
          className="flex h-7 items-center gap-1 rounded-ctl px-2 text-13 text-ink-muted hover:bg-hover hover:text-ink"
        >
          <X className="size-4" aria-hidden /> Clear
        </button>
      }
    >
      <p className="px-5 pt-3 text-xs text-ink-muted">
        Service and weight come from your shipping rules. Change any row before creating.
      </p>
      <ul className="mt-2 max-h-[420px] overflow-y-auto px-5">
        {rows.map((o) => (
          <li
            key={o.id}
            className="grid grid-cols-[minmax(0,1fr)_124px_76px] items-center gap-2 border-b border-divider py-2.5 last:border-0"
          >
            <span className="min-w-0">
              <span className="ref block truncate text-13 font-medium">{o.ref}</span>
              <span className="num block truncate text-xs text-ink-muted">
                {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
              </span>
            </span>
            <select
              aria-label={`Service for ${o.ref}`}
              value={services[o.id]}
              onChange={(e) => {
                setServices({ ...services, [o.id]: e.target.value });
              }}
              className="h-8 w-full rounded-ctl border border-border bg-card pl-2 text-xs"
            >
              {SERVICES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.carrier} {s.service}
                </option>
              ))}
            </select>
            <label className="flex h-8 items-center rounded-ctl border border-border pr-2 focus-within:border-brand-600">
              <span className="sr-only">Weight for {o.ref} in kg</span>
              <NumberField
                inputMode="decimal"
                value={weights[o.id] ?? 0}
                format={kg}
                parse={parseKg}
                onCommit={(g) => {
                  setWeights({ ...weights, [o.id]: g });
                }}
                className="num w-full min-w-0 bg-transparent pl-2 text-right text-xs outline-none"
              />
              <span className="pl-1 text-xs text-ink-muted">kg</span>
            </label>
          </li>
        ))}
      </ul>
      {action}
    </Panel>
  );
}

function Single(props: {
  o: OrderRow;
  grams: number;
  setGrams: (g: number) => void;
  parcels: number;
  setParcels: (n: number) => void;
  serviceId: string;
  setService: (s: string) => void;
  onClear: () => void;
  action: ReactNode;
}) {
  const { o } = props;
  const detail = useQuery({
    queryKey: ['order', o.id, 'desk'],
    queryFn: () => mockApi.order(o.id),
    gcTime: 0,
    retry: false,
  });
  const rule = ruleFor(o, props.grams);
  const field =
    'h-10 w-full rounded-ctl border border-border bg-card px-3 text-13 outline-none focus:border-brand-600';
  return (
    <Panel
      title={
        <Link
          to="/orders/$orderId"
          params={{ orderId: o.id }}
          className="ref hover:text-brand-600 hover:underline"
        >
          {o.ref}
        </Link>
      }
      aside={
        <button
          onClick={props.onClear}
          className="flex h-7 items-center gap-1 rounded-ctl px-2 text-13 text-ink-muted hover:bg-hover hover:text-ink"
        >
          <X className="size-4" aria-hidden /> Close
        </button>
      }
    >
      <div className="px-5 pt-4">
        <h3 className="text-xs font-medium text-ink-muted">Pack</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {(detail.data?.lines ?? []).map((l) => (
            <li key={l.sku} className="flex items-center gap-3">
              <span className="num grid h-8 min-w-8 place-items-center rounded-ctl bg-surface px-2 text-sm font-semibold">
                {l.qty}
              </span>
              <span className="min-w-0 text-13">
                <span className="block truncate font-medium">{l.title}</span>
                <span className="block truncate text-xs text-ink-muted">SKU {l.sku}</span>
              </span>
            </li>
          ))}
          {!detail.data && <li className="h-8" aria-busy />}
        </ul>
      </div>

      {detail.data && (
        <div className="mt-4 border-t border-divider px-5 pt-4">
          <h3 className="text-xs font-medium text-ink-muted">Ship to</h3>
          <address className="mt-1.5 text-13 leading-5 not-italic">
            <span className="font-semibold">{detail.data.buyer.name}</span>,{' '}
            {detail.data.buyer.lines.join(', ')}, {detail.data.buyer.town},{' '}
            <span className="font-medium">{detail.data.buyer.postcode}</span>
          </address>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-muted">
            <Eye className="size-3.5" aria-hidden /> Each view of customer details is logged.
          </p>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-divider px-5 pt-4 pb-1">
        <label className="col-span-2 text-xs font-medium text-ink-muted">
          Carrier and service
          <select
            value={props.serviceId}
            onChange={(e) => {
              props.setService(e.target.value);
            }}
            className={cn(field, 'mt-1.5 font-normal text-ink')}
          >
            {SERVICES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.carrier} {s.service} ({s.account})
              </option>
            ))}
          </select>
          <span className="mt-1 block font-normal">
            {props.serviceId === rule.serviceId
              ? `Chosen by ${rule.rule.toLowerCase()}.`
              : 'Changed by you; the rule suggested another service.'}
          </span>
        </label>
        <label className="text-xs font-medium text-ink-muted">
          Parcels
          <NumberField
            inputMode="numeric"
            value={props.parcels}
            format={String}
            parse={parseParcels}
            onCommit={props.setParcels}
            className={cn(field, 'num mt-1.5 font-normal text-ink')}
          />
        </label>
        <label className="text-xs font-medium text-ink-muted">
          Weight (kg)
          <NumberField
            inputMode="decimal"
            value={props.grams}
            format={kg}
            parse={parseKg}
            onCommit={props.setGrams}
            className={cn(field, 'num mt-1.5 font-normal text-ink')}
          />
        </label>
        <p className="col-span-2 text-xs text-ink-muted">
          Items {kg(props.grams - PACKAGING_GRAMS)} kg plus {kg(PACKAGING_GRAMS)} kg packaging.
        </p>
      </div>
      {props.action}
    </Panel>
  );
}

function Results({ results, onDone }: { results: LabelResult[]; onDone: () => void }) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const Line = ({
    icon: Icon,
    tone,
    children,
  }: {
    icon: LucideIcon;
    tone: string;
    children: ReactNode;
  }) => (
    <li className="flex items-start gap-2.5 border-b border-divider py-2.5 text-13 last:border-0">
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone)} aria-hidden />
      <span className="min-w-0">{children}</span>
    </li>
  );
  return (
    <Panel
      title={
        ok.length
          ? `${formatInt(ok.length)} label${ok.length === 1 ? '' : 's'} created`
          : 'No labels created'
      }
    >
      <div role="status" className="px-5 pt-3">
        {bad.length > 0 && (
          <p className="mb-2 rounded-ctl border border-[#f0caca] bg-danger-bg px-3 py-2 text-13">
            <span className="font-semibold text-danger">{formatInt(bad.length)} failed. </span>
            They stay in the queue; fix them and try again.
          </p>
        )}
        <ul className="max-h-[360px] overflow-y-auto">
          {bad.map((r) => (
            <Line key={r.orderId} icon={OctagonAlert} tone="text-danger">
              <Link
                to="/orders/$orderId"
                params={{ orderId: r.orderId }}
                className="ref font-medium hover:underline"
              >
                {r.ref}
              </Link>
              <span className="block text-xs text-ink-muted">{r.error}</span>
            </Line>
          ))}
          {ok.map((r) => (
            <Line key={r.orderId} icon={CircleCheck} tone="text-success">
              <span className="ref font-medium">{r.ref}</span>
              <span className="ref block text-xs text-ink-muted">Tracking {r.trackingNumber}</span>
            </Line>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-2 border-t border-divider px-5 py-4">
        {ok.length > 0 && (
          <button className="flex h-11 items-center justify-center gap-2 rounded-ctl bg-brand-700 text-sm font-medium text-white shadow-card hover:bg-brand-800">
            <Printer className="size-4" aria-hidden /> Print labels (1 PDF, {formatInt(ok.length)}{' '}
            label{ok.length === 1 ? '' : 's'})
          </button>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button className="h-10 rounded-ctl border border-border text-13 font-medium hover:bg-hover">
            Packing slips
          </button>
          <button
            onClick={onDone}
            className="h-10 rounded-ctl bg-side text-13 font-medium text-white hover:bg-side-hover"
          >
            Done
          </button>
        </div>
      </div>
    </Panel>
  );
}
