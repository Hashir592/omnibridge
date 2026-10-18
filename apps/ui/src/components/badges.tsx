import {
  CircleCheck,
  CircleX,
  Clock,
  Link2Off,
  MapPinOff,
  OctagonAlert,
  PackageOpen,
  RotateCcw,
  Tag,
  TriangleAlert,
  Truck,
  Undo2,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn.ts';
import type { Channel, Company, OrderFlag, OrderStatus } from '../mocks/types.ts';

const HUE: Record<Company['hue'], string> = {
  teal: 'bg-co-teal',
  violet: 'bg-co-violet',
  cyan: 'bg-co-cyan',
  magenta: 'bg-co-magenta',
  olive: 'bg-co-olive',
  brown: 'bg-co-brown',
  indigo: 'bg-co-indigo',
  slate: 'bg-co-slate',
};

/**
 * Company badge (TEN-2): a muted swatch and the name. Never a status colour.
 * Renders two grid cells (swatch, name) so it lines up under ChannelMark in a 2-column grid.
 */
export function CompanyBadge({ company, full }: { company: Company; full?: boolean }) {
  return (
    <>
      <span aria-hidden className="grid place-items-center">
        <span className={cn('size-2 rounded-full', HUE[company.hue])} />
      </span>
      <span className="truncate text-xs leading-4 text-ink-muted" title={company.tradingName}>
        {full ? company.tradingName : company.code}
      </span>
    </>
  );
}

export function CompanySwatch({ company }: { company: Company }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', HUE[company.hue])} />;
}

const CHANNEL: Record<Channel, { label: string; glyph: string }> = {
  amazon: { label: 'Amazon', glyph: 'a' },
  ebay: { label: 'eBay', glyph: 'e' },
  website: { label: 'Website', glyph: 'w' },
};

/** Channel glyph and name, as two grid cells (see CompanyBadge). */
export function ChannelMark({ channel }: { channel: Channel }) {
  const c = CHANNEL[channel];
  return (
    <>
      <span
        aria-hidden
        className="grid size-[18px] place-items-center rounded-[5px] bg-[#ece8e0] text-[10px] leading-none font-semibold text-ink"
      >
        {c.glyph}
      </span>
      <span className="truncate text-13 leading-[18px] text-ink">{c.label}</span>
    </>
  );
}

type Tone = 'neutral' | 'muted' | 'info' | 'success' | 'warning' | 'danger';

/** Icon colour per tone. The label stays ink, so colour is never the only signal. */
const ICON: Record<Tone, string> = {
  neutral: 'text-ink',
  muted: 'text-ink-muted',
  info: 'text-brand-600',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/** Where an order is in the dispatch lifecycle (4 steps), for the progress ticks. */
const STEP: Partial<Record<OrderStatus, number>> = {
  pending_payment: 0,
  awaiting_dispatch: 1,
  label_created: 2,
  dispatched: 3,
  delivered: 4,
};

export const STATUS: Record<OrderStatus, { label: string; icon: LucideIcon; tone: Tone }> = {
  pending_payment: { label: 'Pending payment', icon: Clock, tone: 'muted' },
  awaiting_dispatch: { label: 'Awaiting dispatch', icon: PackageOpen, tone: 'info' },
  label_created: { label: 'Label created', icon: Tag, tone: 'info' },
  dispatched: { label: 'Dispatched', icon: Truck, tone: 'neutral' },
  delivered: { label: 'Delivered', icon: CircleCheck, tone: 'success' },
  cancelled: { label: 'Cancelled', icon: CircleX, tone: 'muted' },
  partly_refunded: { label: 'Partly refunded', icon: Undo2, tone: 'neutral' },
  refunded: { label: 'Refunded', icon: Undo2, tone: 'muted' },
  returned: { label: 'Returned', icon: RotateCcw, tone: 'warning' },
};

/**
 * Status: coloured icon plus plain label, and for open orders four small ticks showing how far
 * the order is through paid, label, dispatched, delivered. Closed orders (cancelled, refunded,
 * returned) show the label only.
 */
export function StatusChip({ status }: { status: OrderStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  const step = STEP[status];
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <span
        className={cn(
          'flex items-center gap-1.5 text-13 leading-[18px] whitespace-nowrap',
          s.tone === 'muted' ? 'text-ink-muted' : 'text-ink',
        )}
      >
        <Icon aria-hidden className={cn('size-4 shrink-0', ICON[s.tone])} strokeWidth={2} />
        {s.label}
      </span>
      {step !== undefined && (
        <span aria-hidden className="flex gap-[3px] pl-[22px]">
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={cn(
                'h-[3px] w-4 rounded-full',
                i <= step
                  ? status === 'delivered'
                    ? 'bg-success'
                    : 'bg-brand-600'
                  : 'bg-[#e2e5ea]',
              )}
            />
          ))}
        </span>
      )}
    </span>
  );
}

export const FLAG: Record<OrderFlag, { label: string; icon: LucideIcon; className: string }> = {
  oversold: { label: 'Oversold', icon: OctagonAlert, className: 'text-danger' },
  unmapped: { label: 'Unmapped item', icon: Link2Off, className: 'text-warning' },
  address_shortened: { label: 'Address shortened', icon: MapPinOff, className: 'text-warning' },
  tracking_unconfirmed: {
    label: 'Tracking not confirmed',
    icon: TriangleAlert,
    className: 'text-warning',
  },
  fba: { label: 'FBA', icon: Warehouse, className: 'text-ink-muted' },
};

export function FlagMark({ flag }: { flag: OrderFlag }) {
  const f = FLAG[flag];
  const Icon = f.icon;
  return (
    <span
      title={f.label}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 text-xs font-medium whitespace-nowrap',
        f.className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span className="truncate">{f.label}</span>
    </span>
  );
}
