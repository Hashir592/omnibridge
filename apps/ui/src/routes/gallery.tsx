import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState, ErrorState, PermissionDenied } from '../kit/states.tsx';
import { DateCell, EmptyCell, MoneyCell, NumberCell, Sub, TwoLine } from '../kit/table/cells.tsx';
import { DataTable, type DataColumn, type TableStatus } from '../kit/table/DataTable.tsx';
import { Pager } from '../kit/table/Pager.tsx';
import {
  BulkAction,
  BulkBar,
  ColumnPicker,
  FilterChips,
  FilterMenu,
  ListToolbar,
  SearchBox,
  ViewTabs,
} from '../kit/table/Toolbar.tsx';
import type { PageSize } from '../lib/paging.ts';
import { useCompanyNames } from '../app/companies.ts';
import { useBulkWrite } from '../components/BulkConfirmDialog.tsx';
import { Button } from '../kit/Button.tsx';
import { ControlsGallery } from './gallery-controls.tsx';

/*
 * Dev-only component gallery (T-0302). The route is registered only when import.meta.env.DEV,
 * so production builds never include it. Synthetic data only.
 */

interface DemoRow {
  id: string;
  sku: string;
  title: string;
  stock: number;
  pricePence: number;
  marginPence: number;
  updatedAt: string;
  note: string;
}

const WORDS = ['Oak', 'Steel', 'Linen', 'Copper', 'Slate', 'Maple', 'Cotton', 'Glass'];
const THINGS = ['shelf bracket', 'tea towel', 'desk lamp', 'plant pot', 'coat hook', 'mug'];

function makeRows(n: number): DemoRow[] {
  const base = Date.UTC(2026, 9, 19, 9, 0);
  return Array.from({ length: n }, (_, i) => {
    const price = 499 + ((i * 7919) % 9500);
    return {
      id: `r${String(i)}`,
      sku: `SKU-${String(10000 + i)}`,
      title: `${WORDS[i % WORDS.length] ?? ''} ${THINGS[i % THINGS.length] ?? ''}`,
      stock: (i * 37) % 240,
      pricePence: price,
      marginPence: i % 11 === 0 ? -(50 + ((i * 13) % 400)) : Math.round(price * 0.22),
      updatedAt: new Date(base - i * 3_600_000).toISOString(),
      note:
        i % 5 === 0 ? 'A long note that runs past the column edge and is cut with an ellipsis' : '',
    };
  });
}

const COLUMNS: Array<DataColumn<DemoRow>> = [
  {
    id: 'sku',
    header: 'Product',
    width: 220,
    cell: (r) => <TwoLine value={<span className="ref font-medium">{r.sku}</span>} sub={r.title} />,
  },
  {
    id: 'stock',
    header: 'Stock',
    width: 90,
    align: 'right',
    cell: (r) => <NumberCell value={r.stock} sub="units" />,
  },
  {
    id: 'price',
    header: 'Price',
    width: 110,
    align: 'right',
    cell: (r) => <MoneyCell pence={r.pricePence} strong />,
  },
  {
    id: 'margin',
    header: 'Margin',
    width: 110,
    align: 'right',
    optional: true,
    cell: (r) => <MoneyCell pence={r.marginPence} sub="Estimate" />,
  },
  {
    id: 'updated',
    header: 'Updated',
    width: 130,
    optional: true,
    cell: (r) => <DateCell iso={r.updatedAt} />,
  },
  {
    id: 'note',
    header: 'Note',
    width: 'minmax(180px,1fr)',
    optional: true,
    cell: (r) => (r.note ? <TwoLine value={r.note} /> : <EmptyCell label="No note" />),
  },
];

const ROWS_240 = makeRows(240);

