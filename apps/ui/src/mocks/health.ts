/**
 * Account health for the client preview (T-0305). PROPOSED SHAPE (mock only), HLT-1..5.
 * Amazon and eBay are separate routes and separate shapes, so no screen can put their metrics
 * side by side (HLT-3). Only permitted companies' accounts are returned.
 */
import { channelAccounts, orders } from './data.ts';
import { HOUR, ago } from './random.ts';

export type Band = 'good' | 'at_risk' | 'critical';

export interface AmazonMetric {
  key: string;
  label: string;
  /** Display value, for example "0.42%" or "2". */
  value: string;
  target: string;
  period: string;
  band: Band;
  /** HLT-7 (SHOULD): when an amber or red metric recovers on its own. An Estimate, Amazon only. */
  recovery?: string;
}

/** HLT-6: seller feedback from the daily report. The rater email is dropped at parse time. */
export interface AmazonFeedback {
  average12m: number;
  count12m: number;
  breakdown: Array<{ period: string; positive: number; neutral: number; negative: number }>;
  recent: Array<{
    stars: number;
    at: string;
    comment: string;
    order: { id: string; ref: string };
  }>;
  updatedAt: string;
}

export interface AmazonHealth {
  channelAccountId: string;
  accountStatus: 'normal' | 'at_risk' | 'deactivated';
  rating: { score: number; band: Band } | null;
  metrics: AmazonMetric[];
  feedback: AmazonFeedback;
  updatedAt: string;
}

export interface EbayMetric {
  key: string;
  label: string;
  current: string;
  projected: string;
  threshold: string;
  currentBand: Band;
  projectedBand: Band;
}

export interface EbayHealth {
  channelAccountId: string;
  sellerLevel: { current: string; projected: string };
  evaluation: { next: string; window: string };
  metrics: EbayMetric[];
  updatedAt: string;
}

const AMAZON: Record<string, Omit<AmazonHealth, 'feedback'>> = {
  ca_1: {
    channelAccountId: 'ca_1',
    accountStatus: 'normal',
    rating: { score: 236, band: 'good' },
    updatedAt: ago(3 * HOUR),
    metrics: [
      m('odr', 'Order Defect Rate', '0.38%', 'under 1%', 'Last 60 days', 'good'),
      m('lsr', 'Late Shipment Rate', '1.9%', 'under 4%', 'Last 30 days', 'good'),
      m('cr', 'Pre-fulfilment Cancel Rate', '0.6%', 'under 2.5%', 'Last 7 days', 'good'),
      m('vtr', 'Valid Tracking Rate', '97.4%', 'over 95%', 'Last 30 days', 'good'),
      m('policy', 'Policy violations', '0', 'none open', 'Open now', 'good'),
    ],
  },
  ca_3: {
    channelAccountId: 'ca_3',
    accountStatus: 'normal',
    rating: { score: 184, band: 'at_risk' },
    updatedAt: ago(5 * HOUR),
    metrics: [
      m('odr', 'Order Defect Rate', '0.71%', 'under 1%', 'Last 60 days', 'good'),
      m('lsr', 'Late Shipment Rate', '3.6%', 'under 4%', 'Last 30 days', 'at_risk'),
      m('cr', 'Pre-fulfilment Cancel Rate', '0.4%', 'under 2.5%', 'Last 7 days', 'good'),
      m('vtr', 'Valid Tracking Rate', '93.8%', 'over 95%', 'Last 30 days', 'critical'),
      m('policy', 'Policy violations', '1', 'none open', 'Open now', 'at_risk'),
    ],
  },
};

const DAY = 86_400_000;
const inDays = (n: number) =>
  new Date(Date.now() + n * DAY).toLocaleDateString('en-GB', { timeZone: 'Europe/London' });

// HLT-7 lines for the amber and red metrics (from OmniBridge's own merchant-fulfilled orders).
const RECOVERY: Record<string, Record<string, string>> = {
  ca_3: {
    lsr: `3 late shipments leave the 30-day window by ${inDays(2)}. With no new late shipments, Late Shipment Rate falls under 4% on ${inDays(2)}.`,
    vtr: `11 orders without valid tracking leave the 30-day window by ${inDays(9)}. With valid tracking on every new order, Valid Tracking Rate passes 95% on ${inDays(9)}.`,
  },
};

const COMMENTS: Array<[number, string]> = [
  [5, 'Arrived the next day and very well packed.'],
  [5, 'Exactly as described, thank you.'],
  [4, 'Good product, delivery took a little longer than expected.'],
  [2, 'Box was damaged and one jar was chipped.'],
  [5, 'Lovely quality, will order again.'],
  [3, 'Fine, but smaller than the photo suggests.'],
];

