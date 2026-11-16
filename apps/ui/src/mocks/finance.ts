/**
 * Finance for the client preview (T-0305). PROPOSED SHAPE (mock only): VAT quarters and
 * settlement (VQ-1..4), expenses (EXP-1..7) and the P&L (PL-1..4). Synthetic suppliers only.
 * Every list is limited to the user's permitted companies (invariant 4).
 */
import { channelAccounts, companies } from './data.ts';
import { channelOn } from './session.ts';
import { DAY, ago, rng } from './random.ts';

export type Stagger = 1 | 2 | 3 | 'monthly';

export interface VatLines {
  output20: number;
  output5: number;
  net0: number;
  netNoVat: number;
  refundVat: number;
  icOutput: number;
  rcOutput: number;
  payable: number;
  inputExpenses: number;
  inputFees: number;
  icInput: number;
  rcInput: number;
  claimable: number;
  settlement: number;
}

export interface VatPeriod {
  id: string;
  label: string;
  from: string;
  to: string;
  dueBy: string;
  status: 'in_progress' | 'open' | 'filed';
  filed: { at: string; by: string } | null;
  lines: VatLines;
  byAccount: Array<{
    channelAccountId: string;
    netSalesPence: number;
    outputVatPence: number;
    refundVatPence: number;
    feeInputVatPence: number;
  }>;
}

export interface VatCompany {
  companyId: string;
  stagger: Stagger;
  /** VQ-1: false until an admin confirms the stagger from the company's HMRC VAT account. */
  staggerConfirmed: boolean;
  vatNumber: string;
  periods: VatPeriod[];
}

export type ExpenseStatus = 'paid' | 'unpaid';

export interface Expense {
  id: string;
  companyId: string;
  supplier: string;
  category: string;
  invoiceDate: string;
  dueDate: string | null;
  invoiceNo: string | null;
  netPence: number;
  vatRate: number;
  vatPence: number;
  grossPence: number;
  status: ExpenseStatus;
  paidAt: string | null;
  attachments: number;
}

export interface ExpensePage {
  items: Expense[];
  total: number;
  totals: { unpaidPence: number; overdue: number; overduePence: number };
}

export interface PnlLine {
  key: string;
  label: string;
  current: number;
  previous: number;
}

