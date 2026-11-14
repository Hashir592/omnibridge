import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Download, Lock, Paperclip, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { ChannelMark, CompanyBadge, CompanySwatch } from '../components/badges.tsx';
import { Card, Figure, PageHeader, SimpleTable, Td, Tr } from '../components/Card.tsx';
import { Statement, type StatementLine } from '../components/Statement.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { SignalLabel, StatusLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { ConfirmDialog } from '../kit/Dialog.tsx';
import { Select } from '../kit/Select.tsx';
import { Tabs } from '../kit/Tabs.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { DateCell, EmptyCell, MoneyCell, Sub } from '../kit/table/cells.tsx';
import { DataTable, type DataColumn } from '../kit/table/DataTable.tsx';
import { Pager } from '../kit/table/Pager.tsx';
import {
  FilterChips,
  FilterMenu,
  ListToolbar,
  SearchBox,
  type Chip,
} from '../kit/table/Toolbar.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatInt, formatPence, overdueText } from '../lib/format.ts';
import type { PageSize } from '../lib/paging.ts';
import { mockApi } from '../mocks/api.ts';
import {
  EXPENSE_CATEGORIES,
  type Expense,
  type PnlLine,
  type PnlRange,
  type VatCompany,
  type VatPeriod,
} from '../mocks/finance.ts';
import type { Company } from '../mocks/types.ts';

export type FinanceSection = 'vat' | 'expenses' | 'pnl';

export interface FinanceSearch {
  section?: FinanceSection | undefined;
  vatCompany?: string | undefined;
  quarter?: string | undefined;
  q?: string | undefined;
  status?: string | undefined;
  category?: string | undefined;
  range?: PnlRange | undefined;
  page?: number | undefined;
  size?: PageSize | undefined;
}

const route = getRouteApi('/finance');

export function FinancePage() {
  return (
    <TabGate tab="finance">
      <Finance />
    </TabGate>
  );
}

function useFinanceSearch() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/finance' });
  const set = (patch: Partial<FinanceSearch>, push = false) =>
    void navigate({
      search: (prev: FinanceSearch) => ({ ...prev, ...patch }),
      replace: !push,
    });
  return { search, set };
}