export function GalleryPage() {
  return (
    <div className="h-full overflow-y-auto px-4 pt-2 pb-16 lg:px-6">
      <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">Component gallery</h1>
      <p className="mt-1 text-13 text-ink-muted">
        Dev only (T-0302). Every kit component and state, with synthetic data.
      </p>
      <nav aria-label="Gallery sections" className="mt-3 flex flex-wrap gap-3 text-13">
        {[
          'buttons',
          'forms',
          'badges',
          'tabs',
          'overlays',
          'table',
          'table-states',
          'table-10k',
          'cells',
          'states',
          'skeleton',
        ].map((id) => (
          <a key={id} href={`#${id}`} className="text-brand-600 hover:underline">
            {id}
          </a>
        ))}
      </nav>

      <ControlsGallery Section={Section} />

      <Section id="table" title="Data table: toolbar, chips, bulk bar, pager">
        <ListDemo />
      </Section>

      <Section id="table-states" title="Data table states">
        <div className="grid gap-4 xl:grid-cols-2">
          <StateDemo status="loading" title="Loading (skeleton after 300 ms)" />
          <StateDemo status="ready" title="Empty" />
          <StateDemo status="error" title="Error" />
          <StateDemo
            status="ready"
            title="Long text and negative money"
            rows={ROWS_240.slice(0, 6)}
          />
        </div>
      </Section>

      <Section id="table-10k" title="10,000 rows (virtualised scroll)">
        <BigDemo />
      </Section>

      <Section id="cells" title="Cells (NFR-9 formats)">
        <div className="grid max-w-3xl grid-cols-2 gap-x-8 gap-y-4 rounded-card border border-border bg-card p-4 text-13 shadow-card sm:grid-cols-4">
          <Cellbox label="Money">
            <MoneyCell pence={123456} strong />
          </Cellbox>
          <Cellbox label="Negative money">
            <MoneyCell pence={-500} sub="Refund" />
          </Cellbox>
          <Cellbox label="Number">
            <NumberCell value={10234} sub="units" />
          </Cellbox>
          <Cellbox label="Date, London time">
            <DateCell iso="2026-10-19T09:28:00Z" />
          </Cellbox>
          <Cellbox label="Two lines">
            <TwoLine value="Royal Mail Tracked 48" sub="Tracking confirmed" />
          </Cellbox>
          <Cellbox label="Empty">
            <EmptyCell label="No value" />
          </Cellbox>
          <Cellbox label="Subtext">
            <Sub>Allocated estimate</Sub>
          </Cellbox>
        </div>
      </Section>

      <Section id="bulk" title="Bulk write confirmation (SAFE-1, SAFE-2)">
        <BulkDemo />
      </Section>

      <Section id="states" title="Page states">
        <div className="grid gap-4 xl:grid-cols-3">
          <Card>
            <EmptyState
              title="No reminders yet"
              body="Add a reminder to get a nudge on the Home screen when it is due."
              action={{ label: 'Add reminder', onClick: noop }}
            />
          </Card>
          <Card>
            <ErrorState
              title="Stock could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: noop }}
            />
          </Card>
          <Card>
            <PermissionDenied action={{ label: 'Go to Home', onClick: noop }} />
          </Card>
        </div>
      </Section>
    </div>
  );
}

const noop = () => undefined;

/** Previews a stock push to three accounts (one paused) through the bulk-write routes (MSW). */
function BulkDemo() {
  const bulk = useBulkWrite(useCompanyNames());
  return (
    <Card>
      <div className="flex items-center gap-3 p-5">
        <Button
          disabled={bulk.busy}
          onClick={() => void bulk.start('stock_push', ['ca_1', 'ca_2', 'ca_5'])}
        >
          Push stock to 3 accounts
        </Button>
        <span className="text-13 text-ink-muted">eBay · kestrel-home is paused in the mock.</span>
      </div>
      {bulk.dialog}
    </Card>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-8 scroll-mt-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-border bg-card shadow-card">{children}</div>;
}

function Cellbox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs text-ink-muted">{label}</div>
      <div className="flex h-14 flex-col justify-center gap-1 rounded-ctl border border-divider px-3">
        {children}
      </div>
    </div>
  );
}