export interface Pnl {
  basis: 'cogs';
  period: { label: string; compareLabel: string };
  combined: boolean;
  income: PnlLine[];
  costOfSales: PnlLine[];
  overheads: PnlLine[];
  /** PL-3: intercompany amounts removed from a combined P&L. */
  intercompanyRemovedPence: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function vatLines(seed: number, scale: number): VatLines {
  const r = rng(seed);
  const output20 = Math.round(r.int(1_400_000, 2_100_000) * scale);
  const output5 = Math.round(r.int(20_000, 60_000) * scale);
  const net0 = Math.round(r.int(180_000, 420_000) * scale);
  const netNoVat = Math.round(r.int(10_000, 60_000) * scale);
  const refundVat = Math.round(output20 * (0.02 + r.next() * 0.015));
  const icOutput = r.chance(0.5) ? Math.round(r.int(20_000, 90_000) * scale) : 0;
  const rcOutput = Math.round(r.int(8_000, 26_000) * scale);
  const payable = output20 + output5 - refundVat + icOutput + rcOutput;
  const inputExpenses = Math.round(r.int(380_000, 720_000) * scale);
  const inputFees = Math.round(output20 * (0.17 + r.next() * 0.04));
  const icInput = r.chance(0.5) ? Math.round(r.int(10_000, 60_000) * scale) : 0;
  const rcInput = rcOutput;
  const claimable = inputExpenses + inputFees + icInput + rcInput;
  return {
    output20,
    output5,
    net0,
    netNoVat,
    refundVat,
    icOutput,
    rcOutput,
    payable,
    inputExpenses,
    inputFees,
    icInput,
    rcInput,
    claimable,
    settlement: payable - claimable,
  };
}

function vatCompany(companyId: string, index: number): VatCompany {
  const now = new Date();
  const y = now.getUTCFullYear();
  const qEndMonth = Math.floor(now.getUTCMonth() / 3) * 3 + 2; // stagger 1 quarter end (0-based)
  const periods: VatPeriod[] = [];
  for (let k = 0; k < 4; k++) {
    const endMonth = qEndMonth - k * 3;
    const end = new Date(Date.UTC(y, endMonth + 1, 0, 12));
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1, 12));
    const due = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 2, 7, 12));
    const status: VatPeriod['status'] = k === 0 ? 'in_progress' : k === 1 ? 'open' : 'filed';
    const scale = k === 0 ? (now.getUTCDate() + 1) / 92 : 1;
    const lines = vatLines(index * 101 + k * 7 + 3, (1 - index * 0.25) * scale);
    const accts = channelAccounts.filter((a) => a.companyId === companyId && channelOn(a.channel));
    const weights = accts.map((_, i) => 1 / (i + 1));
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;
    periods.push({
      id: `${companyId}_q${String(k)}`,
      label: `${MONTHS[start.getUTCMonth()] ?? ''} to ${MONTHS[end.getUTCMonth()] ?? ''} ${String(end.getUTCFullYear())}`,
      from: start.toISOString(),
      to: end.toISOString(),
      dueBy: due.toISOString(),
      status,
      filed:
        status === 'filed'
          ? { at: new Date(due.getTime() - 9 * DAY).toISOString(), by: 'Sam Admin' }
          : null,
      lines,
      byAccount: accts.map((a, i) => {
        const w = (weights[i] ?? 0) / wsum;
        return {
          channelAccountId: a.id,
          netSalesPence: Math.round((lines.output20 / 0.2 + lines.net0) * w),
          outputVatPence: Math.round((lines.output20 + lines.output5) * w),
          refundVatPence: Math.round(lines.refundVat * w),
          feeInputVatPence: Math.round(lines.inputFees * w),
        };
      }),
    });
  }
  return {
    companyId,
    stagger: 1,
    staggerConfirmed: index === 0,
    vatNumber: `GB ${String(100 + index * 37)} ${String(4000 + index * 911)} ${String(10 + index * 3)}`,
    periods,
  };
}

const VAT = companies.map((c, i) => vatCompany(c.id, i));

export function vatFor(allowed: Set<string>, companyId: string): VatCompany | null {
  if (!allowed.has(companyId)) return null;
  return VAT.find((v) => v.companyId === companyId) ?? null;
}

/* ---------- expenses ---------- */

const SUPPLIERS: Array<[string, string, number]> = [
  ['Brightwell Ltd', 'Stock purchases', 20],
  ['Calder & Finch', 'Stock purchases', 20],
  ['Otterly Imports', 'Stock purchases', 0],
  ['Unit 4 Lettings', 'Rent', 20],
  ['Northgrid Energy', 'Utilities', 5],
  ['BoxRight Packaging', 'Packaging & consumables', 20],
  ['Parcel Hub Supplies', 'Postage & carriage', 20],
  ['Ledgerly', 'Software & subscriptions', 20],
  ['Shelfware Cloud', 'Software & subscriptions', 20],
  ['Ashby & Co Accountants', 'Professional fees', 20],
  ['City Print Shop', 'Other', 20],
];

export const EXPENSE_CATEGORIES = [
  'Stock purchases',
  'Rent',
  'Utilities',
  'Packaging & consumables',
  'Postage & carriage',
  'Software & subscriptions',
  'Professional fees',
  'Other',
];

