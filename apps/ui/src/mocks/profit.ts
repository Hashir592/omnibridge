/**
 * Sales & Profit dashboard for the client preview (T-0305). PROPOSED SHAPE (mock only), PRF-1..5.
 * Daily figures per channel account are derived from a seed, so every period adds up. Only the
 * user's permitted companies are summed (invariant 4).
 */
import { channelAccounts, companies } from './data.ts';
import { DAY, rng } from './random.ts';
import { skus } from './stock.ts';
import type { Channel } from './types.ts';

export type ProfitPeriod =
  'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last_month' | 'quarter';
export type ProfitCompare = 'previous' | 'last_year';
export type ProfitBreakdown = 'company' | 'account' | 'sku' | 'cluster';

export interface ProfitFigures {
  orders: number;
  units: number;
  grossPence: number;
  refundsPence: number;
  outputVatPence: number;
  /** Channel fees net of reclaimable VAT. */
  feesPence: number;
  adSpendPence: number;
  cogsPence: number;
  labelPence: number;
  /** PRF-2: (gross − refunds) − output VAT − fees − ad spend − COGS − labels. */
  contributionPence: number;
}

export interface ProfitPoint {
  date: string; // UTC ISO of the London day
  grossPence: number;
  contributionPence: number;
  compareContributionPence: number;
}

export interface ProfitRow {
  id: string;
  name: string;
  sub: string;
  channel?: Channel;
  companyId?: string;
  figures: ProfitFigures;
  compareContributionPence: number;
}

export interface ProfitSummary {
  asOf: string;
  period: { from: string; to: string; days: number };
  compare: { from: string; to: string };
  current: ProfitFigures;
  previous: ProfitFigures;
  series: ProfitPoint[];
  breakdown: ProfitRow[];
  /** PRF-5: which figures rest on data that is not final yet. */
  signals: { feesProvisional: boolean; adSpendProvisional: boolean; skuAllocated: boolean };
}

const ZERO: ProfitFigures = {
  orders: 0,
  units: 0,
  grossPence: 0,
  refundsPence: 0,
  outputVatPence: 0,
  feesPence: 0,
  adSpendPence: 0,
  cogsPence: 0,
  labelPence: 0,
  contributionPence: 0,
};

const FEE_RATE: Record<Channel, number> = { amazon: 0.153, ebay: 0.128, website: 0.021 };
const BASE_ORDERS: Record<string, number> = { ca_1: 46, ca_2: 21, ca_3: 33, ca_4: 9, ca_5: 14 };

function accountDay(accountId: string, channel: Channel, daysAgo: number): ProfitFigures {
  const r = rng(Number(accountId.slice(3)) * 100_003 + daysAgo * 7919 + 13);
  const date = new Date(Date.now() - daysAgo * DAY);
  const weekday = date.getUTCDay();
  const season = 1 + 0.18 * Math.sin((daysAgo / 365) * 2 * Math.PI + 1.2) - daysAgo * 0.0004;
  const weekend = weekday === 0 || weekday === 6 ? 0.82 : 1.04;
  // Today is part way through (the dashboard fixes its "as of" time).
  const share = daysAgo === 0 ? Math.min(1, new Date().getUTCHours() / 24 + 0.05) : 1;
  const orders = Math.round(
    (BASE_ORDERS[accountId] ?? 10) * season * weekend * (0.85 + r.next() * 0.3) * share,
  );
  const units = Math.round(orders * (1.2 + r.next() * 0.25));
  const grossPence = orders * r.int(1650, 2950);
  const refundsPence = Math.round(grossPence * (0.015 + r.next() * 0.03));
  const outputVatPence = Math.round((grossPence - refundsPence) * 0.152);
  const feesPence = Math.round(grossPence * FEE_RATE[channel]);
  const adSpendPence =
    channel === 'amazon' ? Math.round(grossPence * (0.045 + r.next() * 0.03)) : 0;
  const cogsPence = Math.round(grossPence * (0.29 + r.next() * 0.05));
  const labelPence = Math.round(orders * (channel === 'amazon' ? 0.8 : 1) * r.int(265, 345));
  return finish({
    orders,
    units,
    grossPence,
    refundsPence,
    outputVatPence,
    feesPence,
    adSpendPence,
    cogsPence,
    labelPence,
    contributionPence: 0,
  });
}

function finish(f: ProfitFigures): ProfitFigures {
  return {
    ...f,
    contributionPence:
      f.grossPence -
      f.refundsPence -
      f.outputVatPence -
      f.feesPence -
      f.adSpendPence -
      f.cogsPence -
      f.labelPence,
  };
}

function add(a: ProfitFigures, b: ProfitFigures): ProfitFigures {
  const out = { ...a };
  for (const k of Object.keys(out) as Array<keyof ProfitFigures>) out[k] = a[k] + b[k];
  return out;
}

function scale(f: ProfitFigures, s: number): ProfitFigures {
  const out = { ...f };
  for (const k of Object.keys(out) as Array<keyof ProfitFigures>) out[k] = Math.round(f[k] * s);
  return finish(out);
}

const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' });

/** [first daysAgo, last daysAgo] of a period, newest first: today is 0. */
function range(period: ProfitPeriod): [number, number] {
  const today = new Date(`${londonDay.format(new Date())}T12:00:00Z`);
  const dom = today.getUTCDate();
  switch (period) {
    case 'today':
      return [0, 0];
    case 'yesterday':
      return [1, 1];
    case '7d':
      return [0, 6];
    case '30d':
      return [0, 29];
    case 'month':
      return [0, dom - 1];
    case 'last_month': {
      const lastDay = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0),
      ).getUTCDate();
      return [dom, dom + lastDay - 1];
    }
    case 'quarter': {
      const qStart = Date.UTC(
        today.getUTCFullYear(),
        Math.floor(today.getUTCMonth() / 3) * 3,
        1,
        12,
      );
      return [0, Math.round((today.getTime() - qStart) / DAY)];
    }
  }
}

