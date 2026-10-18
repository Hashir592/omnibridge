/**
 * Seeded synthetic data for the mock-ups (T-0301). Generic names only; no real customers and no
 * testkit PII markers. Buyer details appear only as already-masked strings.
 */
import type {
  Channel,
  ChannelAccount,
  Company,
  OrderFlag,
  OrderRow,
  OrderStatus,
  TrackingState,
} from './types.ts';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261018);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join('');

export const companies: Company[] = [
  { id: 'co_1', tradingName: 'Northfield Trading', code: 'NFT', hue: 'indigo' },
  { id: 'co_2', tradingName: 'Harbour Goods', code: 'HBG', hue: 'violet' },
  { id: 'co_3', tradingName: 'Kestrel Home', code: 'KSH', hue: 'olive' },
];

export const channelAccounts: ChannelAccount[] = [
  { id: 'ca_1', channel: 'amazon', name: 'Amazon UK · Northfield', companyId: 'co_1' },
  { id: 'ca_2', channel: 'ebay', name: 'eBay · northfield-trading', companyId: 'co_1' },
  { id: 'ca_3', channel: 'amazon', name: 'Amazon UK · Harbour', companyId: 'co_2' },
  { id: 'ca_4', channel: 'website', name: 'harbourgoods.co.uk', companyId: 'co_2' },
  { id: 'ca_5', channel: 'ebay', name: 'eBay · kestrel-home', companyId: 'co_3' },
];

const AREAS = [
  'G2',
  'M14',
  'LS6',
  'BS3',
  'CF10',
  'EH7',
  'B12',
  'NE1',
  'SW9',
  'N16',
  'PL4',
  'OX4',
  'L8',
  'S11',
];
const LETTERS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'J',
  'K',
  'L',
  'M',
  'N',
  'P',
  'R',
  'S',
  'T',
  'W',
];

function refFor(channel: Channel, i: number): string {
  if (channel === 'amazon') return `20${String(int(2, 6))}-${digits(7)}-${digits(7)}`;
  if (channel === 'ebay') return `${String(int(10, 27))}-${digits(5)}-${digits(5)}`;
  return `W${String(18_400 + i)}`;
}

function statusFor(daysAgo: number): OrderStatus {
  if (daysAgo <= 2) {
    const r = rand();
    if (r < 0.06) return 'pending_payment';
    if (r < 0.78) return 'awaiting_dispatch';
    if (r < 0.88) return 'label_created';
    return 'dispatched';
  }
  const r = rand();
  if (r < 0.006) return 'awaiting_dispatch';
  if (r < 0.55) return 'dispatched';
  if (r < 0.8) return 'delivered';
  if (r < 0.86) return 'cancelled';
  if (r < 0.9) return 'partly_refunded';
  if (r < 0.95) return 'refunded';
  return 'returned';
}

const DAY = 86_400_000;

function generate(count: number): OrderRow[] {
  const now = Date.now();
  const rows: OrderRow[] = [];
  for (let i = 0; i < count; i++) {
    const account = pick(channelAccounts);
    // Newest first: spread 500 orders over about 21 days, denser recently.
    const ageMs = Math.floor(Math.pow(i / count, 1.4) * 21 * DAY) + int(0, 40) * 60_000;
    const placed = now - ageMs;
    const daysAgo = ageMs / DAY;
    const status = statusFor(daysAgo);
    const fba = account.channel === 'amazon' && rand() < 0.1 && status !== 'awaiting_dispatch';
    const shipBy = placed + (account.channel === 'amazon' ? 1.6 : 2) * DAY;

    const flags: OrderFlag[] = [];
    if (fba) flags.push('fba');
    if (status === 'awaiting_dispatch' && rand() < 0.03) flags.push('oversold');
    if (rand() < 0.025) flags.push('unmapped');
    if (!fba && rand() < 0.02) flags.push('address_shortened');

    let tracking: TrackingState = 'none';
    let shipping: OrderRow['shipping'] = null;
    if (fba) {
      shipping = { carrier: 'Amazon', service: 'FBA' };
      tracking = 'confirmed';
    } else if (status === 'label_created') {
      shipping = pick([
        { carrier: 'Evri', service: 'Next Day' },
        { carrier: 'DPD', service: 'Next Day' },
        { carrier: 'Evri', service: '48h' },
      ]);
      tracking = 'pending';
    } else if (['dispatched', 'delivered', 'returned', 'partly_refunded'].includes(status)) {
      shipping = pick([
        { carrier: 'Evri', service: '48h' },
        { carrier: 'Evri', service: 'Next Day' },
        { carrier: 'DPD', service: 'Next Day' },
      ]);
      const r = rand();
      tracking =
        status === 'dispatched' && r < 0.08 ? 'not_confirmed' : r < 0.3 ? 'pushed' : 'confirmed';
      if (tracking === 'not_confirmed') flags.push('tracking_unconfirmed');
    }

    const itemCount = rand() < 0.75 ? 1 : int(2, 4);
    const unit = pick([499, 799, 999, 1249, 1499, 1899, 2499, 3499, 4999, 7999]);
    rows.push({
      id: `ord_${String(i + 1).padStart(4, '0')}`,
      ref: refFor(account.channel, i),
      channel: account.channel,
      channelAccountId: account.id,
      companyId: account.companyId,
      placedAt: new Date(placed).toISOString(),
      shipBy: new Date(shipBy).toISOString(),
      status,
      itemCount,
      totalPence: unit * itemCount + (unit < 1500 ? 299 : 0),
      shipping,
      tracking,
      flags,
      shipToMasked: `${pick(LETTERS)}. ${pick(LETTERS)}***, ${pick(AREAS)}`,
    });
  }
  return rows;
}

export const orders: OrderRow[] = generate(500);
