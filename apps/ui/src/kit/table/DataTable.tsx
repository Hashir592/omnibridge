import {
  columnVisibilityFeature,
  rowSelectionFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowSelectionState,
  type Updater,
  type ColumnVisibilityState,
  type RowData,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/** One row height on every screen (Hashir, 19/10/2026; ADR-041): value plus 12 px subtext. */
export const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 40;
const SELECT_WIDTH = 40;
const estimateSize = () => ROW_HEIGHT;

export interface DataColumn<T> {
  id: string;
  header: string;
  /** Pixels, or a CSS grid track such as 'minmax(104px,1fr)' for the last column. Pinned columns need pixels. */
  width: number | string;
  align?: 'right';
  /** Listed in the column picker, so the user may hide it. */
  optional?: boolean;
  cell: (row: T) => ReactNode;
}

export type TableStatus = 'loading' | 'error' | 'ready';

export interface DataTableProps<T extends RowData> {
  /** Accessible name of the table, for example "Orders". */
  label: string;
  rows: readonly T[];
  rowId: (row: T) => string;
  columns: ReadonlyArray<DataColumn<T>>;
  /** Column ids the user hid in the column picker. */
  hidden?: ReadonlySet<string>;
  /** Pass both to show checkboxes; selection belongs to the page on screen. */
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;
  /** Checkbox label for a row, for example "Select order 204-1234". */
  rowLabel?: (row: T) => string;
  /** How many leading data columns stay in place when scrolling sideways (default 1). */
  pinned?: number;
  /** Rows before this page, and the full count, for screen readers (aria-rowindex / aria-rowcount). */
  rowOffset?: number;
  totalRows?: number;
  status: TableStatus;
  /** Shown when ready with no rows; every empty state says what to do next (DIRECTION §6). */
  empty?: ReactNode;
  /** Shown when the request failed. */
  error?: ReactNode;
  /** When this value changes the table scrolls back to the top (new page, new filters). */
  scrollKey?: string;
  /**
   * A decoration drawn at the row's left edge (inside the checkbox cell, so the table must be
   * selectable), for example the same-buyer group rail. Pass a stable function.
   */
  rowAccent?: (row: T) => ReactNode;
  /** A background class for a whole row (pinned cells too), for example a same-buyer group. */
  rowTone?: (row: T) => string | undefined;
}

// Module scope keeps the feature set stable between renders (TanStack Table 9 rule).
const features = tableFeatures({ rowSelectionFeature, columnVisibilityFeature });

/**
 * The list table (T-0302): sticky header, pinned first column, checkboxes, column visibility,
 * and rows rendered through TanStack Virtual so a page of 100, or a 10,000-row demo, stays smooth.
 * It renders one page; paging, filters and the bulk bar live in the toolbar and Pager around it.
 */
export function DataTable<T extends RowData>(props: DataTableProps<T>) {
  const {
    label,
    rows,
    rowId,
    columns,
    hidden,
    selected,
    onSelectedChange,
    rowLabel,
    pinned = 1,
    rowOffset = 0,
    totalRows,
    status,
    empty,
    error,
    scrollKey,
    rowAccent,
    rowTone,
  } = props;
  const selectable = !!selected && !!onSelectedChange;

  const defs = useMemo<Array<ColumnDef<typeof features, T>>>(
    () =>
      // Table owns selection and visibility only; cells render from DataColumn.cell.
      columns.map((c) => ({ id: c.id })),
    [columns],
  );
  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries([...(selected ?? [])].map((id) => [id, true])),
    [selected],
  );
  const columnVisibility = useMemo<ColumnVisibilityState>(
    () => Object.fromEntries([...(hidden ?? [])].map((id) => [id, false])),
    [hidden],
  );

  const table = useTable({
    features,
    columns: defs,
    data: rows,
    getRowId: (r: T) => rowId(r),
    enableRowSelection: selectable,
    state: { rowSelection, columnVisibility },
    onRowSelectionChange: (u: Updater<RowSelectionState>) => {
      const next = typeof u === 'function' ? u(rowSelection) : u;
      onSelectedChange?.(new Set(Object.keys(next).filter((k) => next[k])));
    },
  });

  // The table object can be new on every render; the layout and the row toggle read it through a
  // ref, so a parent re-render does not redraw rows whose data and columns did not change.
  const tableRef = useRef(table);
  tableRef.current = table;

  // Column layout, memoised so unchanged rows can skip rendering while the table scrolls.
  const layout = useMemo<Layout<T>>(() => {
    const visible = tableRef.current
      .getVisibleLeafColumns()
      .map((c) => byId.get(c.id))
      .filter(isDefined);
    const pinnedIds = new Set(visible.slice(0, pinned).map((c) => c.id));
    // Sticky offsets: the checkbox column, then each pinned column at the sum of the widths before it.
    const lefts = new Map<string, number>();
    let left = selectable ? SELECT_WIDTH : 0;
    for (const c of visible) {
      if (!pinnedIds.has(c.id)) break;
      lefts.set(c.id, left);
      // A column with a flexible width has no fixed offset, so nothing after it can be pinned.
      if (typeof c.width !== 'number') {
        visible.slice(visible.indexOf(c) + 1).forEach((n) => pinnedIds.delete(n.id));
        break;
      }
      left += c.width;
    }
    const track = (w: number | string) => (typeof w === 'number' ? `${String(w)}px` : w);
    return {
      rowAccent,
      rowTone,
      visible,
      pinnedIds,
      lefts,
      lastPinned: visible[pinnedIds.size - 1]?.id,
      selectable,
      grid: [
        ...(selectable ? [`${String(SELECT_WIDTH)}px`] : []),
        ...visible.map((c) => track(c.width)),
      ].join(' '),
    };
    // columnVisibility drives getVisibleLeafColumns, so it stands in for the table here.
  }, [byId, columnVisibility, pinned, selectable, rowAccent, rowTone]);
  const { visible, pinnedIds, lefts, grid } = layout;

  // One stable toggle for every row, so a row re-renders only when its own data or selection changes.
  const toggle = useCallback((id: string) => {
    tableRef.current.getRow(id).toggleSelected();
  }, []);

  const modelRows = table.getRowModel().rows;
  // State, not a ref: the body's virtualiser reads the scroller in its own layout effect, which
  // runs before this component's refs are attached.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const getScrollElement = useCallback(() => scroller, [scroller]);

  useEffect(() => {
    scroller?.scrollTo({ top: 0 });
  }, [scroller, scrollKey]);

  // Header checkbox state, recomputed only when selection or rows change, not on every scroll frame.
  const { allSelected, someSelected } = useMemo(() => {
    const n = modelRows.reduce((k, r) => k + (rowSelection[r.id] ? 1 : 0), 0);
    return {
      allSelected: n > 0 && n === modelRows.length,
      someSelected: n > 0 && n < modelRows.length,
    };
  }, [modelRows, rowSelection]);

  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-card border border-border bg-card shadow-card">
      <div
        ref={setScroller}
        // Focusable, so the table can be scrolled with the arrow keys even with no links in it (WCAG 2.1.1).
        tabIndex={0}
        className="h-full overflow-auto focus-visible:outline-offset-[-2px]"
        role="table"
        aria-label={label}
        aria-rowcount={(totalRows ?? rows.length) + 1}
      >
        <div style={{ minWidth: 'fit-content' }}>
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-20 grid border-b border-border bg-rail text-xs font-medium text-ink-muted"
            style={{ gridTemplateColumns: grid, height: HEADER_HEIGHT }}
          >
            {selectable && (
              <div
                role="columnheader"
                className="sticky left-0 z-10 flex items-center justify-center bg-rail"
              >
                <input
                  type="checkbox"
                  aria-label={`Select all ${label.toLowerCase()} on this page`}
                  className="size-4"
                  disabled={rows.length === 0}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={() => {
                    table.toggleAllRowsSelected(!allSelected);
                  }}
                />
              </div>
            )}
            {visible.map((c) => (
              <div
                key={c.id}
                role="columnheader"
                className={cn(
                  'flex items-center px-3',
                  c.align === 'right' && 'justify-end',
                  stickyClass(layout as Layout<unknown>, c.id),
                  pinnedIds.has(c.id) && 'bg-rail',
                )}
                style={pinnedIds.has(c.id) ? { left: lefts.get(c.id) } : undefined}
              >
                {c.header}
              </div>
            ))}
          </div>

          <TableBody
            rows={modelRows}
            getScrollElement={getScrollElement}
            rowOffset={rowOffset}
            rowLabel={rowLabel}
            layout={layout}
            onToggle={toggle}
          />
        </div>
      </div>
      {/* Messages sit over the visible area under the header, so they stay centred however wide the columns are. */}
      {((status === 'ready' && rows.length === 0 && empty) || (status === 'error' && error)) && (
        <div
          className="absolute inset-x-0 bottom-0 grid place-items-center overflow-auto bg-card"
          style={{ top: HEADER_HEIGHT }}
        >
          {status === 'error' ? error : empty}
        </div>
      )}
      <DelayedSkeleton show={status === 'loading' && rows.length === 0} />
    </div>
  );
}