const dayIso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

const CLUSTERS = [
  { id: 'cl_1', name: 'Amazon accounts', accounts: ['ca_1', 'ca_3'] },
  { id: 'cl_2', name: 'Marketplaces other than Amazon', accounts: ['ca_2', 'ca_5'] },
  { id: 'cl_3', name: 'Own website', accounts: ['ca_4'] },
];

export function profitSummary(allowed: Set<string>, p: URLSearchParams): ProfitSummary {
  const company = p.get('company');
  const period = (p.get('period') ?? '30d') as ProfitPeriod;
  const compare = (p.get('compare') ?? 'previous') as ProfitCompare;
  const by = (p.get('by') ?? 'company') as ProfitBreakdown;
  const accounts = channelAccounts.filter(
    (a) => allowed.has(a.companyId) && (!company || company === 'all' || a.companyId === company),
  );

  const [lo, hi] = range(period);
  const days = hi - lo + 1;
  const shift = compare === 'previous' ? days : 364;

  const sumAccount = (id: string, channel: Channel, from: number, to: number) => {
    let f = ZERO;
    for (let d = from; d <= to; d++) f = add(f, accountDay(id, channel, d));
    return finish(f);
  };

  const perAccount = accounts.map((a) => ({
    a,
    cur: sumAccount(a.id, a.channel, lo, hi),
    prev: sumAccount(a.id, a.channel, lo + shift, hi + shift),
  }));
  const current = perAccount.reduce((s, x) => add(s, x.cur), ZERO);
  const previous = perAccount.reduce((s, x) => add(s, x.prev), ZERO);

  // Chart: one point per day, or per hour-like slices are not needed; a single day shows one bar.
  const series: ProfitPoint[] = [];
  for (let d = hi; d >= lo; d--) {
    let cur = ZERO;
    let prev = ZERO;
    for (const a of accounts) {
      cur = add(cur, accountDay(a.id, a.channel, d));
      prev = add(prev, accountDay(a.id, a.channel, d + shift));
    }
    cur = finish(cur);
    prev = finish(prev);
    series.push({
      date: dayIso(d),
      grossPence: cur.grossPence,
      contributionPence: cur.contributionPence,
      compareContributionPence: prev.contributionPence,
    });
  }

  let breakdown: ProfitRow[];
  if (by === 'account') {
    breakdown = perAccount.map(({ a, cur, prev }) => ({
      id: a.id,
      name: a.name,
      sub: companies.find((c) => c.id === a.companyId)?.tradingName ?? '',
      channel: a.channel,
      companyId: a.companyId,
      figures: finish(cur),
      compareContributionPence: finish(prev).contributionPence,
    }));
  } else if (by === 'cluster') {
    breakdown = CLUSTERS.map((c) => {
      const inIt = perAccount.filter((x) => c.accounts.includes(x.a.id));
      return {
        id: c.id,
        name: c.name,
        sub: `${String(inIt.length)} channel account${inIt.length === 1 ? '' : 's'}`,
        figures: finish(inIt.reduce((s, x) => add(s, x.cur), ZERO)),
        compareContributionPence: finish(inIt.reduce((s, x) => add(s, x.prev), ZERO))
          .contributionPence,
      };
    }).filter((c) => c.figures.orders > 0);
  } else if (by === 'sku') {
    // SKU split: sales by SKU are exact; ad spend per SKU is an allocated estimate.
    const r = rng(lo * 31 + hi);
    const top = skus.filter((s) => !s.bundle).slice(0, 12);
    const weights = top.map(() => 0.5 + r.next());
    const total = weights.reduce((a, b) => a + b, 0) * 1.6;
    breakdown = top.map((s, i) => {
      const w = (weights[i] ?? 1) / total;
      return {
        id: s.id,
        name: s.sku,
        sub: s.title,
        figures: scale(current, w),
        compareContributionPence: Math.round(previous.contributionPence * w),
      };
    });
  } else {
    breakdown = companies
      .filter((c) => accounts.some((a) => a.companyId === c.id))
      .map((c) => {
        const inIt = perAccount.filter((x) => x.a.companyId === c.id);
        return {
          id: c.id,
          name: c.tradingName,
          sub: `${String(inIt.length)} channel account${inIt.length === 1 ? '' : 's'}`,
          companyId: c.id,
          figures: finish(inIt.reduce((s, x) => add(s, x.cur), ZERO)),
          compareContributionPence: finish(inIt.reduce((s, x) => add(s, x.prev), ZERO))
            .contributionPence,
        };
      });
  }

  return {
    asOf: new Date(Date.now() - 6 * 60_000).toISOString(),
    period: { from: dayIso(hi), to: dayIso(lo), days },
    compare: { from: dayIso(hi + shift), to: dayIso(lo + shift) },
    current: finish(current),
    previous: finish(previous),
    series,
    breakdown,
    signals: {
      // Amazon settles fees a few days late, and Ads reports land after about 2 days.
      feesProvisional: lo <= 3 && accounts.some((a) => a.channel === 'amazon'),
      adSpendProvisional: lo <= 1 && accounts.some((a) => a.channel === 'amazon'),
      skuAllocated: by === 'sku',
    },
  };
}