function Finance() {
  const { search, set } = useFinanceSearch();
  const section = search.section ?? 'vat';
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Finance"
          actions={
            <>
              <Button icon={<Download />}>Export for Xero</Button>
              {section === 'expenses' && (
                <Button variant="primary" icon={<Plus />}>
                  Add expense
                </Button>
              )}
            </>
          }
        />
        <div className="mt-3">
          <Tabs<FinanceSection>
            label="Finance sections"
            value={section}
            onChange={(v) => {
              set({ section: v === 'vat' ? undefined : v, page: undefined }, true);
            }}
            items={[
              { value: 'vat', label: 'VAT quarters', content: <VatSection /> },
              { value: 'expenses', label: 'Expenses', content: <ExpensesSection /> },
              { value: 'pnl', label: 'Profit and loss', content: <PnlSection /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------- VAT quarters (VQ-1..4) ---------- */

const STAGGER: Record<string, string> = {
  '1': 'Stagger 1: quarters end Mar, Jun, Sep, Dec',
  '2': 'Stagger 2: quarters end Apr, Jul, Oct, Jan',
  '3': 'Stagger 3: quarters end May, Aug, Nov, Feb',
  monthly: 'Monthly',
};

function VatSection() {
  const { search, set } = useFinanceSearch();
  const { session, persona, companyId } = useAppState();
  const toast = useToast();
  const companies = session?.companies ?? [];
  const vatCompany =
    companyId !== 'all' ? companyId : (search.vatCompany ?? companies[0]?.id ?? '');
  const query = useQuery({
    queryKey: ['vat', persona, vatCompany],
    queryFn: () => mockApi.vat(vatCompany),
    enabled: !!session && vatCompany !== '',
  });
  const v = query.data;
  const quarter = v?.periods.find((p) => p.id === search.quarter) ?? v?.periods[1];
  const [filing, setFiling] = useState(false);

  if (query.isError)
    return (
      <Card>
        <ErrorState
          title="VAT figures could not load"
          body="The server did not answer. Try again; if it keeps failing, check Status."
          action={{ label: 'Try again', onClick: () => void query.refetch() }}
        />
      </Card>
    );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5 text-13 font-medium">
          Company
          <div className="w-64">
            <Select
              label="Company"
              options={companies.map((c) => ({ value: c.id, label: c.tradingName }))}
              value={vatCompany}
              onChange={(id) => {
                set({ vatCompany: id ?? undefined, quarter: undefined });
              }}
            />
          </div>
        </label>
        {v && (
          <div className="pb-2 text-13 text-ink-muted">
            VAT number <span className="ref text-ink">{v.vatNumber}</span>
          </div>
        )}
      </div>

      {v && <StaggerSetting v={v} />}

      {v && quarter && (
        <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
          <Card title="Periods">
            <ul>
              {v.periods.map((p) => {
                const on = p.id === quarter.id;
                return (
                  <li key={p.id} className="border-b border-divider last:border-0">
                    <button
                      onClick={() => {
                        set({ quarter: p.id });
                      }}
                      aria-current={on ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-hover',
                        on && 'bg-selected hover:bg-selected',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-13 font-medium">{p.label}</span>
                        <span className="mt-0.5 block">
                          <PeriodStatus p={p} />
                        </span>
                      </span>
                      <span className="num text-13">
                        {p.status === 'in_progress' ? '' : formatPence(p.lines.settlement)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="flex min-w-0 flex-col gap-5">
            <Card
              title={`Settlement: ${quarter.label}`}
              aside={
                quarter.status === 'open' ? (
                  <Button
                    size="sm"
                    variant="dark"
                    icon={<Lock />}
                    onClick={() => {
                      setFiling(true);
                    }}
                  >
                    Mark as filed
                  </Button>
                ) : quarter.status === 'filed' ? (
                  <Button size="sm">Unlock</Button>
                ) : undefined
              }
            >
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-divider px-5 py-4 md:grid-cols-4">
                <Figure label="VAT payable" value={formatPence(quarter.lines.payable)} />
                <Figure label="VAT claimable" value={formatPence(quarter.lines.claimable)} />
                <Figure
                  label={
                    <>
                      Settlement
                      {quarter.status === 'in_progress' && <SignalLabel signal="Provisional" />}
                    </>
                  }
                  value={formatPence(Math.abs(quarter.lines.settlement))}
                  sub={quarter.lines.settlement >= 0 ? 'Owed to HMRC' : 'Repayment from HMRC'}
                />
                <Figure
                  label="Return due"
                  value={formatDate(quarter.dueBy)}
                  sub={
                    quarter.filed
                      ? `Filed ${formatDate(quarter.filed.at)} by ${quarter.filed.by}`
                      : 'Not filed'
                  }
                />
              </div>
              <Statement
                label={`VAT settlement ${quarter.label}`}
                columns={['Amount']}
                lines={vatLines(quarter)}
              />
            </Card>

            <Card
              title="By channel account"
              aside={
                <span className="text-xs text-ink-muted">
                  Click a figure to see the rows behind it
                </span>
              }
            >
              <SimpleTable
                label="VAT by channel account"
                head={[
                  { label: 'Channel account' },
                  { label: 'Net sales', align: 'right' },
                  { label: 'Output VAT', align: 'right' },
                  { label: 'VAT on refunds', align: 'right' },
                  { label: 'Input VAT on fees', align: 'right' },
                ]}
              >
                {quarter.byAccount.map((a) => {
                  const acct = session?.channelAccounts.find((x) => x.id === a.channelAccountId);
                  return (
                    <Tr key={a.channelAccountId}>
                      <Td>
                        {acct && (
                          <span className="grid grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2">
                            <ChannelMark channel={acct.channel} />
                            <span className="col-start-2 truncate text-xs text-ink-muted">
                              {acct.name}
                            </span>
                          </span>
                        )}
                      </Td>
                      <Td align="right">
                        <DrillLink pence={a.netSalesPence} />
                      </Td>
                      <Td align="right">
                        <DrillLink pence={a.outputVatPence} />
                      </Td>
                      <Td align="right">
                        <DrillLink pence={a.refundVatPence} />
                      </Td>
                      <Td align="right">
                        <DrillLink pence={a.feeInputVatPence} />
                      </Td>
                    </Tr>
                  );
                })}
              </SimpleTable>
            </Card>
          </div>
        </div>
      )}

      {quarter && (
        <ConfirmDialog
          open={filing}
          onOpenChange={setFiling}
          title={`Mark ${quarter.label} as filed?`}
          description="This locks the period: records dated in it can no longer be created, edited or deleted. Late items go to the next open period as adjustments. Only an admin can unlock it, with a reason."
          confirmLabel="Mark as filed and lock"
          onConfirm={() => {
            toast({ title: 'Period filed and locked', tone: 'success' });
          }}
        />
      )}
    </div>
  );
}

function DrillLink({ pence }: { pence: number }) {
  return (
    <button className="num rounded-[4px] text-ink hover:text-brand-600 hover:underline">
      {formatPence(pence)}
    </button>
  );
}

function PeriodStatus({ p }: { p: VatPeriod }) {
  if (p.status === 'filed')
    return (
      <StatusLabel tone="success" icon={Lock}>
        Filed and locked
      </StatusLabel>
    );
  if (p.status === 'open') return <StatusLabel tone="info">Ready to file</StatusLabel>;
  return <StatusLabel tone="neutral">In progress</StatusLabel>;
}

function StaggerSetting({ v }: { v: VatCompany }) {
  const [stagger, setStagger] = useState<string>(String(v.stagger));
  const [confirmed, setConfirmed] = useState(v.staggerConfirmed);
  useEffect(() => {
    setStagger(String(v.stagger));
    setConfirmed(v.staggerConfirmed);
  }, [v]);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-13 font-medium">VAT period</span>
      <div className="w-80">
        <Select
          label="VAT period"
          options={Object.entries(STAGGER).map(([value, label]) => ({ value, label }))}
          value={stagger}
          onChange={(x) => {
            setStagger(x ?? '1');
          }}
        />
      </div>
      {confirmed ? (
        <StatusLabel tone="success">Confirmed from the HMRC VAT account</StatusLabel>
      ) : (
        <>
          <span className="flex items-center gap-1.5 text-13 font-medium text-warning">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            Not confirmed: stagger 1 is a default. Check it in the company’s HMRC VAT account.
          </span>
          <Button
            size="sm"
            onClick={() => {
              setConfirmed(true);
            }}
          >
            Confirm stagger
          </Button>
        </>
      )}
    </div>
  );
}

function vatLines(q: VatPeriod): StatementLine[] {
  const l = q.lines;
  return [
    { label: 'Output', kind: 'heading' },
    { label: 'Output VAT on sales at 20%', values: [l.output20] },
    { label: 'Output VAT on sales at 5%', values: [l.output5] },
    {
      label: 'Net sales at 0% (zero-rated)',
      note: 'No VAT due; shown for the return',
      values: [l.net0],
    },
    {
      label: 'Net sales with No VAT',
      note: 'Exempt or outside scope; kept apart from zero-rated',
      values: [l.netNoVat],
    },
    { label: 'Less VAT on refunds', values: [-l.refundVat] },
    { label: 'Intercompany output VAT', values: [l.icOutput] },
    { label: 'Reverse-charge output VAT', values: [l.rcOutput] },
    { label: 'VAT payable', kind: 'subtotal', values: [l.payable] },
    { label: 'Input', kind: 'heading' },
    { label: 'Input VAT on expenses', values: [l.inputExpenses] },
    { label: 'Input VAT on channel fees', values: [l.inputFees] },
    { label: 'Intercompany input VAT', values: [l.icInput] },
    { label: 'Reverse-charge input VAT', values: [l.rcInput] },
    { label: 'VAT claimable', kind: 'subtotal', values: [l.claimable] },
    {
      label: 'Settlement',
      note:
        l.settlement >= 0
          ? 'Payable minus claimable: owed to HMRC'
          : 'Payable minus claimable: repayment due',
      kind: 'total',
      values: [l.settlement],
    },
  ];
}

/* ---------- Expenses (EXP-1..7) ---------- */

const split = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);

const STATUS_OPTIONS = [
  { value: 'paid', label: 'Paid' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'overdue', label: 'Overdue' },
];

function expenseColumns(company: (id: string) => Company | undefined): Array<DataColumn<Expense>> {
  return [
    {
      id: 'supplier',
      header: 'Supplier',
      width: 228,
      cell: (e) => (
        <>
          <span className="truncate text-13 leading-[18px] font-medium">{e.supplier}</span>
          <Sub className="ref">{e.invoiceNo ?? 'No invoice number'}</Sub>
        </>
      ),
    },
    {
      id: 'category',
      header: 'Category',
      width: 188,
      cell: (e) => {
        const c = company(e.companyId);
        return (
          <span className="grid min-w-0 grid-cols-[8px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
            <span className="col-span-2 truncate text-13 leading-[18px]">{e.category}</span>
            {c && <CompanyBadge company={c} full />}
          </span>
        );
      },
    },
    {
      id: 'date',
      header: 'Invoice date',
      width: 104,
      cell: (e) => <DateCell iso={e.invoiceDate} time={false} />,
    },
    { id: 'status', header: 'Status', width: 164, cell: (e) => <ExpenseStatus e={e} /> },
    {
      id: 'net',
      header: 'Net',
      width: 104,
      align: 'right',
      cell: (e) => <MoneyCell pence={e.netPence} />,
    },
    {
      id: 'vat',
      header: 'VAT',
      width: 96,
      align: 'right',
      cell: (e) => <MoneyCell pence={e.vatPence} sub={`${String(e.vatRate)}%`} />,
    },
    {
      id: 'gross',
      header: 'Gross',
      width: 112,
      align: 'right',
      cell: (e) => <MoneyCell pence={e.grossPence} strong />,
    },
    {
      id: 'files',
      header: 'Invoice file',
      width: 'minmax(96px,1fr)',
      cell: (e) =>
        e.attachments > 0 ? (
          <span className="flex items-center gap-1.5 text-13 text-ink">
            <Paperclip className="size-4 text-ink-muted" aria-hidden /> PDF
          </span>
        ) : (
          <EmptyCell label="No file attached" />
        ),
    },
  ];
}

function ExpenseStatus({ e }: { e: Expense }) {
  if (e.status === 'paid')
    return (
      <>
        <StatusLabel tone="success">Paid</StatusLabel>
        <Sub className="num pl-[22px]">{e.paidAt ? formatDate(e.paidAt) : ''}</Sub>
      </>
    );
  if (e.dueDate && Date.parse(e.dueDate) < Date.now())
    return (
      <>
        <StatusLabel tone="danger">Unpaid</StatusLabel>
        <Sub className="num pl-[22px] font-medium text-danger">{overdueText(e.dueDate)}</Sub>
      </>
    );
  return (
    <>
      <StatusLabel tone="neutral">Unpaid</StatusLabel>
      <Sub className="num pl-[22px]">
        {e.dueDate ? `Due ${formatDate(e.dueDate)}` : 'No due date'}
      </Sub>
    </>
  );
}

function ExpensesSection() {
  const { search, set } = useFinanceSearch();
  const { session, persona, companyId, company } = useAppState();
  const [qDraft, setQDraft] = useState(search.q ?? '');
  const columns = useMemo(() => expenseColumns(company), [company]);
  const size: PageSize = search.size ?? 50;
  const page = search.page ?? 1;
  const filter = (patch: Partial<FinanceSearch>) => {
    set({ page: undefined, ...patch });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if ((search.q ?? '') !== qDraft) filter({ q: qDraft || undefined });
    }, 200);
    return () => {
      clearTimeout(t);
    };
  }, [qDraft]);

  const query = useQuery({
    queryKey: [
      'expenses',
      persona,
      companyId,
      search.q,
      search.status,
      search.category,
      page,
      size,
    ],
    queryFn: () =>
      mockApi.expenses({
        company: companyId,
        q: search.q,
        status: search.status,
        category: search.category,
        cursor: (page - 1) * size,
        limit: size,
      }),
    placeholderData: keepPreviousData,
    enabled: !!session,
  });
  const d = query.data;

  const clearAll = () => {
    setQDraft('');
    set({ q: undefined, status: undefined, category: undefined, page: undefined });
  };
  const chips: Chip[] = [
    ...split(search.status).map((s) => ({
      key: `s-${s}`,
      label: `Status: ${STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s}`,
      onRemove: () => {
        filter({
          status:
            split(search.status)
              .filter((x) => x !== s)
              .join(',') || undefined,
        });
      },
    })),
    ...split(search.category).map((c) => ({
      key: `c-${c}`,
      label: `Category: ${c}`,
      onRemove: () => {
        filter({
          category:
            split(search.category)
              .filter((x) => x !== c)
              .join(',') || undefined,
        });
      },
    })),
  ];

  return (
    <div className="flex flex-col">
      {d && (
        <p className="num flex flex-wrap items-center gap-x-5 gap-y-1 text-13 text-ink-muted">
          <span>
            Unpaid <span className="font-medium text-ink">{formatPence(d.totals.unpaidPence)}</span>
          </span>
          {d.totals.overdue > 0 && (
            <button
              className="flex items-center gap-1.5 font-medium text-danger hover:underline"
              onClick={() => {
                filter({ status: 'overdue' });
              }}
            >
              <TriangleAlert className="size-4" aria-hidden />
              {formatInt(d.totals.overdue)} overdue, {formatPence(d.totals.overduePence)}
            </button>
          )}
          <span>Reminders go to Finance users 3 days before the due date.</span>
        </p>
      )}
      <ListToolbar>
        <SearchBox
          label="Search by supplier or invoice number"
          placeholder="Supplier or invoice number"
          value={qDraft}
          onChange={setQDraft}
        />
        <FilterMenu
          label="Status"
          options={STATUS_OPTIONS}
          value={split(search.status)}
          onChange={(v) => {
            filter({ status: v.join(',') || undefined });
          }}
        />
        <FilterMenu
          label="Category"
          options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c }))}
          value={split(search.category)}
          onChange={(v) => {
            filter({ category: v.join(',') || undefined });
          }}
        />
      </ListToolbar>
      <FilterChips chips={chips} onClearAll={clearAll} />
      <div className="h-[600px]">
        <DataTable
          label="Expenses"
          rows={d?.items ?? []}
          rowId={(e) => e.id}
          columns={columns}
          rowOffset={(page - 1) * size}
          totalRows={d?.total ?? 0}
          scrollKey={JSON.stringify([
            search.q,
            search.status,
            search.category,
            page,
            size,
            companyId,
          ])}
          status={query.isError ? 'error' : query.isPending ? 'loading' : 'ready'}
          empty={
            <EmptyState
              title="No expenses match these filters"
              body="Remove a filter, or add an expense with its invoice."
              action={{ label: 'Clear filters', onClick: clearAll }}
            />
          }
          error={
            <ErrorState
              title="Expenses could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: () => void query.refetch() }}
            />
          }
        />
      </div>
      <Pager
        page={page}
        size={size}
        total={d?.total ?? 0}
        noun="expenses"
        onPage={(p) => {
          set({ page: p === 1 ? undefined : p });
        }}
        onSize={(s) => {
          filter({ size: s === 50 ? undefined : s });
        }}
      />
    </div>
  );
}