function ListDemo() {
  const [view, setView] = useState<'all' | 'low' | 'loss'>('all');
  const [q, setQ] = useState('');
  const [words, setWords] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<PageSize>(20);

  const filtered = useMemo(
    () =>
      ROWS_240.filter(
        (r) =>
          (view === 'all' || (view === 'low' ? r.stock < 20 : r.marginPence < 0)) &&
          (words.length === 0 || words.some((w) => r.title.startsWith(w))) &&
          (q === '' || r.sku.toLowerCase().includes(q.toLowerCase())),
      ),
    [view, words, q],
  );
  const rows = filtered.slice((page - 1) * size, page * size);
  const reset = () => {
    setPage(1);
    setSelected(new Set());
  };

  return (
    <div className="flex h-[640px] flex-col">
      <ViewTabs
        label="Product views"
        value={view}
        onChange={(v) => {
          setView(v);
          reset();
        }}
        tabs={[
          { id: 'all', label: 'All products', count: ROWS_240.length },
          { id: 'low', label: 'Low stock', count: ROWS_240.filter((r) => r.stock < 20).length },
          {
            id: 'loss',
            label: 'Selling at a loss',
            count: ROWS_240.filter((r) => r.marginPence < 0).length,
            alarm: true,
          },
        ]}
      />
      <ListToolbar
        bulk={
          selected.size > 0 && (
            <BulkBar
              count={selected.size}
              pageRows={rows.length}
              onSelectPage={() => {
                setSelected(new Set(rows.map((r) => r.id)));
              }}
              onClear={() => {
                setSelected(new Set());
              }}
            >
              <BulkAction primary>Adjust stock</BulkAction>
              <BulkAction>Export selected</BulkAction>
            </BulkBar>
          )
        }
      >
        <SearchBox
          label="Search by SKU"
          placeholder="SKU"
          value={q}
          onChange={(v) => {
            setQ(v);
            reset();
          }}
        />
        <FilterMenu
          label="Material"
          options={WORDS.map((w) => ({ value: w, label: w }))}
          value={words}
          onChange={(v) => {
            setWords(v);
            reset();
          }}
        />
        <div className="ml-auto">
          <ColumnPicker columns={COLUMNS} hidden={hidden} onChange={setHidden} />
        </div>
      </ListToolbar>
      <FilterChips
        chips={[
          ...words.map((w) => ({
            key: w,
            label: `Material: ${w}`,
            onRemove: () => {
              setWords(words.filter((x) => x !== w));
            },
          })),
          ...(q
            ? [
                {
                  key: 'q',
                  label: `Search: ${q}`,
                  onRemove: () => {
                    setQ('');
                  },
                },
              ]
            : []),
        ]}
        onClearAll={() => {
          setWords([]);
          setQ('');
          reset();
        }}
      />
      <DataTable
        label="Products"
        rows={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => `Select ${r.sku}`}
        columns={COLUMNS}
        hidden={hidden}
        selected={selected}
        onSelectedChange={setSelected}
        rowOffset={(page - 1) * size}
        totalRows={filtered.length}
        scrollKey={`${String(page)}-${String(size)}-${view}-${q}-${words.join()}`}
        status="ready"
        empty={
          <EmptyState
            title="No products match these filters"
            body="Remove a filter to see more products."
            action={{
              label: 'Clear filters',
              onClick: () => {
                setWords([]);
                setQ('');
              },
            }}
          />
        }
      />
      <Pager
        page={page}
        size={size}
        total={filtered.length}
        noun="products"
        onPage={(p) => {
          setPage(p);
          setSelected(new Set());
        }}
        onSize={(s) => {
          setSize(s);
          reset();
        }}
      />
    </div>
  );
}

function StateDemo({
  status,
  title,
  rows = [],
}: {
  status: TableStatus;
  title: string;
  rows?: DemoRow[];
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-xs text-ink-muted">{title}</div>
      <div className="flex h-[340px] flex-col">
        <DataTable
          label={title}
          rows={rows}
          rowId={(r) => r.id}
          columns={COLUMNS}
          status={status}
          empty={
            <EmptyState
              title="No products yet"
              body="Connect a channel in Connections, or add a product by hand."
              action={{ label: 'Add product', onClick: noop }}
            />
          }
          error={
            <ErrorState
              title="Products could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: noop }}
            />
          }
        />
      </div>
    </div>
  );
}

function BigDemo() {
  const rows = useMemo(() => makeRows(10_000), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <div className="flex h-[560px] flex-col" data-testid="table-10k">
      <DataTable
        label="Ten thousand products"
        rows={rows}
        rowId={(r) => r.id}
        rowLabel={(r) => `Select ${r.sku}`}
        columns={COLUMNS}
        selected={selected}
        onSelectedChange={setSelected}
        status="ready"
      />
    </div>
  );
}
