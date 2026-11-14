import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { ArrowDownRight, ArrowUpRight, Download, Minus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanySwatch } from '../components/badges.tsx';
import { Card, Figure, PageHeader, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { Statement } from '../components/Statement.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { SignalLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { Select } from '../kit/Select.tsx';
import { Tabs } from '../kit/Tabs.tsx';
import { ErrorState } from '../kit/states.tsx';
import { ViewTabs } from '../kit/table/Toolbar.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatInt, formatPence, formatTime } from '../lib/format.ts';
import { mockApi } from '../mocks/api.ts';
import type {
  ProfitBreakdown,
  ProfitCompare,
  ProfitFigures,
  ProfitPeriod,
  ProfitSummary,
} from '../mocks/profit.ts';

export interface SalesProfitSearch {
  period?: ProfitPeriod | undefined;
  compare?: ProfitCompare | undefined;
  by?: ProfitBreakdown | undefined;
}

const route = getRouteApi('/sales-profit');

const PERIODS: Array<{ id: ProfitPeriod; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'quarter', label: 'This quarter' },
];

const COMPARE = [
  { value: 'previous', label: 'Previous period' },
  { value: 'last_year', label: 'Same period last year' },
];

/** Chart colours: petrol for this period, a recessive dashed grey for the comparison. */
const CURRENT = '#0F766E';
const COMPARE_INK = '#8C939E';

export function SalesProfitPage() {
  return (
    <TabGate tab="sales_profit">
      <SalesProfit />
    </TabGate>
  );
}