function feedbackFor(accountId: string, seed: number): AmazonFeedback {
  const own = orders.filter((o) => o.channelAccountId === accountId).slice(0, 12);
  const scale = seed === 0 ? 1 : 0.55;
  const row = (period: string, total: number, neutralPct: number, negativePct: number) => {
    const negative = Math.round(total * negativePct);
    const neutral = Math.round(total * neutralPct);
    return { period, positive: total - neutral - negative, neutral, negative };
  };
  return {
    average12m: seed === 0 ? 4.8 : 4.4,
    count12m: Math.round(214 * scale),
    breakdown: [
      row('30 days', Math.round(23 * scale), 0.04, seed === 0 ? 0.04 : 0.09),
      row('90 days', Math.round(61 * scale), 0.05, seed === 0 ? 0.03 : 0.07),
      row('12 months', Math.round(214 * scale), 0.04, seed === 0 ? 0.02 : 0.06),
    ],
    recent: COMMENTS.slice(seed, seed + 5).map(([stars, comment], i) => {
      const o = own[i] ?? own[0];
      return {
        stars,
        comment,
        at: new Date(Date.now() - (i * 1.7 + 0.4) * DAY).toISOString(),
        order: { id: o?.id ?? '', ref: o?.ref ?? '' },
      };
    }),
    updatedAt: ago(7 * HOUR),
  };
}

function m(
  key: string,
  label: string,
  value: string,
  target: string,
  period: string,
  band: Band,
): AmazonMetric {
  return { key, label, value, target, period, band };
}

const EBAY: Record<string, EbayHealth> = {
  ca_2: {
    channelAccountId: 'ca_2',
    sellerLevel: { current: 'Top Rated', projected: 'Top Rated' },
    evaluation: {
      next: '2026-11-20T12:00:00Z',
      window: 'Last 12 months (under 400 sales: 3 months)',
    },
    updatedAt: ago(2 * HOUR),
    metrics: [
      e(
        'tdr',
        'Transaction defect rate',
        '0.21%',
        '0.24%',
        'Top Rated: 0.5% or less',
        'good',
        'good',
      ),
      e(
        'cases',
        'Cases closed without seller resolution',
        '0',
        '1',
        'Top Rated: 0.3% (max 2)',
        'good',
        'good',
      ),
      e('late', 'Late delivery rate', '2.4%', '2.9%', 'Top Rated: 3% or less', 'good', 'at_risk'),
    ],
  },
  ca_5: {
    channelAccountId: 'ca_5',
    sellerLevel: { current: 'Above standard', projected: 'Above standard' },
    evaluation: { next: '2026-11-20T12:00:00Z', window: 'Last 3 months' },
    updatedAt: ago(26 * HOUR),
    metrics: [
      e(
        'tdr',
        'Transaction defect rate',
        '0.9%',
        '1.1%',
        'Above standard: 2% or less',
        'good',
        'good',
      ),
      e(
        'cases',
        'Cases closed without seller resolution',
        '1',
        '1',
        'Above standard: 0.3% (max 2)',
        'at_risk',
        'at_risk',
      ),
      e(
        'late',
        'Late delivery rate',
        '5.1%',
        '4.6%',
        'Top Rated: 3% or less',
        'at_risk',
        'at_risk',
      ),
    ],
  },
};

function e(
  key: string,
  label: string,
  current: string,
  projected: string,
  threshold: string,
  currentBand: Band,
  projectedBand: Band,
): EbayMetric {
  return { key, label, current, projected, threshold, currentBand, projectedBand };
}

const permitted = (allowed: Set<string>, company: string | null) =>
  channelAccounts.filter(
    (a) => allowed.has(a.companyId) && (!company || company === 'all' || a.companyId === company),
  );

export function amazonHealth(allowed: Set<string>, company: string | null): AmazonHealth[] {
  return permitted(allowed, company).flatMap((a, i) => {
    const h = AMAZON[a.id];
    if (!h) return [];
    return [
      {
        ...h,
        metrics: h.metrics.map((x) => {
          const recovery = x.band === 'good' ? undefined : RECOVERY[a.id]?.[x.key];
          return recovery ? { ...x, recovery } : x;
        }),
        feedback: feedbackFor(a.id, a.id === 'ca_1' ? 0 : i),
      },
    ];
  });
}

export function ebayHealth(allowed: Set<string>, company: string | null): EbayHealth[] {
  return permitted(allowed, company).flatMap((a) => {
    const h = EBAY[a.id];
    return h ? [h] : [];
  });
}
