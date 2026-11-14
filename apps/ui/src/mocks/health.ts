/**
 * Account health for the client preview (T-0305). PROPOSED SHAPE (mock only), HLT-1..5.
 * Amazon and eBay are separate routes and separate shapes, so no screen can put their metrics
 * side by side (HLT-3). Only permitted companies' accounts are returned.
 */
import { channelAccounts } from './data.ts';
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
}

export interface AmazonHealth {
  channelAccountId: string;
  accountStatus: 'normal' | 'at_risk' | 'deactivated';
  rating: { score: number; band: Band } | null;
  metrics: AmazonMetric[];
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

const AMAZON: Record<string, AmazonHealth> = {
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
  return permitted(allowed, company).flatMap((a) => {
    const h = AMAZON[a.id];
    return h ? [h] : [];
  });
}

export function ebayHealth(allowed: Set<string>, company: string | null): EbayHealth[] {
  return permitted(allowed, company).flatMap((a) => {
    const h = EBAY[a.id];
    return h ? [h] : [];
  });
}
