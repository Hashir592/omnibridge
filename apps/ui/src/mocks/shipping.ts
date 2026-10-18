/**
 * Shipping desk mocks (T-0301). PROPOSED SHAPES (mock only): carrier accounts, shipping rules
 * (SHP-3, first match wins) and the label batch result (SHP-2). No carrier is called.
 */
import { daysFromToday } from '../lib/format.ts';
import type { OrderRow } from './types.ts';

export interface CarrierService {
  id: string;
  carrier: 'Evri' | 'DPD';
  account: string;
  service: string;
}

export const SERVICES: CarrierService[] = [
  { id: 'evri-48', carrier: 'Evri', account: 'Evri account 1', service: '48h' },
  { id: 'evri-nd', carrier: 'Evri', account: 'Evri account 1', service: 'Next Day' },
  { id: 'dpd-nd', carrier: 'DPD', account: 'DPD account 1', service: 'Next Day' },
  { id: 'dpd-sat', carrier: 'DPD', account: 'DPD account 1', service: 'Saturday' },
];

export const LABEL_FORMAT = '4 x 6 in thermal';
export const PACKAGING_GRAMS = 150;
const GRAMS_PER_ITEM = 340;

/** Default weight: sum of SKU weights plus the packaging allowance setting (SHP-2). */
export function defaultWeightGrams(o: OrderRow): number {
  return o.itemCount * GRAMS_PER_ITEM + PACKAGING_GRAMS;
}

/** Shipping rules, first match wins (SHP-3). Returns the service and the rule that chose it. */
export function ruleFor(o: OrderRow, grams: number): { serviceId: string; rule: string } {
  if (grams >= 2000)
    return { serviceId: 'dpd-nd', rule: 'Rule 1: 2 kg and over goes DPD Next Day' };
  if (daysFromToday(o.shipBy) <= 0 || Date.parse(o.shipBy) < Date.now())
    return { serviceId: 'evri-nd', rule: 'Rule 2: due today or late goes Evri Next Day' };
  return { serviceId: 'evri-48', rule: 'Rule 3: everything else goes Evri 48h' };
}

export interface LabelResult {
  orderId: string;
  ref: string;
  ok: boolean;
  trackingNumber?: string;
  error?: string;
}

/** Mock batch: one label per order; shortened addresses fail the way a carrier would reject them. */
export async function createLabels(
  orders: OrderRow[],
  services: Record<string, string>,
): Promise<LabelResult[]> {
  await new Promise((r) => setTimeout(r, 900));
  return orders.map((o, i) => {
    if (o.flags.includes('address_shortened')) {
      return {
        orderId: o.id,
        ref: o.ref,
        ok: false,
        error:
          'The carrier rejected the address: line 1 is longer than 35 characters. Fix it on the order, then try again.',
      };
    }
    const s = SERVICES.find((x) => x.id === services[o.id]);
    const tn =
      s?.carrier === 'DPD'
        ? `1550${String(48210000 + i * 7919).padStart(10, '0')}`
        : `H01${(91_337_000 + i * 104_729).toString(36).toUpperCase()}GB`;
    return { orderId: o.id, ref: o.ref, ok: true, trackingNumber: tn };
  });
}