interface TableBodyProps<T extends RowData> {
  rows: ReadonlyArray<{ id: string; original: T; getIsSelected: () => boolean }>;
  getScrollElement: () => HTMLDivElement | null;
  rowOffset: number;
  rowLabel: ((row: T) => string) | undefined;
  layout: Layout<T>;
  onToggle: (id: string) => void;
}

/**
 * The virtualised rows. The virtualiser lives here, not in DataTable, so a scroll frame re-renders
 * only this body: the table model, the header and the layout are left alone (NFR-8).
 */
function TableBodyImpl<T extends RowData>({
  rows,
  getScrollElement,
  rowOffset,
  rowLabel,
  layout,
  onToggle,
}: TableBodyProps<T>) {
  // Stable callbacks: a new getItemKey on every render makes the virtualiser re-measure every row
  // on every scroll frame, which is the difference between smooth and janky at 10,000 rows.
  const getItemKey = useCallback((i: number) => rows[i]?.id ?? i, [rows]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    // Measured in T-0304: 12 extra rows each side cost ~1.1 ms of script per fast-scroll frame for
    // nothing, because rows render synchronously on every scroll event. 4 keeps a margin for
    // keyboard paging; 2 saved only another ~0.3 ms.
    overscan: 4,
  });
  return (
    <div role="rowgroup" style={{ height: virtual.getTotalSize(), position: 'relative' }}>
      {virtual.getVirtualItems().map((vi) => {
        const row = rows[vi.index];
        if (!row) return null;
        return (
          <TableRow
            key={row.id}
            id={row.id}
            original={row.original}
            ariaIndex={rowOffset + vi.index + 2}
            start={vi.start}
            selected={row.getIsSelected()}
            checkboxLabel={rowLabel ? rowLabel(row.original) : `Select row ${row.id}`}
            layout={layout}
            onToggle={onToggle}
          />
        );
      })}
    </div>
  );
}

