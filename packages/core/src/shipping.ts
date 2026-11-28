import { allocateLargestRemainder } from './allocate.ts';
import type { Pence } from './money.ts';

/** C3.4, ORD-9: a label is shared by at most this many orders. */
export const SHIP_TOGETHER_MAX = 20;

/**
 * SHP-9, C3.4: a shared label's cost in equal shares, the remainder pence to the earliest orders,
 * so the shares always add up to the cost (largest remainder, FA-12). `members` are in placed
 * order, earliest first.
 */
export function labelCostShares(cost: bigint, members: number): Pence[] {
  if (!Number.isInteger(members) || members < 1 || members > SHIP_TOGETHER_MAX) {
    throw new RangeError('a label is shared by 1 to 20 orders');
  }
  return allocateLargestRemainder(
    cost,
    Array.from({ length: members }, () => 1n),
  );
}

/** EVRI-3: `{orderRef}-{parcelNo}`, cut from the front of the reference to Evri's 255. */
export function clientUid(orderRef: string, parcelNo: number): string {
  const suffix = `-${String(parcelNo)}`;
  return `${orderRef.slice(0, 255 - suffix.length)}${suffix}`;
}

/** A carrier service; `rank` orders services from basic to best (SHP-9: the highest needed). */
export interface CarrierServiceInfo {
  readonly code: string;
  readonly name: string;
  readonly rank: number;
}

/**
 * The services each carrier offers. Evri has no services endpoint (EVRI-6): standard, with a
 * signature, and next day ("only for certain users"). DPD's come with M13.
 */
export const CARRIER_SERVICES: Readonly<Record<'evri' | 'dpd', readonly CarrierServiceInfo[]>> = {
  evri: [
    { code: 'standard', name: 'Evri Standard', rank: 0 },
    { code: 'signature', name: 'Evri Signature', rank: 1 },
    { code: 'next_day', name: 'Evri Next Day', rank: 2 },
  ],
  dpd: [],
};

export function isCarrierService(provider: 'evri' | 'dpd', code: string): boolean {
  return CARRIER_SERVICES[provider].some((s) => s.code === code);
}

/**
 * SHIP-4: carrier codes in plain words. The raw code is always shown beside them; an unknown code
 * reads as the general line.
 */
export const CARRIER_ERROR_WORDS: Readonly<Record<string, string>> = {
  'evri.missing_property': 'Evri says a required detail is missing.',
  'evri.invalid_property': 'Evri says a detail is not valid.',
  'evri.delivery_unavailable': 'Evri cannot deliver to this address with this service.',
  'evri.duplicate_client_uid':
    'Evri may already hold this parcel (its answer was lost). Check Evri’s My Shipments before relabelling.',
  'evri.unauthorised': 'Evri needs re-authorising. Ask an admin to paste a new Evri code.',
  'evri.label_not_printable': 'Evri says this label cannot be printed now (it may be delivered).',
  'evri.barcode_unknown': 'Evri does not recognise this barcode.',
  'evri.bad_label_format': 'Evri does not accept the label format setting.',
  'carrier.no_answer':
    'The carrier did not answer in time; it may hold this parcel. Check its account before relabelling.',
  'carrier.unavailable': 'The carrier could not be reached. Nothing was bought; try again.',
  'label.voided': 'This label was voided.',
};

export function carrierErrorWords(code: string): string {
  return CARRIER_ERROR_WORDS[code] ?? 'The carrier refused this label.';
}
