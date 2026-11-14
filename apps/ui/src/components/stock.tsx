import {
  CircleCheck,
  CircleSlash,
  OctagonAlert,
  PackageX,
  RefreshCwOff,
  TrendingDown,
  type LucideIcon,
} from 'lucide-react';
import { StatusLabel, type StatusTone } from '../kit/Badge.tsx';
import type { SkuState } from '../mocks/stock.ts';

export const SKU_STATE: Record<SkuState, { label: string; tone: StatusTone; icon: LucideIcon }> = {
  in_stock: { label: 'In stock', tone: 'success', icon: CircleCheck },
  low: { label: 'Low cover', tone: 'warning', icon: TrendingDown },
  out: { label: 'Out of stock', tone: 'warning', icon: PackageX },
  oversold: { label: 'Oversold', tone: 'danger', icon: OctagonAlert },
  sync_failed: { label: 'Sync failed', tone: 'warning', icon: RefreshCwOff },
  inactive: { label: 'Inactive', tone: 'neutral', icon: CircleSlash },
};

/** Stock state of a Master SKU: coloured icon and plain label (ADR-041). */
export function SkuStatus({ state }: { state: SkuState }) {
  const s = SKU_STATE[state];
  return (
    <StatusLabel tone={s.tone} icon={s.icon}>
      {s.label}
    </StatusLabel>
  );
}

/** "23 days" of cover, or "-" when nothing sold. */
export function coverText(days: number | null): string {
  if (days === null) return 'No recent sales';
  if (days > 365) return 'Over a year';
  return `${String(days)} day${days === 1 ? '' : 's'}`;
}