const er = rng(5_2026);
const EXPENSES: Expense[] = Array.from({ length: 142 }, (_, i) => {
  const [supplier, category, rate] = er.pick(SUPPLIERS);
  const daysAgo = Math.floor((i / 142) * 120) + er.int(0, 2);
  const invoiceDate = ago(daysAgo * DAY + er.int(1, 10) * 3_600_000);
  const due =
    category === 'Rent' || er.chance(0.7)
      ? new Date(Date.parse(invoiceDate) + 30 * DAY).toISOString()
      : null;
  const netPence =
    category === 'Stock purchases'
      ? er.int(40_000, 680_000)
      : category === 'Rent'
        ? 185_000
        : er.int(1_500, 48_000);
  const vatPence = Math.round((netPence * rate) / 100);
  const paid = daysAgo > 35 ? !er.chance(0.04) : er.chance(0.45);
  // EXP-4: stock and overheads go to the purchasing company by default.
  const companyId = er.chance(0.7) ? 'co_1' : er.pick(companies).id;
  return {
    id: `exp_${String(i)}`,
    companyId,
    supplier,
    category,
    invoiceDate,
    dueDate: due,
    invoiceNo: er.chance(0.9) ? `INV-${String(er.int(10_000, 99_999))}` : null,
    netPence,
    vatRate: rate,
    vatPence,
    grossPence: netPence + vatPence,
    status: paid ? 'paid' : 'unpaid',
    paidAt: paid
      ? new Date(
          Math.min(Date.now() - 3_600_000, Date.parse(invoiceDate) + er.int(2, 28) * DAY),
        ).toISOString()
      : null,
    attachments: er.chance(0.85) ? 1 : 0,
  };
});

const isOverdue = (e: Expense, now: number) =>
  e.status === 'unpaid' && e.dueDate !== null && Date.parse(e.dueDate) < now;

export function expensePage(allowed: Set<string>, p: URLSearchParams): ExpensePage {
  const now = Date.now();
  const company = p.get('company');
  const q = (p.get('q') ?? '').trim().toLowerCase();
  const status = (p.get('status') ?? '').split(',').filter(Boolean);
  const category = (p.get('category') ?? '').split(',').filter(Boolean);
  const base = EXPENSES.filter(
    (e) => allowed.has(e.companyId) && (!company || company === 'all' || e.companyId === company),
  );
  const items = base.filter((e) => {
    if (
      q &&
      !e.supplier.toLowerCase().includes(q) &&
      !(e.invoiceNo ?? '').toLowerCase().includes(q)
    )
      return false;
    if (category.length && !category.includes(e.category)) return false;
    if (status.length) {
      const s = isOverdue(e, now) ? 'overdue' : e.status;
      if (!status.includes(s) && !(status.includes('unpaid') && s === 'overdue')) return false;
    }
    return true;
  });
  const limit = [20, 50, 100].includes(Number(p.get('limit'))) ? Number(p.get('limit')) : 50;
  const cursor = Number(p.get('cursor') ?? 0);
  const unpaid = base.filter((e) => e.status === 'unpaid');
  const overdue = unpaid.filter((e) => isOverdue(e, now));
  return {
    items: items.slice(cursor, cursor + limit),
    total: items.length,
    totals: {
      unpaidPence: unpaid.reduce((s, e) => s + e.grossPence, 0),
      overdue: overdue.length,
      overduePence: overdue.reduce((s, e) => s + e.grossPence, 0),
    },
  };
}

/* ---------- P&L ---------- */

export type PnlRange = 'month' | 'quarter' | 'year';

/** "Jul to Sep 2026" for the calendar quarter `back` quarters before the current one. */
function quarterLabel(now: Date, back: number): string {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 - 3 * back, 1),
  );
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 2, 1));
  return `${MONTHS[start.getUTCMonth()] ?? ''} to ${MONTHS[end.getUTCMonth()] ?? ''} ${String(end.getUTCFullYear())}`;
}

/** "Nov 2025 to Oct 2026": the 12 complete months before now. */
function yearLabel(now: Date): string {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));
  return `${MONTHS[start.getUTCMonth()] ?? ''} ${String(start.getUTCFullYear())} to ${MONTHS[end.getUTCMonth()] ?? ''} ${String(end.getUTCFullYear())}`;
}

