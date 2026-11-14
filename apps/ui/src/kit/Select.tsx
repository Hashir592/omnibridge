import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { controlClass } from './Field.tsx';

export interface Option {
  value: string;
  label: string;
}

export const popupClass =
  'rounded-card border border-border bg-card p-1.5 text-13 text-ink shadow-pop outline-none';
export const itemClass =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] px-2 outline-none select-none data-[highlighted]:bg-hover';

/** A single choice from a short, fixed list. For long or searchable lists use Combobox. */
export function Select({
  options,
  value,
  onChange,
  placeholder = 'Choose',
  disabled,
  className,
  label,
}: {
  options: Option[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Accessible name when the select has no visible <Field> label. */
  label?: string;
}) {
  return (
    <BaseSelect.Root
      items={options}
      value={value}
      onValueChange={(v) => {
        onChange(v);
      }}
      disabled={disabled ?? false}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(controlClass, 'flex items-center justify-between gap-2 text-left', className)}
      >
        <BaseSelect.Value
          className="truncate data-[placeholder]:text-ink-muted"
          placeholder={placeholder}
        />
        <BaseSelect.Icon>
          <ChevronsUpDown className="size-4 text-ink-muted" aria-hidden />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <BaseSelect.Popup className={cn(popupClass, 'min-w-[var(--anchor-width)]')}>
            <BaseSelect.List className="max-h-80 overflow-y-auto">
              {options.map((o) => (
                <BaseSelect.Item key={o.value} value={o.value} className={itemClass}>
                  <BaseSelect.ItemText className="flex-1">{o.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator>
                    <Check className="size-4 text-brand-700" aria-hidden />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
