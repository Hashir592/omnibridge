import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import {
  Check,
  ChevronLeft,
  Copy,
  Eye,
  Link2Off,
  MapPinOff,
  OctagonAlert,
  Printer,
  ShieldAlert,
  Tag,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { lastOrdersSearch } from '../app/lastSearch.ts';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanySwatch, StatusChip } from '../components/badges.tsx';
import { cn } from '../lib/cn.ts';
import { overdueText, formatDate, formatDateTime, formatPence, formatTime } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import type { OrderDetail, OrderRow } from '../mocks/types.ts';

const route = getRouteApi('/orders/$orderId');

/** Order detail (ORD-6). Full buyer details appear only here and on the shipping desk (ORD-5). */
export function OrderDetailPage() {
  const { orderId } = route.useParams();
  const { session, persona } = useAppState();
  const query = useQuery({
    queryKey: ['order', orderId, persona],
    queryFn: () => mockApi.order(orderId),
    enabled: !!session,
    gcTime: 0, // holds buyer PII: drop it from memory as soon as the page closes
    retry: false,
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <Link
          to="/orders"
          search={lastOrdersSearch()}
          className="-ml-1 inline-flex h-8 items-center gap-1 rounded-ctl px-1 text-13 text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden /> Back to orders
        </Link>
        {query.isError ? (
          <NotFound />
        ) : query.data ? (
          <Detail d={query.data} />
        ) : (
          <div aria-busy className="mt-4 h-40" />
        )}
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <Card className="mt-4 max-w-xl p-6">
      <p className="text-sm font-medium">This order is not available</p>
      <p className="mt-1 text-13 text-ink-muted">
        It may belong to a company you cannot see, or the link is wrong. Go back to the list and
        search by order ref.
      </p>
    </Card>
  );
}

function Detail({ d }: { d: OrderDetail }) {
  const o = d.order;
  const { company } = useAppState();
  const c = company(o.companyId);
  const awaiting = o.status === 'awaiting_dispatch';

  return (
    <>
      {/* Header */}
      <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="ref text-[22px] leading-7 font-semibold tracking-[-0.01em]">{o.ref}</h1>
            <CopyButton value={o.ref} label="Copy order ref" />
            <StatusChip status={o.status} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-13 text-ink-muted">
            <span className="inline-grid grid-cols-[18px_auto] items-center gap-x-2">
              <ChannelMark channel={o.channel} />
            </span>
            <span>{d.channelAccountName}</span>
            {c && (
              <span className="inline-flex items-center gap-1.5">
                <CompanySwatch company={c} />
                {c.tradingName}
              </span>
            )}
            <span className="num">Placed {formatDateTime(o.placedAt)}</span>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {d.label && (
            <button className="flex h-9 items-center gap-1.5 rounded-ctl border border-border bg-card px-3.5 text-13 font-medium shadow-card hover:bg-hover">
              <Printer className="size-4 text-ink-muted" aria-hidden /> Reprint label
            </button>
          )}
          <button className="flex h-9 items-center gap-1.5 rounded-ctl border border-border bg-card px-3.5 text-13 font-medium shadow-card hover:bg-hover">
            <Printer className="size-4 text-ink-muted" aria-hidden /> Packing slip
          </button>
          {awaiting && (
            <button className="flex h-9 items-center gap-1.5 rounded-ctl bg-brand-700 px-4 text-13 font-medium text-white shadow-card hover:bg-brand-800">
              <Tag className="size-4" aria-hidden /> Create label
            </button>
          )}
        </div>
      </div>

      <Alerts o={o} />

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Items d={d} />
          <Profit d={d} />
          <History d={d} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <ShipTo d={d} />
          {d.sameBuyer.length > 0 && <SameBuyer d={d} />}
          <Shipping d={d} />
          <Notes d={d} />
        </div>
      </div>
    </>
  );
}

/* ---------- building blocks ---------- */

function Card({
  title,
  aside,
  className,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('rounded-card border border-border bg-card shadow-card', className)}>
      {title && (
        <header className="flex items-center gap-3 border-b border-divider px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {aside && <div className="ml-auto">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => {
        if ('clipboard' in navigator) void navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => {
          setDone(false);
        }, 1500);
      }}
      className="grid size-7 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink"
    >
      {done ? (
        <Check className="size-4 text-success" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
    </button>
  );
}

/** A label for figures that are not exact (PRD signal labels). */
function Signal({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-[11px] font-medium text-ink-muted">
      {children}
    </span>
  );
}

const Row = ({
  label,
  value,
  strong,
  muted,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  muted?: boolean;
}) => (
  <div
    className={cn(
      'flex items-baseline justify-between gap-4 py-1.5 text-13',
      strong && 'font-semibold text-ink',
      muted && 'text-ink-muted',
    )}
  >
    <span>{label}</span>
    <span className="num">{value}</span>
  </div>
);

/* ---------- alerts ---------- */

function Alerts({ o }: { o: OrderRow }) {
  const items: Array<{
    tone: 'danger' | 'warning';
    icon: LucideIcon;
    title: string;
    body: string;
  }> = [];
  if (o.status === 'awaiting_dispatch' && Date.parse(o.shipBy) < Date.now()) {
    items.push({
      tone: 'danger',
      icon: OctagonAlert,
      title: `Past ship-by: ${overdueText(o.shipBy).toLowerCase()}`,
      body: `It was due by ${formatDateTime(o.shipBy)}. Late dispatch counts against account health.`,
    });
  }
  if (o.flags.includes('oversold'))
    items.push({
      tone: 'danger',
      icon: OctagonAlert,
      title: 'Oversold',
      body: 'Stock went below zero when this order arrived. Check the shelf before packing.',
    });
  if (o.flags.includes('unmapped'))
    items.push({
      tone: 'warning',
      icon: Link2Off,
      title: 'Unmapped item',
      body: 'An item is not linked to a Master SKU, so stock and profit are not updated. Map it in Stock & Catalogue.',
    });
  if (o.flags.includes('address_shortened'))
    items.push({
      tone: 'warning',
      icon: MapPinOff,
      title: 'Address shortened',
      body: "The address was cut to fit the carrier's field limits. Check it before printing the label.",
    });
  if (o.flags.includes('tracking_unconfirmed'))
    items.push({
      tone: 'warning',
      icon: TriangleAlert,
      title: 'Tracking not confirmed',
      body: 'The channel has not accepted the tracking number yet. OmniBridge retries automatically.',
    });
  if (items.length === 0) return null;
  return (
    <div className="mt-4 flex flex-col gap-2">
      {items.map((a) => {
        const Icon = a.icon;
        return (
          <div
            key={a.title}
            role="status"
            className={cn(
              'flex items-start gap-3 rounded-ctl border px-4 py-3 text-13',
              a.tone === 'danger'
                ? 'border-[#f0caca] bg-danger-bg'
                : 'border-[#f1d9b8] bg-warning-bg',
            )}
          >
            <Icon
              className={cn(
                'mt-px size-4 shrink-0',
                a.tone === 'danger' ? 'text-danger' : 'text-warning',
              )}
              aria-hidden
            />
            <p>
              <span
                className={cn(
                  'font-semibold',
                  a.tone === 'danger' ? 'text-danger' : 'text-warning',
                )}
              >
                {a.title}.{' '}
              </span>
              <span className="text-ink">{a.body}</span>
            </p>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- left column ---------- */

function Items({ d }: { d: OrderDetail }) {
  const m = d.money;
  return (
    <Card title={`Items (${String(d.order.itemCount)})`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-13">
          <thead>
            <tr className="border-b border-divider text-left text-xs text-ink-muted">
              <th className="px-5 py-2.5 font-medium">Item</th>
              <th className="px-3 py-2.5 text-right font-medium">Qty</th>
              <th className="px-3 py-2.5 text-right font-medium">Unit price</th>
              <th className="px-3 py-2.5 text-right font-medium">VAT</th>
              <th className="px-5 py-2.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.sku} className="border-b border-divider align-top last:border-0">
                <td className="px-5 py-3">
                  <div className="font-medium text-ink">{l.title}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted">
                    <span>SKU {l.sku}</span>
                    {l.externalSku !== l.sku && <span>Channel SKU {l.externalSku}</span>}
                  </div>
                  {!l.mapped && (
                    <div className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-warning">
                      <Link2Off className="size-3.5" aria-hidden /> Not mapped to a Master SKU
                    </div>
                  )}
                </td>
                <td className="num px-3 py-3 text-right">{l.qty}</td>
                <td className="num px-3 py-3 text-right">{formatPence(l.unitPence)}</td>
                <td className="num px-3 py-3 text-right text-ink-muted">{l.vatRate}%</td>
                <td className="num px-5 py-3 text-right font-medium">
                  {formatPence(l.unitPence * l.qty)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end border-t border-divider px-5 py-3">
        <div className="w-full max-w-72">
          <Row label="Items" value={formatPence(m.itemsGross)} />
          <Row
            label="Shipping charged"
            value={m.shippingPence ? formatPence(m.shippingPence) : 'Free'}
          />
          {m.discountPence > 0 && <Row label="Discounts" value={formatPence(-m.discountPence)} />}
          <div className="mt-1 border-t border-divider pt-1">
            <Row label="Total paid" value={formatPence(m.totalPence)} strong />
          </div>
          <Row label="Includes VAT" value={formatPence(m.vatPence)} muted />
          {m.refundPence > 0 && <Row label="Refunded" value={formatPence(-m.refundPence)} muted />}
        </div>
      </div>
    </Card>
  );
}

/** VAT at 20% on an ex VAT amount, rounded half-up once per row (PRF-6). */
const vat20 = (exPence: number) => Math.round(exPence * 0.2);

/**
 * Profit card (client change C4, PRF-6): one table with Ex VAT, VAT and Inc VAT. Profit is the
 * ex VAT figure (PRF-2); Inc VAT is the cash before the VAT settlement. Fees are estimates until
 * the channel settles them (PRF-5).
 */
function Profit({ d }: { d: OrderDetail }) {
  const m = d.money;
  const salesInc = m.totalPence - m.refundPence;
  const salesVat = Math.round(salesInc / 6);
  const rows = [
    {
      label: 'Sales',
      note: 'Paid by the buyer, less refunds',
      ex: salesInc - salesVat,
      vat: salesVat,
    },
    { label: 'Channel fees', estimate: true, ex: -m.feePence, vat: -vat20(m.feePence) },
    { label: 'Label cost', ex: -m.labelPence, vat: -vat20(m.labelPence) },
    {
      label: 'Cost of goods',
      note: 'Snapshot when the order was placed',
      ex: -m.cogsPence,
      vat: -vat20(m.cogsPence),
    },
  ];
  const profitEx = rows.reduce((a, r) => a + r.ex, 0);
  const netVat = rows.reduce((a, r) => a + r.vat, 0);
  const salesEx = rows[0]?.ex ?? 0;
  const money = (p: number) => (p === 0 ? '-' : formatPence(p));
  return (
    <Card title="Profit" aside={<Signal>Estimate</Signal>}>
      <div className="overflow-x-auto">
        <table aria-label="Profit on this order" className="w-full border-collapse text-13">
          <thead>
            <tr className="h-10 bg-rail text-xs text-ink-muted">
              <th scope="col" className="border-b border-divider pl-5 text-left font-medium">
                Line
              </th>
              {['Ex VAT', 'VAT', 'Inc VAT'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="border-b border-divider px-4 text-right font-medium last:pr-5"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-divider">
                <th scope="row" className="py-2 pl-5 text-left font-normal">
                  <span className="flex items-center gap-2">
                    {r.label}
                    {r.estimate && <Signal>Estimate</Signal>}
                  </span>
                  {r.note && <span className="block text-xs text-ink-muted">{r.note}</span>}
                </th>
                <td className="num px-4 text-right">{money(r.ex)}</td>
                <td className="num px-4 text-right text-ink-muted">{money(r.vat)}</td>
                <td className="num px-4 pr-5 text-right">{money(r.ex + r.vat)}</td>
              </tr>
            ))}
            <tr className="h-11 bg-rail">
              <th scope="row" className="pl-5 text-left font-semibold">
                Profit
              </th>
              <td
                className={cn('num px-4 text-right font-semibold', profitEx < 0 && 'text-danger')}
              >
                {formatPence(profitEx)}
              </td>
              <td className="num px-4 text-right font-semibold">{formatPence(netVat)}</td>
              <td className="num px-4 pr-5 text-right font-semibold">
                {formatPence(profitEx + netVat)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1 px-5 py-3 text-xs text-ink-muted">
        <span className="num font-medium text-ink">
          {salesEx > 0
            ? `${String(Math.round((profitEx / salesEx) * 100))}% of sales after VAT`
            : 'No sales left after refunds'}
        </span>
        <span>
          Profit is the ex VAT figure. Inc VAT is the cash before you settle VAT with HMRC; the
          difference is the net VAT of {formatPence(netVat)}.
        </span>
      </div>
    </Card>
  );
}

/** C3: the other orders of this order's same-buyer group, with links. */
function SameBuyer({ d }: { d: OrderDetail }) {
  return (
    <Card
      title="Same buyer"
      aside={<span className="num text-xs text-ink-muted">{d.sameBuyer.length + 1} orders</span>}
    >
      <ul className="px-5 py-2">
        {d.sameBuyer.map((o) => (
          <li key={o.id} className="border-b border-divider py-2.5 text-13 last:border-0">
            <Link
              to="/orders/$orderId"
              params={{ orderId: o.id }}
              className="ref font-medium whitespace-nowrap text-brand-600 hover:underline"
            >
              {o.ref}
            </Link>
            <span className="num block text-xs text-ink-muted">
              Placed {formatDate(o.placedAt)} {formatTime(o.placedAt)} · {formatPence(o.totalPence)}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
        Same buyer and address on this channel account. Ship them as one parcel with Ship together
        on the order list or the shipping desk.
      </p>
    </Card>
  );
}

function History({ d }: { d: OrderDetail }) {
  return (
    <Card title="History">
      <ol className="px-5 py-4">
        {d.history.map((e, i) => (
          <li
            key={`${e.at}-${e.label}`}
            className="relative grid grid-cols-[132px_16px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0"
          >
            <span className="num pt-px text-xs text-ink-muted">
              {formatDate(e.at)} {formatTime(e.at)}
            </span>
            <span aria-hidden className="relative flex justify-center">
              <span
                className={cn(
                  'mt-1 size-2.5 rounded-full border-2',
                  i === d.history.length - 1 ? 'border-side bg-side' : 'border-[#b9c0ca] bg-card',
                )}
              />
              {i < d.history.length - 1 && (
                <span className="absolute top-4 -bottom-4 w-px bg-border" />
              )}
            </span>
            <span className="text-13">
              <span className="font-medium text-ink">{e.label}</span>
              <span className="text-ink-muted"> by {e.by}</span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/* ---------- right column ---------- */

function ShipTo({ d }: { d: OrderDetail }) {
  const b = d.buyer;
  return (
    <Card title="Ship to">
      <address className="px-5 pt-4 pb-3 text-13 leading-5 not-italic">
        <div className="text-sm font-semibold text-ink">{b.name}</div>
        {b.lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
        <div>{b.town}</div>
        <div className="font-medium">{b.postcode}</div>
        <div className="text-ink-muted">{b.country}</div>
        <div className="num mt-2 text-ink-muted">{b.phone}</div>
      </address>
      <p className="flex items-start gap-2 border-t border-divider px-5 py-3 text-xs text-ink-muted">
        <Eye className="mt-px size-3.5 shrink-0" aria-hidden />
        Full customer details. Each view is logged with your name and the time.
      </p>
    </Card>
  );
}

const TRACK: Record<OrderRow['tracking'], { text: string; tone: 'ok' | 'wait' | 'bad' | 'none' }> =
  {
    none: { text: 'Nothing to send until a label exists', tone: 'none' },
    pending: { text: 'Sent after the first carrier scan', tone: 'wait' },
    pushed: { text: 'Sent, waiting for the channel to confirm', tone: 'wait' },
    confirmed: { text: 'Confirmed by the channel', tone: 'ok' },
    not_confirmed: { text: 'Not confirmed yet; retrying', tone: 'bad' },
  };

function Shipping({ d }: { d: OrderDetail }) {
  const o = d.order;
  const t = TRACK[o.tracking];
  return (
    <Card title="Shipping">
      <dl className="px-5 py-3 text-13">
        <div className="flex justify-between gap-4 py-1.5">
          <dt className="text-ink-muted">Ship by</dt>
          <dd className="num text-right">{formatDateTime(o.shipBy)}</dd>
        </div>
        <div className="flex justify-between gap-4 py-1.5">
          <dt className="text-ink-muted">Service</dt>
          <dd className="text-right">
            {o.shipping ? `${o.shipping.carrier} ${o.shipping.service}` : 'No label yet'}
          </dd>
        </div>
        {d.label && (
          <>
            <div className="flex items-center justify-between gap-4 py-1">
              <dt className="text-ink-muted">Tracking</dt>
              <dd className="flex items-center gap-1">
                <span className="ref font-medium">{d.label.trackingNumber}</span>
                <CopyButton value={d.label.trackingNumber} label="Copy tracking number" />
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-1.5">
              <dt className="text-ink-muted">Label created</dt>
              <dd className="num text-right">{formatDateTime(d.label.createdAt)}</dd>
            </div>
          </>
        )}
        <div className="flex justify-between gap-4 py-1.5">
          <dt className="text-ink-muted">Tracking to channel</dt>
          <dd
            className={cn(
              'max-w-44 text-right',
              t.tone === 'ok' && 'text-success',
              t.tone === 'bad' && 'font-medium text-warning',
              t.tone === 'none' && 'text-ink-muted',
            )}
          >
            {t.text}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function Notes({ d }: { d: OrderDetail }) {
  const [notes, setNotes] = useState(d.notes);
  const [draft, setDraft] = useState('');
  const { session } = useAppState();
  return (
    <Card title="Internal notes">
      <p className="mx-5 mt-4 flex items-start gap-2 rounded-ctl bg-surface px-3 py-2 text-xs text-ink">
        <ShieldAlert className="mt-px size-3.5 shrink-0 text-ink-muted" aria-hidden />
        Do not store customer details here.
      </p>
      {notes.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3 px-5">
          {notes.map((n) => (
            <li key={n.at + n.text} className="text-13">
              <p className="text-ink">{n.text}</p>
              <p className="num mt-0.5 text-xs text-ink-muted">
                {n.by}, {formatDateTime(n.at)}
              </p>
            </li>
          ))}
        </ul>
      )}
      <form
        className="px-5 pt-3 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          setNotes((ns) => [
            ...ns,
            { at: new Date().toISOString(), by: session?.user.name ?? 'You', text: draft.trim() },
          ]);
          setDraft('');
        }}
      >
        <label htmlFor="note" className="sr-only">
          Add a note
        </label>
        <textarea
          id="note"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          rows={2}
          placeholder="Add a note for the team"
          className="w-full resize-y rounded-ctl border border-border bg-card px-3 py-2 text-13 outline-none placeholder:text-ink-muted focus:border-brand-600"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={!draft.trim()}
            className="h-8 rounded-ctl bg-side px-3 text-13 font-medium text-white hover:bg-side-hover disabled:opacity-40"
          >
            Add note
          </button>
        </div>
      </form>
    </Card>
  );
}
