import { Field } from '@base-ui/react/field';
import { Popover } from '@base-ui/react/popover';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn.ts';
import {
  addDays,
  addMonths,
  formatUkDate,
  longDate,
  monthGrid,
  monthLabel,
  parseUkDate,
  todayLondon,
  weekday,
} from '../lib/dates.ts';
import { controlClass } from './Field.tsx';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/**
 * A date typed as DD/MM/YYYY or picked from a calendar (NFR-9). The value is a calendar date
 * 'YYYY-MM-DD' (London), or null when empty. A typed date that is not real is flagged on blur.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled,
  className,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [text, setText] = useState(value ? formatUkDate(value) : '');
  const [bad, setBad] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setText(value ? formatUkDate(value) : '');
    setBad(false);
  }, [value]);

  const commit = () => {
    if (text.trim() === '') {
      setBad(false);
      if (value !== null) onChange(null);
      return;
    }
    const iso = parseUkDate(text);
    const ok = iso && (!min || iso >= min) && (!max || iso <= max);
    setBad(!ok);
    // Enter then blur would otherwise report the same date twice.
    if (ok && iso !== value) onChange(iso);
  };

  return (
    <div className={cn('relative flex w-40 items-center', className)}>
      <Field.Control
        value={text}
        disabled={disabled ?? false}
        onValueChange={(v) => {
          setText(v);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        placeholder="DD/MM/YYYY"
        inputMode="numeric"
        aria-invalid={bad || undefined}
        className={cn(controlClass, 'num pr-9', bad && 'border-danger')}
      />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          disabled={disabled ?? false}
          aria-label="Choose date from calendar"
          className="absolute right-1 grid size-7 place-items-center rounded-[6px] text-ink-muted hover:bg-hover hover:text-ink"
        >
          <CalendarDays className="size-4" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="end" sideOffset={6} className="z-50">
            <Popover.Popup className="rounded-card border border-border bg-card p-3 shadow-pop outline-none">
              <Calendar
                value={value}
                min={min}
                max={max}
                onPick={(iso) => {
                  onChange(iso);
                  setOpen(false);
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** Month grid; arrow keys move by day and week, Page Up/Down by month, Enter picks. */
export function Calendar({
  value,
  min,
  max,
  onPick,
}: {
  value: string | null;
  min?: string | undefined;
  max?: string | undefined;
  onPick: (iso: string) => void;
}) {
  const today = todayLondon();
  const [focus, setFocus] = useState(value ?? today);
  const grid = useRef<HTMLDivElement>(null);
  const days = monthGrid(focus);
  const month = focus.slice(0, 7);
  const out = (iso: string) => (!!min && iso < min) || (!!max && iso > max);

  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  const onKey = (e: KeyboardEvent) => {
    const move: Record<string, () => string> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -weekday(focus)),
      End: () => addDays(focus, 6 - weekday(focus)),
    };
    const f = move[e.key];
    if (!f) return;
    e.preventDefault();
    // Never move onto a disabled day: focus would leave the grid and the keys would stop working.
    let next = f();
    if (min && next < min) next = min;
    if (max && next > max) next = max;
    setFocus(next);
  };

  const nav =
    'grid size-8 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink';
  return (
    <div className="w-[252px]">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className={nav}
          aria-label="Previous month"
          onClick={() => {
            setFocus(addMonths(focus, -1));
          }}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <span className="text-13 font-semibold" aria-live="polite">
          {monthLabel(focus)}
        </span>
        <button
          type="button"
          className={nav}
          aria-label="Next month"
          onClick={() => {
            setFocus(addMonths(focus, 1));
          }}
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs text-ink-muted" aria-hidden>
        {WEEKDAYS.map((d) => (
          <span key={d} className="h-7 leading-7">
            {d}
          </span>
        ))}
      </div>
      <div
        ref={grid}
        role="grid"
        aria-label={monthLabel(focus)}
        className="grid grid-cols-7"
        onKeyDown={onKey}
      >
        {days.map((iso) => {
          const inMonth = iso.slice(0, 7) === month;
          const picked = iso === value;
          return (
            <button
              key={iso}
              type="button"
              data-day={iso}
              tabIndex={iso === focus ? 0 : -1}
              disabled={out(iso)}
              aria-label={longDate(iso)}
              aria-pressed={picked}
              aria-current={iso === today ? 'date' : undefined}
              onClick={() => {
                onPick(iso);
              }}
              className={cn(
                'num grid h-9 place-items-center rounded-ctl text-13',
                picked
                  ? 'bg-side font-medium text-white'
                  : inMonth
                    ? 'text-ink hover:bg-hover'
                    : 'text-ink-faint hover:bg-hover',
                iso === today &&
                  !picked &&
                  'font-semibold text-brand-600 underline underline-offset-4',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              {Number(iso.slice(8))}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex justify-end border-t border-divider pt-2">
        <button
          type="button"
          disabled={out(today)}
          onClick={() => {
            onPick(today);
          }}
          className="h-7 rounded-ctl px-2 text-13 font-medium text-brand-600 hover:bg-hover disabled:opacity-40"
        >
          Today
        </button>
      </div>
    </div>
  );
}
