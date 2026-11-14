/**
 * Advertising (Amazon Ads) for the client preview (T-0305). PROPOSED SHAPE (mock only), AD-1..6.
 * The module is behind a flag (it needs Amazon to approve the Ads app). Only companies with an
 * Ads profile have campaigns; all names are synthetic.
 */
import { DAY, HOUR, ago, rng } from './random.ts';

export type CampaignType = 'SP' | 'SB' | 'SD';

export interface Campaign {
  id: string;
  companyId: string;
  name: string;
  type: CampaignType;
  targeting: 'Auto' | 'Manual' | null;
  state: 'enabled' | 'paused' | 'archived';
  budgetPence: number;
  spendPence: number;
  salesPence: number;
  impressions: number;
  clicks: number;
  orders: number;
}

export interface AdRule {
  id: string;
  name: string;
  scope: string;
  condition: string;
  action: string;
  schedule: string;
  caps: string;
  enabled: boolean;
  lastRun: { at: string; changes: number } | null;
}

export interface SearchTermSuggestion {
  id: string;
  term: string;
  campaign: string;
  spendPence: number;
  clicks: number;
  orders: 0;
}

export interface AdsOverview {
  profiles: Array<{ companyId: string; name: string }>;
  days: number;
  provisionalDays: number;
  campaigns: Campaign[];
  rules: AdRule[];
  negatives: { minSpendPence: number; days: number; items: SearchTermSuggestion[] };
}

const r = rng(4_7);
const NAMES = [
  'Kitchen storage',
  'Tea and coffee',
  'Chopping boards',
  'Garden pots',
  'Gift ideas',
  'Brand defence',
  'Towels and linen',
  'Bathroom hooks',
  'Clearance',
  'New lines Q4',
  'Competitor targets',
  'Seasonal: Christmas',
];

const CAMPAIGNS: Campaign[] = NAMES.map((name, i) => {
  const type: CampaignType = i % 5 === 3 ? 'SB' : i % 7 === 4 ? 'SD' : 'SP';
  const clicks = r.int(80, 1400);
  const spendPence = clicks * r.int(28, 95);
  const orders = Math.round(clicks * (0.04 + r.next() * 0.09));
  return {
    id: `cmp_${String(i)}`,
    companyId: 'co_1',
    name: `${type} · ${name}`,
    type,
    targeting: type === 'SP' ? (i % 3 === 0 ? 'Auto' : 'Manual') : null,
    state: i === 8 ? 'paused' : i === 11 ? 'archived' : 'enabled',
    budgetPence: r.pick([1_000, 1_500, 2_500, 4_000, 6_000]),
    spendPence,
    salesPence: orders * r.int(1_600, 3_200),
    impressions: clicks * r.int(60, 220),
    clicks,
    orders,
  };
});

const RULES: AdRule[] = [
  {
    id: 'rule_1',
    name: 'Cut bids on expensive keywords',
    scope: 'Keywords in 8 SP campaigns',
    condition: 'ACOS above 40% and at least 20 clicks over 14 days',
    action: 'Lower the bid by 15%',
    schedule: 'Daily at 06:00',
    caps: 'At most 25% change per run; bid between £0.20 and £2.50',
    enabled: true,
    lastRun: { at: ago(4 * HOUR), changes: 17 },
  },
  {
    id: 'rule_2',
    name: 'Pause keywords with no sales',
    scope: 'Keywords in all SP campaigns',
    condition: 'Spend at least £15 and 0 orders over 30 days',
    action: 'Pause',
    schedule: 'Mondays at 07:00',
    caps: 'At most 10 keywords per run',
    enabled: true,
    lastRun: { at: ago(2 * DAY), changes: 4 },
  },
  {
    id: 'rule_3',
    name: 'Weekend budget boost',
    scope: 'Campaign SP · Gift ideas',
    condition: 'Every Saturday and Sunday',
    action: 'Set daily budget to £40.00',
    schedule: 'Day-of-week budget schedule',
    caps: 'Budget between £15.00 and £40.00',
    enabled: false,
    lastRun: null,
  },
];

const TERMS = [
  'wooden board cheap',
  'free chopping board',
  'tea set for kids toy',
  'plant pot plastic bulk',
  'copper mug vintage antique',
  'linen tablecloth round 3m',
  'oak shelf bracket heavy duty',
];

const NEGATIVES: SearchTermSuggestion[] = TERMS.map((term, i) => ({
  id: `st_${String(i)}`,
  term,
  campaign: CAMPAIGNS[i % 6]?.name ?? '',
  spendPence: r.int(1_000, 4_800),
  clicks: r.int(12, 60),
  orders: 0,
}));

export function adsOverview(allowed: Set<string>, p: URLSearchParams): AdsOverview {
  const company = p.get('company');
  const days = Number(p.get('days') ?? 30) || 30;
  const ok = (id: string) => allowed.has(id) && (!company || company === 'all' || company === id);
  const scale = days / 30;
  return {
    profiles: ok('co_1') ? [{ companyId: 'co_1', name: 'Amazon Ads · Northfield' }] : [],
    days,
    provisionalDays: 14,
    campaigns: CAMPAIGNS.filter((c) => ok(c.companyId)).map((c) => ({
      ...c,
      spendPence: Math.round(c.spendPence * scale),
      salesPence: Math.round(c.salesPence * scale),
      impressions: Math.round(c.impressions * scale),
      clicks: Math.round(c.clicks * scale),
      orders: Math.round(c.orders * scale),
    })),
    rules: ok('co_1') ? RULES : [],
    negatives: { minSpendPence: 1_000, days: 30, items: ok('co_1') ? NEGATIVES : [] },
  };
}