function SalesProfit() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/sales-profit' });
  const { session, persona, companyId, company } = useAppState();
  const period = search.period ?? '30d';
  const compare = search.compare ?? 'previous';
  const by = search.by ?? 'company';
  const set = (patch: Partial<SalesProfitSearch>) =>
    void navigate({ search: (prev: SalesProfitSearch) => ({ ...prev, ...patch }), replace: true });

  const query = useQuery({
    queryKey: ['sales-profit', persona, companyId, period, compare, by],
    queryFn: () => mockApi.salesProfit({ company: companyId, period, compare, by }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const d = query.data;
  const scope =
    companyId === 'all'
      ? `Combined, ${String(session?.companies.length ?? 0)} companies`
      : (company(companyId)?.tradingName ?? '');
  const compareName = compare === 'previous' ? 'previous period' : 'same period last year';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Sales & Profit"
          sub={
            d && (
              <>
                {formatDate(d.period.from)} to {formatDate(d.period.to)}, {scope}. Updated{' '}
                {formatTime(d.asOf)}
              </>
            )
          }
          actions={
            <>
              <div className="w-56">
                <Select
                  label="Compare with"
                  options={COMPARE}
                  value={compare}
                  onChange={(v) => {
                    set({ compare: v === 'last_year' ? 'last_year' : undefined });
                  }}
                />
              </div>
              <Button icon={<Download />}>Export CSV</Button>
            </>
          }
        />
        <div className="mt-4">
          <ViewTabs
            label="Period"
            value={period}
            onChange={(v) => {
              set({ period: v === '30d' ? undefined : v });
            }}
            tabs={PERIODS}
          />
        </div>

        {query.isError ? (
          <Card className="mt-4">
            <ErrorState
              title="Figures could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: () => void query.refetch() }}
            />
          </Card>
        ) : d ? (
          <Body
            d={d}
            compareName={compareName}
            by={by}
            onBy={(v) => {
              set({ by: v === 'company' ? undefined : v });
            }}
          />
        ) : (
          <div aria-busy className="mt-4 h-96" />
        )}
      </div>
    </div>
  );
}

function pct(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function Delta({ cur, prev, against }: { cur: number; prev: number; against: string }) {
  const p = pct(cur, prev);
  if (p === null) return <span>No figures for the {against}</span>;
  const Icon = Math.abs(p) < 0.05 ? Minus : p > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="size-3.5" aria-hidden />
      {p > 0 ? '+' : p < 0 ? '−' : ''}
      {Math.abs(p).toFixed(1)}% vs {against}
    </span>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Contribution as a % of sales less refunds; 0 when nothing was kept. */
const margin = (f: ProfitFigures) => {
  const net = f.grossPence - f.refundsPence;
  return net === 0 ? 0 : (f.contributionPence / net) * 100;
};

function Body({
  d,
  compareName,
  by,
  onBy,
}: {
  d: ProfitSummary;
  compareName: string;
  by: ProfitBreakdown;
  onBy: (v: ProfitBreakdown) => void;
}) {
  const c = d.current;
  const p = d.previous;
  const provisional = (on: boolean) =>
    on ? (
      <SignalLabel signal="Provisional" title="Amazon has not settled these days yet" />
    ) : undefined;

  return (
    <>
      <Card className="mt-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 md:grid-cols-3 lg:grid-cols-6">
          <Figure
            label="Gross sales"
            value={formatPence(c.grossPence)}
            sub={<Delta cur={c.grossPence} prev={p.grossPence} against={compareName} />}
          />
          <Figure
            label="Orders"
            value={formatInt(c.orders)}
            sub={<Delta cur={c.orders} prev={p.orders} against={compareName} />}
          />
          <Figure
            label="Units"
            value={formatInt(c.units)}
            sub={<Delta cur={c.units} prev={p.units} against={compareName} />}
          />
          <Figure
            label="Refunds"
            value={formatPence(c.refundsPence)}
            sub={<Delta cur={c.refundsPence} prev={p.refundsPence} against={compareName} />}
          />
          <Figure
            label={<>Contribution profit {provisional(d.signals.feesProvisional)}</>}
            value={
              <span className={cn(c.contributionPence < 0 && 'text-danger')}>
                {formatPence(c.contributionPence)}
              </span>
            }
            sub={
              <Delta cur={c.contributionPence} prev={p.contributionPence} against={compareName} />
            }
          />
          <Figure
            label="Margin"
            value={`${margin(c).toFixed(1)}%`}
            sub={`${margin(p).toFixed(1)}% in the ${compareName}`}
          />
        </div>
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <ProfitChart d={d} compareName={compareName} />
        <Card title="How contribution profit is made">
          <Statement
            label="Contribution profit"
            columns={['This period']}
            lines={[
              { label: 'Gross sales', values: [c.grossPence] },
              { label: 'Less refunds', values: [-c.refundsPence] },
              { label: 'Less output VAT', values: [-c.outputVatPence] },
              {
                label: 'Less channel fees',
                note: 'Net of reclaimable VAT',
                values: [-c.feesPence],
                signal: provisional(d.signals.feesProvisional),
              },
              {
                label: 'Less ad spend',
                values: [-c.adSpendPence],
                signal: provisional(d.signals.adSpendProvisional),
              },
              { label: 'Less COGS', note: 'From order-line snapshots', values: [-c.cogsPence] },
              { label: 'Less label cost', values: [-c.labelPence] },
              { label: 'Contribution profit', kind: 'total', values: [c.contributionPence] },
            ]}
          />
          <p className="px-5 py-3 text-xs text-ink-muted">
            Overheads are not included. They are in the Finance P&L.
          </p>
        </Card>
      </div>

      <Card className="mt-5">
        <div className="px-5 pt-2">
          <Tabs<ProfitBreakdown>
            label="Breakdown"
            value={by}
            onChange={onBy}
            items={[
              { value: 'company', label: 'By company', content: null },
              { value: 'account', label: 'By channel account', content: null },
              { value: 'sku', label: 'By Master SKU', content: null },
              { value: 'cluster', label: 'By cluster', content: null },
            ]}
          />
        </div>
        <Breakdown d={d} compareName={compareName} />
        <p className="border-t border-divider px-5 py-3 text-xs text-ink-muted">
          Channels are compared on money only: revenue, costs, profit and margin (PRF-4).
          {d.signals.skuAllocated && ' Ad spend per SKU is an allocated estimate.'}
        </p>
      </Card>
    </>
  );
}

const axisMoney = (pence: number) => {
  const pounds = pence / 100;
  return Math.abs(pounds) >= 1000
    ? `£${(pounds / 1000).toFixed(pounds % 1000 === 0 ? 0 : 1)}k`
    : `£${String(Math.round(pounds))}`;
};
const shortDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  day: '2-digit',
  month: '2-digit',
});

function ProfitChart({ d, compareName }: { d: ProfitSummary; compareName: string }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card
      title="Contribution profit by day"
      aside={
        <>
          <span className="hidden items-center gap-3 text-xs text-ink-muted sm:flex">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 rounded-[3px]"
                style={{ background: CURRENT }}
              />
              This period
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-0 w-4 border-t-2 border-dashed"
                style={{ borderColor: COMPARE_INK }}
              />
              {capital(compareName)}
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAsTable((v) => !v);
            }}
          >
            {asTable ? 'Show chart' : 'Show table'}
          </Button>
        </>
      }
    >
      {asTable ? (
        <div className="max-h-[300px] overflow-y-auto">
          <SimpleTable
            label="Contribution profit by day"
            head={[
              { label: 'Day' },
              { label: 'Gross sales', align: 'right' },
              { label: 'Contribution profit', align: 'right' },
              { label: capital(compareName), align: 'right' },
            ]}
          >
            {d.series.map((s) => (
              <Tr key={s.date}>
                <Td>
                  <span className="num">{formatDate(s.date)}</span>
                </Td>
                <Td align="right">{formatPence(s.grossPence)}</Td>
                <Td align="right">{formatPence(s.contributionPence)}</Td>
                <Td align="right">{formatPence(s.compareContributionPence)}</Td>
              </Tr>
            ))}
          </SimpleTable>
        </div>
      ) : (
        <div
          className="h-[300px] px-2 pt-4 pb-2"
          role="img"
          aria-label={`Contribution profit by day, ${String(d.series.length)} days. Use Show table for the figures.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={d.series}
              margin={{ top: 4, right: 12, bottom: 0, left: 4 }}
              barCategoryGap={d.series.length > 40 ? 1 : 3}
            >
              <CartesianGrid vertical={false} stroke="#ECEEF2" />
              <XAxis
                dataKey="date"
                tickFormatter={(v: string) => shortDate.format(new Date(v))}
                tick={{ fontSize: 12, fill: '#5C6370' }}
                tickLine={false}
                axisLine={{ stroke: '#DDE1E7' }}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={axisMoney}
                tick={{ fontSize: 12, fill: '#5C6370' }}
                tickLine={false}
                axisLine={false}
                width={52}
              />
              <Tooltip
                cursor={{ fill: '#F5F7F9' }}
                content={(props: TooltipContentProps) => (
                  <ChartTip {...props} compareName={compareName} />
                )}
              />
              <Bar
                dataKey="contributionPence"
                fill={CURRENT}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
                isAnimationActive={false}
              />
              <Line
                dataKey="compareContributionPence"
                stroke={COMPARE_INK}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
                type="monotone"
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function ChartTip({ active, payload, compareName }: TooltipContentProps & { compareName: string }) {
  const row = payload[0]?.payload as ProfitSummary['series'][number] | undefined;
  if (!active || !row) return null;
  const line = (label: ReactNode, v: number) => (
    <div className="flex justify-between gap-6">
      <span className="text-ink-muted">{label}</span>
      <span className="num font-medium">{formatPence(v)}</span>
    </div>
  );
  return (
    <div className="min-w-56 rounded-card border border-border bg-card px-3 py-2.5 text-13 shadow-pop">
      <p className="num mb-1.5 font-semibold">{formatDate(row.date)}</p>
      {line('Contribution profit', row.contributionPence)}
      {line(capital(compareName), row.compareContributionPence)}
      {line('Gross sales', row.grossPence)}
    </div>
  );
}

function Breakdown({ d, compareName }: { d: ProfitSummary; compareName: string }) {
  const { company } = useAppState();
  return (
    <SimpleTable
      label="Profit breakdown"
      head={[
        { label: 'Name' },
        { label: 'Orders', align: 'right' },
        { label: 'Gross sales', align: 'right' },
        { label: 'Fees', align: 'right' },
        { label: 'Ad spend', align: 'right' },
        { label: 'COGS', align: 'right' },
        { label: 'Labels', align: 'right' },
        { label: 'Contribution', align: 'right' },
        { label: 'Margin', align: 'right' },
      ]}
    >
      {d.breakdown.map((r) => {
        const co = r.companyId ? company(r.companyId) : undefined;
        return (
          <Tr key={r.id}>
            <Td className="max-w-[300px]">
              <span className="flex min-w-0 items-center gap-2">
                {r.channel ? (
                  <span className="inline-grid shrink-0 grid-cols-[18px] [&>span:last-child]:sr-only">
                    <ChannelMark channel={r.channel} />
                  </span>
                ) : co ? (
                  <CompanySwatch company={co} />
                ) : null}
                <Stack
                  value={<span className={cn(d.signals.skuAllocated && 'ref')}>{r.name}</span>}
                  sub={r.sub}
                />
              </span>
            </Td>
            <Td align="right">{formatInt(r.figures.orders)}</Td>
            <Td align="right">{formatPence(r.figures.grossPence)}</Td>
            <Td align="right">{formatPence(r.figures.feesPence)}</Td>
            <Td align="right">{formatPence(r.figures.adSpendPence)}</Td>
            <Td align="right">{formatPence(r.figures.cogsPence)}</Td>
            <Td align="right">{formatPence(r.figures.labelPence)}</Td>
            <Td align="right">
              <Stack
                value={
                  <span
                    className={cn('font-medium', r.figures.contributionPence < 0 && 'text-danger')}
                  >
                    {formatPence(r.figures.contributionPence)}
                  </span>
                }
                sub={
                  <Delta
                    cur={r.figures.contributionPence}
                    prev={r.compareContributionPence}
                    against={compareName === 'previous period' ? 'previous' : 'last year'}
                  />
                }
              />
            </Td>
            <Td align="right">{margin(r.figures).toFixed(1)}%</Td>
          </Tr>
        );
      })}
    </SimpleTable>
  );
}