/* ---------- P&L (PL-1..4) ---------- */

const RANGES = [
  { value: 'month', label: 'Last month' },
  { value: 'quarter', label: 'Last quarter' },
  { value: 'year', label: 'Last 12 months' },
];

function PnlSection() {
  const { search, set } = useFinanceSearch();
  const { session, persona, companyId, company } = useAppState();
  const range = search.range ?? 'month';
  const query = useQuery({
    queryKey: ['pnl', persona, companyId, range],
    queryFn: () => mockApi.pnl({ company: companyId, range }),
    enabled: !!session,
  });
  const d = query.data;
  if (query.isError)
    return (
      <Card>
        <ErrorState
          title="The P&L could not load"
          body="The server did not answer. Try again; if it keeps failing, check Status."
          action={{ label: 'Try again', onClick: () => void query.refetch() }}
        />
      </Card>
    );
  if (!d) return <div aria-busy className="h-96" />;

  const sum = (ls: PnlLine[], k: 'current' | 'previous') => ls.reduce((s, l) => s + l[k], 0);
  const income = [sum(d.income, 'current'), sum(d.income, 'previous')];
  const cos = [sum(d.costOfSales, 'current'), sum(d.costOfSales, 'previous')];
  const over = [sum(d.overheads, 'current'), sum(d.overheads, 'previous')];
  const gross = [(income[0] ?? 0) - (cos[0] ?? 0), (income[1] ?? 0) - (cos[1] ?? 0)];
  const net = [(gross[0] ?? 0) - (over[0] ?? 0), (gross[1] ?? 0) - (over[1] ?? 0)];
  const change = (a: number, b: number) =>
    b === 0 ? '' : `${a >= b ? '+' : '−'}${(Math.abs((a - b) / b) * 100).toFixed(1)}%`;
  const row = (l: PnlLine, negate = false): StatementLine => ({
    label: l.label,
    values: negate ? [-l.current, -l.previous] : [l.current, l.previous],
    extra: change(l.current, l.previous),
  });
  const marginNote = (g: number, i: number) =>
    i === 0 ? '' : `${((g / i) * 100).toFixed(1)}% of income`;
  const scope = companyId === 'all' ? 'Combined' : (company(companyId)?.tradingName ?? '');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="w-48">
          <Select
            label="P&L period"
            options={RANGES}
            value={range}
            onChange={(v) => {
              set({ range: v === 'month' || v === null ? undefined : (v as PnlRange) });
            }}
          />
        </div>
        <span className="text-13 text-ink-muted">
          {scope}, {d.period.label}. Basis: COGS on items sold{' '}
          <SignalLabel
            signal="Provisional"
            title="Default basis until the accountant confirms it (PL-2)"
          />
        </span>
      </div>
      <Card>
        <Statement
          label={`Profit and loss, ${d.period.label}`}
          columns={[d.period.label, d.period.compareLabel]}
          extraHeader="Change"
          lines={[
            { label: 'Income', kind: 'heading' },
            ...d.income.map((l) => row(l)),
            {
              label: 'Total income',
              kind: 'subtotal',
              values: income,
              extra: change(income[0] ?? 0, income[1] ?? 0),
            },
            { label: 'Cost of sales', kind: 'heading' },
            ...d.costOfSales.map((l) => row(l, true)),
            {
              label: 'Gross profit',
              kind: 'subtotal',
              values: gross,
              note: marginNote(gross[0] ?? 0, income[0] ?? 0),
              extra: change(gross[0] ?? 0, gross[1] ?? 0),
            },
            { label: 'Overheads', kind: 'heading' },
            ...d.overheads.map((l) => row(l, true)),
            {
              label: 'Total overheads',
              kind: 'subtotal',
              values: over.map((x) => -x),
              extra: change(over[0] ?? 0, over[1] ?? 0),
            },
            {
              label: 'Net profit',
              kind: 'total',
              values: net,
              note: marginNote(net[0] ?? 0, income[0] ?? 0),
              extra: change(net[0] ?? 0, net[1] ?? 0),
            },
          ]}
        />
        <div className="flex flex-col gap-1 border-t border-divider px-5 py-3 text-xs text-ink-muted">
          <span>
            Stock purchases are left out on the COGS basis, so stock cost is never counted twice.
            They are in the Purchases report.
          </span>
          {d.combined && (
            <span className="flex items-center gap-1.5">
              {(session?.companies ?? []).map((c) => (
                <CompanySwatch key={c.id} company={c} />
              ))}
              Combined: {formatPence(d.intercompanyRemovedPence)} of intercompany income and
              expenses removed on both sides.
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
