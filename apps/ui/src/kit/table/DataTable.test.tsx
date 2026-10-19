// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataTable, type DataColumn } from './DataTable.tsx';
import { Pager } from './Pager.tsx';

// jsdom has no layout, so give every element a size; otherwise the virtualiser renders no rows.
const box = { width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0 };
const restore: Array<() => void> = [];
beforeAll(() => {
  const rect = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue({ ...box, toJSON: () => box });
  const oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const ow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 1000,
  });
  // jsdom does not implement scrolling.
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  });
  restore.push(() => {
    rect.mockRestore();
    Reflect.deleteProperty(Element.prototype, 'scrollTo');
    if (oh) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', oh);
    if (ow) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', ow);
  });
});
afterAll(() => {
  restore.forEach((r) => {
    r();
  });
});
afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  qty: number;
}
const COLS: Array<DataColumn<Row>> = [
  { id: 'name', header: 'Name', width: 200, cell: (r) => r.name },
  { id: 'qty', header: 'Qty', width: 80, align: 'right', optional: true, cell: (r) => r.qty },
];
const ROWS: Row[] = Array.from({ length: 5 }, (_, i) => ({
  id: `r${String(i)}`,
  name: `Item ${String(i)}`,
  qty: i,
}));

function Harness({ hidden = new Set<string>() }: { hidden?: Set<string> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <>
      <output data-testid="count">{selected.size}</output>
      <DataTable
        label="Items"
        rows={ROWS}
        rowId={(r) => r.id}
        rowLabel={(r) => `Select ${r.name}`}
        columns={COLS}
        hidden={hidden}
        selected={selected}
        onSelectedChange={setSelected}
        status="ready"
      />
    </>
  );
}

describe('DataTable', () => {
  it('[NFR-8] exposes a named table with column headers and one row per item', () => {
    render(<Harness />);
    const table = screen.getByRole('table', { name: 'Items' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['', 'Name', 'Qty']);
    expect(within(table).getByText('Item 4')).toBeTruthy();
    expect(table.getAttribute('aria-rowcount')).toBe('6');
  });

  it('[NFR-8] selects one row, then the whole page from the header checkbox', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Select Item 2'));
    expect(screen.getByTestId('count').textContent).toBe('1');
    const all = screen.getByLabelText<HTMLInputElement>('Select all items on this page');
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(screen.getByTestId('count').textContent).toBe('5');
    fireEvent.click(all);
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('[NFR-8] hides the columns the user turned off in the column picker', () => {
    render(<Harness hidden={new Set(['qty'])} />);
    expect(screen.queryByRole('columnheader', { name: 'Qty' })).toBeNull();
  });

  it('[NFR-8] shows the empty state with its next action when there are no rows', () => {
    render(
      <DataTable
        label="Items"
        rows={[]}
        rowId={(r: Row) => r.id}
        columns={COLS}
        status="ready"
        empty={<button>Clear filters</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('[NFR-8] shows the error message when loading failed', () => {
    render(
      <DataTable
        label="Items"
        rows={[]}
        rowId={(r: Row) => r.id}
        columns={COLS}
        status="error"
        error={<p>Could not load</p>}
      />,
    );
    expect(screen.getByText('Could not load')).toBeTruthy();
  });

  it('[NFR-8] renders only the visible slice of 10,000 rows', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      id: `m${String(i)}`,
      name: `Row ${String(i)}`,
      qty: i,
    }));
    render(
      <DataTable label="Many" rows={many} rowId={(r) => r.id} columns={COLS} status="ready" />,
    );
    const rendered = within(screen.getByRole('table', { name: 'Many' })).getAllByRole('row').length;
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThan(60);
  });
});

describe('Pager', () => {
  it('[NFR-9] shows the range with UK number formatting and pages forward', () => {
    const onPage = vi.fn();
    render(
      <Pager page={1} size={50} total={1234} noun="orders" onPage={onPage} onSize={vi.fn()} />,
    );
    expect(screen.getByText('1-50 of 1,234 orders')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Previous/ }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Page 1' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it('[NFR-8] offers 20, 50 or 100 rows per page (ADR-040)', () => {
    const onSize = vi.fn();
    render(<Pager page={2} size={50} total={500} noun="orders" onPage={vi.fn()} onSize={onSize} />);
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: /Rows per page/ });
    expect([...select.options].map((o) => o.value)).toEqual(['20', '50', '100']);
    fireEvent.change(select, { target: { value: '100' } });
    expect(onSize).toHaveBeenCalledWith(100);
  });

  it('[NFR-8] reports a capped total as "10,000+"', () => {
    render(
      <Pager
        page={1}
        size={50}
        total={10_000}
        totalCapped
        noun="orders"
        onPage={vi.fn()}
        onSize={vi.fn()}
      />,
    );
    expect(screen.getByText('1-50 of 10,000+ orders')).toBeTruthy();
  });
});