export function pnl(allowed: Set<string>, p: URLSearchParams): Pnl {
  const company = p.get('company');
  const range = (p.get('range') ?? 'month') as PnlRange;
  const list = companies.filter(
    (c) => allowed.has(c.id) && (!company || company === 'all' || c.id === company),
  );
  const combined = list.length > 1;
  const months = range === 'month' ? 1 : range === 'quarter' ? 3 : 12;
  const now = new Date();
  const m = now.getUTCMonth() - 1; // last complete month
  const label =
    range === 'month'
      ? `${MONTHS[(m + 12) % 12] ?? ''} ${String(now.getUTCFullYear())}`
      : range === 'quarter'
        ? quarterLabel(now, 1)
        : yearLabel(now);
  const compareLabel =
    range === 'month'
      ? (MONTHS[(m + 11) % 12] ?? '')
      : range === 'quarter'
        ? quarterLabel(now, 2)
        : 'Year before';

  const sum = (fn: (r: ReturnType<typeof rng>, idx: number) => number, prev: boolean) =>
    list.reduce((s, c) => {
      const idx = companies.indexOf(c);
      return s + fn(rng(idx * 997 + months * 13 + (prev ? 5 : 0)), idx) * months;
    }, 0);

  const line = (
    key: string,
    label: string,
    fn: (r: ReturnType<typeof rng>, idx: number) => number,
  ): PnlLine => ({
    key,
    label,
    current: sum(fn, false),
    previous: sum(fn, true),
  });

  const share = (idx: number) => 1 - idx * 0.28;
  const income: PnlLine[] = [
    line('sales_amazon', 'Net sales: Amazon', (r, i) =>
      Math.round(r.int(5_200_000, 6_100_000) * share(i)),
    ),
    line('sales_ebay', 'Net sales: eBay', (r, i) =>
      Math.round(r.int(1_700_000, 2_200_000) * share(i)),
    ),
    line('sales_web', 'Net sales: Website', (r, i) =>
      i === 1 && channelOn('website') ? r.int(420_000, 610_000) : 0,
    ),
    line('refunds', 'Less net refunds', (r, i) => -Math.round(r.int(140_000, 230_000) * share(i))),
    line('ic_income', 'Intercompany recharge income', (r, i) =>
      combined ? 0 : i === 0 ? r.int(80_000, 120_000) : 0,
    ),
  ].filter((l) => l.current !== 0 || l.previous !== 0);
  const costOfSales: PnlLine[] = [
    line('cogs', 'COGS (order-line snapshots)', (r, i) =>
      Math.round(r.int(2_300_000, 2_700_000) * share(i)),
    ),
    line('fees', 'Channel fees (net of reclaimable VAT)', (r, i) =>
      Math.round(r.int(1_050_000, 1_250_000) * share(i)),
    ),
    line('ads', 'Ad spend', (r, i) => Math.round(r.int(260_000, 380_000) * share(i))),
    line('labels', 'Label costs', (r, i) => Math.round(r.int(330_000, 410_000) * share(i))),
  ];
  const overheads: PnlLine[] = [
    line('rent', 'Rent', (_r, i) => (i === 0 ? 185_000 : 0)),
    line('utilities', 'Utilities', (r, i) => (i === 0 ? r.int(18_000, 26_000) : 0)),
    line('packaging', 'Packaging & consumables', (r, i) =>
      Math.round(r.int(60_000, 95_000) * share(i)),
    ),
    line('software', 'Software & subscriptions', (r) => r.int(9_000, 16_000)),
    line('professional', 'Professional fees', (r, i) => (i === 0 ? r.int(40_000, 60_000) : 0)),
    line('payroll', 'Payroll (total cost)', (r, i) => (i === 0 ? r.int(620_000, 660_000) : 0)),
    line('ic_expense', 'Intercompany expenses', (r, i) =>
      combined ? 0 : i !== 0 ? r.int(40_000, 60_000) : 0,
    ),
    line('other', 'Other', (r) => r.int(2_000, 9_000)),
  ].filter((l) => l.current !== 0 || l.previous !== 0);

  return {
    basis: 'cogs',
    period: { label, compareLabel },
    combined,
    income,
    costOfSales,
    overheads,
    intercompanyRemovedPence: combined ? 98_400 * months : 0,
  };
}
