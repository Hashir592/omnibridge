/**
 * Order detail for the mock-ups (T-0301), derived from the list row so both always agree.
 * PROPOSED SHAPE (mock only). Buyer details are synthetic and built to match the masked string;
 * no real people, no testkit PII markers.
 */
import { channelAccounts } from './data.ts';
import { SCENARIO_BUYERS } from './scenarios.ts';
import type { OrderDetail, OrderEvent, OrderLine, OrderRow, OrderSkuLine } from './types.ts';

function seeded(id: string): () => number {
  let a = 2166136261;
  for (let i = 0; i < id.length; i++) a = Math.imul(a ^ id.charCodeAt(i), 16777619);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNITS = [499, 799, 999, 1249, 1499, 1899, 2499, 3499, 4999, 7999];

const PRODUCTS: Array<{ sku: string; title: string }> = [
  { sku: 'KH-MUG-350-SG', title: 'Stoneware mug 350 ml, sage' },
  { sku: 'KH-TWL-BTH-GR', title: 'Cotton bath towel, graphite' },
  { sku: 'NF-LED-E27-4P', title: 'LED bulb E27 warm white, pack of 4' },
  { sku: 'NF-CBL-USBC-2M', title: 'USB-C cable 2 m, braided' },
  { sku: 'HB-JAR-1L-SET3', title: 'Glass storage jars 1 L, set of 3' },
  { sku: 'HB-BRD-OAK-L', title: 'Oak chopping board, large' },
  { sku: 'NF-PLG-UK-2USB', title: 'UK plug adaptor with 2 USB ports' },
  { sku: 'KH-CSH-45-OL', title: 'Cushion cover 45 cm, olive' },
  { sku: 'HB-KNF-SET-5', title: 'Kitchen knife set, 5 pieces' },
  { sku: 'NF-BAT-AA-12', title: 'AA batteries, pack of 12' },
];

const FIRST: Record<string, string[]> = {
  A: ['Amira', 'Alex'],
  B: ['Bethan', 'Ben'],
  C: ['Callum', 'Chloe'],
  D: ['Dev', 'Darcy'],
  E: ['Elin', 'Ethan'],
  F: ['Freya', 'Finn'],
  G: ['Grace', 'Gareth'],
  H: ['Hana', 'Harvey'],
  J: ['Jodie', 'Jamal'],
  K: ['Kiran', 'Keira'],
  L: ['Lewis', 'Leah'],
  M: ['Maya', 'Morgan'],
  N: ['Niamh', 'Noah'],
  P: ['Priya', 'Patrick'],
  R: ['Rhys', 'Rosa'],
  S: ['Sana', 'Struan'],
  T: ['Tegan', 'Tomasz'],
  W: ['Wren', 'Wesley'],
};
const LAST: Record<string, string[]> = {
  A: ['Ashworth'],
  B: ['Bramley'],
  C: ['Calder'],
  D: ['Dunmore'],
  E: ['Elwood'],
  F: ['Fairley'],
  G: ['Garside'],
  H: ['Holloway'],
  J: ['Jessop'],
  K: ['Kilbride'],
  L: ['Lindqvist'],
  M: ['Marsden'],
  N: ['Northcott'],
  P: ['Pemberton'],
  R: ['Rowntree'],
  S: ['Sherwood'],
  T: ['Thackeray'],
  W: ['Whitlock'],
};
const STREETS = [
  'Mill Lane',
  'Station Road',
  'Orchard Close',
  'Victoria Terrace',
  'Church Walk',
  'Park View',
];
const TOWNS: Record<string, string> = {
  G: 'Glasgow',
  M: 'Manchester',
  LS: 'Leeds',
  BS: 'Bristol',
  CF: 'Cardiff',
  EH: 'Edinburgh',
  B: 'Birmingham',
  NE: 'Newcastle upon Tyne',
  SW: 'London',
  N: 'London',
  PL: 'Plymouth',
  OX: 'Oxford',
  L: 'Liverpool',
  S: 'Sheffield',
};

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function orderDetail(o: OrderRow): OrderDetail {
  const r = seeded(o.id);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)] as T;

  // Rebuild the money the list row was generated from.
  const unit =
    UNITS.find((u) => u * o.itemCount + (u < 1500 ? 299 : 0) === o.totalPence) ?? o.totalPence;
  const shippingPence = unit < 1500 ? 299 : 0;
  const itemsGross = o.totalPence - shippingPence;

  const lines: OrderLine[] = [];
  let left = o.itemCount;
  const distinct = o.itemCount > 1 && r() < 0.5 ? 2 : 1;
  for (let i = 0; i < distinct; i++) {
    const qty = i === distinct - 1 ? left : 1;
    left -= qty;
    const p = PRODUCTS[(Math.floor(r() * PRODUCTS.length) + i) % PRODUCTS.length] ?? {
      sku: 'UNKNOWN',
      title: 'Unknown item',
    };
    lines.push({
      sku: p.sku,
      externalSku:
        o.channel === 'amazon'
          ? `B0${Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(r() * 34)]).join('')}`
          : p.sku,
      title: p.title,
      qty,
      unitPence: unit,
      vatRate: 20,
      mapped: !(o.flags.includes('unmapped') && i === 0),
    });
  }

  const vatPence = Math.round(o.totalPence / 6); // 20% VAT included in gross (mock)
  const feePence =
    o.channel === 'website' ? Math.round(itemsGross * 0.019) + 20 : Math.round(itemsGross * 0.153);
  const labelPence = o.shipping
    ? o.shipping.carrier === 'DPD'
      ? 595
      : o.shipping.service === 'Next Day'
        ? 385
        : 285
    : 0;
  const cogsPence = Math.round(itemsGross * 0.34);
  const refundPence =
    o.status === 'refunded'
      ? o.totalPence
      : o.status === 'partly_refunded'
        ? Math.round(o.totalPence * 0.3)
        : 0;

  const [ini, sur] = [o.shipToMasked[0] ?? 'A', o.shipToMasked[3] ?? 'B'];
  const area = o.shipToMasked.split(', ')[1] ?? 'G2';
  const areaLetters = area.replace(/\d+/g, '');
  const postcode = `${area} ${String(Math.floor(r() * 9) + 1)}${pick(['AB', 'DF', 'HJ', 'LN', 'PQ', 'RT', 'WX'])}`;

  const placed = Date.parse(o.placedAt);
  const account = channelAccounts.find((a) => a.id === o.channelAccountId);
  const chan =
    account?.channel === 'amazon' ? 'Amazon' : account?.channel === 'ebay' ? 'eBay' : 'Website';
  const history: OrderEvent[] = [{ at: iso(placed), label: 'Order placed', by: chan }];
  if (o.status !== 'pending_payment')
    history.push({ at: iso(placed + 2 * MIN), label: 'Payment confirmed', by: chan });
  const reached = (s: OrderRow['status'][]) => s.includes(o.status);
  let t = placed + (3 + Math.floor(r() * 18)) * 60 * MIN;
  if (
    reached(['label_created', 'dispatched', 'delivered', 'partly_refunded', 'returned']) &&
    !o.flags.includes('fba')
  ) {
    history.push({
      at: iso(t),
      label: `Label created (${o.shipping?.carrier ?? 'Evri'} ${o.shipping?.service ?? ''})`.trim(),
      by: 'Sam Admin',
    });
  }
  if (reached(['dispatched', 'delivered', 'partly_refunded', 'returned'])) {
    t += 4 * MIN;
    history.push({
      at: iso(t),
      label: 'Dispatched',
      by: o.flags.includes('fba') ? 'Amazon FBA' : 'OmniBridge',
    });
    if (o.tracking === 'pushed' || o.tracking === 'confirmed' || o.tracking === 'not_confirmed') {
      history.push({ at: iso(t + MIN), label: `Tracking sent to ${chan}`, by: 'OmniBridge' });
    }
    if (o.tracking === 'confirmed')
      history.push({ at: iso(t + 9 * MIN), label: `${chan} confirmed tracking`, by: chan });
  }
  if (reached(['delivered', 'returned'])) {
    t += 30 * 60 * MIN;
    history.push({ at: iso(t), label: 'Delivered', by: o.shipping?.carrier ?? 'Carrier' });
  }
  if (o.status === 'cancelled')
    history.push({ at: iso(placed + 50 * MIN), label: 'Cancelled by buyer', by: chan });
  if (o.status === 'returned')
    history.push({
      at: iso(t + 3 * 24 * 60 * MIN),
      label: 'Returned to sender',
      by: o.shipping?.carrier ?? 'Carrier',
    });
  if (refundPence)
    history.push({
      at: iso(t + 4 * 24 * 60 * MIN),
      label: o.status === 'refunded' ? 'Refunded in full' : 'Partly refunded',
      by: chan,
    });

  const trackingNumber =
    o.shipping && !o.flags.includes('fba')
      ? o.shipping.carrier === 'DPD'
        ? String(Math.floor(r() * 9e13) + 1e13)
        : `H0${Math.floor(r() * 1e14)
            .toString(36)
            .toUpperCase()
            .padStart(14, '0')}`
      : null;

  return {
    order: o,
    channelAccountName: account?.name ?? '',
    lines,
    money: {
      itemsGross,
      shippingPence,
      discountPence: 0,
      totalPence: o.totalPence,
      vatPence,
      feePence,
      labelPence,
      cogsPence,
      refundPence,
      // Synthetic: the website's refunded orders show every reason the page can give.
      amountsDiffer:
        o.channel === 'website' && o.status === 'refunded'
          ? ['channel_total', 'late_change', 'refund_above']
          : [],
    },
    dispatchedAt: history.find((h) => h.label === 'Dispatched')?.at ?? null,
    // Only the website leaves the dispatch time out.
    dispatchEstimated: o.channel === 'website',
    history: history.sort((a, b) => a.at.localeCompare(b.at)),
    label:
      o.shipping && trackingNumber
        ? {
            carrier: o.shipping.carrier,
            service: o.shipping.service,
            trackingNumber,
            createdAt: history.find((h) => h.label.startsWith('Label'))?.at ?? o.placedAt,
          }
        : null,
    notes:
      r() < 0.25
        ? [
            {
              at: iso(placed + 40 * MIN),
              by: 'Sam Admin',
              text: pick([
                'Checked stock on the shelf before packing.',
                'Gift order, leave the invoice out of the parcel.',
                'Second parcel follows once the restock arrives.',
              ]),
            },
          ]
        : [],
    buyer: scenarioBuyer(o.id) ?? {
      name: `${pick(FIRST[ini] ?? ['Alex'])} ${pick(LAST[sur] ?? ['Bramley'])}`,
      lines: [`${String(Math.floor(r() * 120) + 1)} ${pick(STREETS)}`],
      town: TOWNS[areaLetters] ?? 'London',
      postcode,
      country: 'United Kingdom',
      phone: `07700 900${String(Math.floor(r() * 1000)).padStart(3, '0')}`,
    },
    sameBuyer: [],
  };
}

/** A same-buyer scenario order shows the buyer the grouping matched on (C3). */
function scenarioBuyer(id: string): OrderDetail['buyer'] | undefined {
  const b = SCENARIO_BUYERS.get(id);
  if (!b) return undefined;
  return {
    name: b.name,
    lines: b.lines,
    town: b.town,
    postcode: b.postcode,
    country: 'United Kingdom',
    phone: b.phone,
  };
}

/** The SKU lines of a list row (C2): code, quantity and whether it is mapped. No buyer data. */
const skuCache = new Map<string, OrderSkuLine[]>();

export function orderSkus(o: OrderRow): OrderSkuLine[] {
  const hit = skuCache.get(o.id);
  if (hit) return hit;
  const lines = orderDetail(o).lines.map((l) => ({
    sku: l.mapped ? l.sku : l.externalSku,
    qty: l.qty,
    mapped: l.mapped,
  }));
  skuCache.set(o.id, lines);
  return lines;
}
