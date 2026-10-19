import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown, Columns3, OctagonAlert, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { formatInt } from '../../lib/format.ts';
import type { DataColumn } from './DataTable.tsx';

const popup =
  'min-w-56 max-h-80 overflow-y-auto rounded-card border border-border bg-card p-1.5 text-13 text-ink shadow-pop outline-none';
const menuItem =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 outline-none select-none data-[highlighted]:bg-hover';

/** The 56 px strip above a table. Shows the bulk bar in the same slot when rows are selected, so nothing shifts. */
export function ListToolbar({ bulk, children }: { bulk?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 py-2.5">{bulk ? bulk : children}</div>
  );
}

export interface ViewTab<V extends string> {
  id: V;
  label: string;
  count?: number | undefined;
  /** Shows the count in red with an icon when above zero (e.g. Past ship-by). */
  alarm?: boolean;
}

/** Saved views with counts, as fully round tabs; the active one is graphite. */
export function ViewTabs<V extends string>({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: Array<ViewTab<V>>;
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 overflow-x-auto overflow-y-hidden p-px"
    >
      {tabs.map((t) => {
        const active = value === t.id;
        const alarm = !!t.alarm && (t.count ?? 0) > 0;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => {
              onChange(t.id);
            }}
            className={cn(
              'flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-13 whitespace-nowrap',
              active
                ? 'bg-side font-medium text-white shadow-card'
                : 'text-ink-muted hover:bg-card hover:text-ink',
            )}
          >
            {alarm && (
              <OctagonAlert
                className={cn('size-3.5', active ? 'text-white' : 'text-danger')}
                aria-hidden
              />
            )}
            {t.label}
            {'count' in t && (
              <span
                className={cn(
                  'num rounded-full px-2 text-xs leading-[18px] font-medium',
                  alarm && !active
                    ? 'bg-danger-bg text-danger'
                    : active
                      ? 'bg-white/15 text-white'
                      : 'bg-[#e2e5ea] text-ink-muted',
                )}
              >
                {t.count === undefined ? '-' : formatInt(t.count)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <label className="relative flex h-9 w-full max-w-64 items-center">
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute left-2.5 size-4 text-ink-muted" aria-hidden />
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        className="h-9 w-full rounded-ctl border border-border bg-card pr-2 pl-8 text-13 shadow-card outline-none placeholder:text-ink-muted focus:border-brand-600"
      />
    </label>
  );
}

function CheckBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[4px] border',
        on ? 'border-side bg-side text-white' : 'border-[#c3c8d0] bg-card',
      )}
    >
      {on && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

/** A multi-select filter; its picks show as chips under the toolbar. */
export function FilterMenu({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const active = value.length > 0;
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 rounded-ctl border px-3 text-13 font-medium shadow-card',
          active ? 'border-[#c3c8d0] bg-selected text-ink' : 'border-border bg-card hover:bg-hover',
        )}
      >
        {label}
        {active && (
          <span className="num rounded-full bg-side px-1.5 text-[11px] leading-4 text-white">
            {value.length}
          </span>
        )}
        <ChevronDown className="size-3.5 text-ink-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={popup}>
            {options.map((o) => {
              const on = value.includes(o.value);
              return (
                <Menu.CheckboxItem
                  key={o.value}
                  checked={on}
                  closeOnClick={false}
                  onCheckedChange={(c) => {
                    onChange(c ? [...value, o.value] : value.filter((x) => x !== o.value));
                  }}
                  className={menuItem}
                >
                  <CheckBox on={on} />
                  {o.label}
                </Menu.CheckboxItem>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Shows and hides the optional columns. */
export function ColumnPicker<T>({
  columns,
  hidden,
  onChange,
}: {
  columns: ReadonlyArray<DataColumn<T>>;
  hidden: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="flex h-9 items-center gap-1.5 rounded-ctl border border-border bg-card px-3 text-13 font-medium shadow-card hover:bg-hover">
        <Columns3 className="size-4 text-ink-muted" aria-hidden />
        Columns
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={popup}>
            {columns
              .filter((c) => c.optional)
              .map((c) => {
                const on = !hidden.has(c.id);
                return (
                  <Menu.CheckboxItem
                    key={c.id}
                    checked={on}
                    closeOnClick={false}
                    onCheckedChange={(v) => {
                      const n = new Set(hidden);
                      if (v) n.delete(c.id);
                      else n.add(c.id);
                      onChange(n);
                    }}
                    className={menuItem}
                  >
                    <CheckBox on={on} />
                    {c.header}
                  </Menu.CheckboxItem>
                );
              })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export interface Chip {
  key: string;
  label: string;
  onRemove: () => void;
}

/** Active filters as removable chips, with Clear all. */
export function FilterChips({ chips, onClearAll }: { chips: Chip[]; onClearAll: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="-mt-0.5 mb-2 flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-selected pr-1 pl-2.5 text-xs font-medium text-ink"
        >
          {c.label}
          <button
            aria-label={`Remove ${c.label}`}
            onClick={c.onRemove}
            className="grid size-4 place-items-center rounded-full hover:bg-ink/10"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <button onClick={onClearAll} className="ml-1 text-xs text-brand-600 hover:underline">
        Clear all
      </button>
    </div>
  );
}

/** The graphite bar that replaces the toolbar while rows are selected. */
export function BulkBar({
  count,
  pageRows,
  onSelectPage,
  onClear,
  note,
  children,
}: {
  count: number;
  /** Rows on this page; offers "Select all N on this page" while fewer are picked. */
  pageRows: number;
  onSelectPage: () => void;
  onClear: () => void;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex h-full flex-1 items-center gap-3 rounded-ctl bg-side pr-1.5 pl-3.5 text-white shadow-pop"
    >
      <span className="num text-13 font-medium text-white">{formatInt(count)} selected</span>
      {pageRows > count && (
        <button
          className="text-13 text-side-text underline-offset-2 hover:text-white hover:underline"
          onClick={onSelectPage}
        >
          Select all {formatInt(pageRows)} on this page
        </button>
      )}
      {note && <span className="hidden text-xs text-side-muted md:inline">{note}</span>}
      <div className="ml-auto flex items-center gap-1.5">
        {children}
        <button
          onClick={onClear}
          className="flex h-7 items-center gap-1 rounded-[6px] px-2 text-13 text-side-text hover:bg-side-hover hover:text-white"
        >
          <X className="size-4" aria-hidden /> Clear
        </button>
      </div>
    </div>
  );
}

/** Buttons inside the bulk bar: the first action is white, the rest are outlined. */
export function BulkAction({
  primary,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-7 rounded-[6px] px-3 text-13 font-medium disabled:opacity-50',
        primary
          ? 'bg-white text-ink hover:bg-[#e9ecf0]'
          : 'border border-white/20 text-white hover:bg-side-hover',
      )}
    >
      {children}
    </button>
  );
}