const TableBody = memo(TableBodyImpl) as typeof TableBodyImpl;

interface Layout<T> {
  rowAccent: ((row: T) => ReactNode) | undefined;
  rowTone: ((row: T) => string | undefined) | undefined;
  visible: Array<DataColumn<T>>;
  pinnedIds: Set<string>;
  lefts: Map<string, number>;
  lastPinned: string | undefined;
  selectable: boolean;
  grid: string;
}

function stickyClass(layout: Layout<unknown>, id: string) {
  return (
    layout.pinnedIds.has(id) &&
    cn('sticky z-10', id === layout.lastPinned && 'border-r border-divider')
  );
}

interface TableRowProps<T> {
  id: string;
  original: T;
  ariaIndex: number;
  start: number;
  selected: boolean;
  checkboxLabel: string;
  layout: Layout<T>;
  onToggle: (id: string) => void;
}

function TableRowImpl<T>({
  id,
  original,
  ariaIndex,
  start,
  selected,
  checkboxLabel,
  layout,
  onToggle,
}: TableRowProps<T>) {
  const tone = layout.rowTone?.(original) ?? 'bg-card';
  const pinBg = selected ? 'bg-selected' : `${tone} group-hover:bg-hover`;
  const accent = layout.rowAccent?.(original);
  return (
    <div
      role="row"
      aria-rowindex={ariaIndex}
      aria-selected={layout.selectable ? selected : undefined}
      className={cn(
        'group absolute inset-x-0 grid border-b border-divider text-13',
        selected ? 'bg-selected' : `${tone} hover:bg-hover`,
      )}
      style={{
        gridTemplateColumns: layout.grid,
        height: ROW_HEIGHT,
        transform: `translateY(${String(start)}px)`,
        // Each row is placed absolutely at a fixed height, so the browser can lay it out and style
        // it on its own: a row entering the window no longer dirties its neighbours (NFR-8).
        contain: 'size layout style',
      }}
    >
      {layout.selectable && (
        <div role="cell" className={cn('sticky left-0 z-10', pinBg)}>
          {accent}
          {/* The whole cell is the hit area, so it is at least 40 px on a tablet. */}
          <label className="grid h-full w-full cursor-pointer place-items-center">
            <input
              type="checkbox"
              aria-label={checkboxLabel}
              className="size-4"
              checked={selected}
              onChange={() => {
                onToggle(id);
              }}
            />
          </label>
        </div>
      )}
      {layout.visible.map((c) => {
        const pin = layout.pinnedIds.has(c.id);
        return (
          <div
            key={c.id}
            role="cell"
            className={cn(
              'flex min-w-0 flex-col justify-center gap-1 px-3',
              c.align === 'right' && 'items-end text-right',
              stickyClass(layout as Layout<unknown>, c.id),
              pin && pinBg,
            )}
            style={pin ? { left: layout.lefts.get(c.id) } : undefined}
          >
            {c.cell(original)}
          </div>
        );
      })}
    </div>
  );
}

const TableRow = memo(TableRowImpl) as typeof TableRowImpl;

function isDefined<V>(v: V | undefined): v is V {
  return v !== undefined;
}

/** Skeleton rows, only when loading takes longer than 300 ms (DIRECTION §5). */
function DelayedSkeleton({ show }: { show: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => {
      setVisible(true);
    }, 300);
    return () => {
      clearTimeout(t);
    };
  }, [show]);
  if (!visible) return null;
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 bottom-0 bg-card"
      style={{ top: HEADER_HEIGHT }}
      data-testid="table-skeleton"
    >
      {Array.from({ length: 14 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-6 border-b border-divider px-3"
          style={{ height: ROW_HEIGHT }}
        >
          <div className="h-3 w-40 rounded bg-surface" />
          <div className="h-3 w-24 rounded bg-surface" />
          <div className="h-3 w-28 rounded bg-surface" />
          <div className="ml-auto h-3 w-16 rounded bg-surface" />
        </div>
      ))}
    </div>
  );
}
