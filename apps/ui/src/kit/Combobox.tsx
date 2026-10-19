import { Combobox as BaseCombobox } from '@base-ui/react/combobox';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { controlClass } from './Field.tsx';
import { itemClass, popupClass, type Option } from './Select.tsx';

/** A searchable single choice, for long lists such as SKUs, carriers or users. */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Type to search',
  emptyText = 'Nothing matches. Check the spelling or try fewer letters.',
  disabled,
  className,
}: {
  options: Option[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}) {
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <BaseCombobox.Root
      items={options}
      value={selected}
      onValueChange={(o: Option | null) => {
        onChange(o?.value ?? null);
      }}
      itemToStringLabel={(o: Option) => o.label}
      itemToStringValue={(o: Option) => o.value}
      disabled={disabled ?? false}
    >
      <div className={cn('relative flex items-center', className)}>
        <BaseCombobox.Input placeholder={placeholder} className={cn(controlClass, 'pr-16')} />
        <div className="absolute right-1 flex items-center">
          {selected && (
            <BaseCombobox.Clear
              aria-label="Clear"
              className="grid size-7 place-items-center rounded-[6px] text-ink-muted hover:bg-hover hover:text-ink"
            >
              <X className="size-3.5" aria-hidden />
            </BaseCombobox.Clear>
          )}
          <BaseCombobox.Trigger
            aria-label="Show options"
            className="grid size-7 place-items-center rounded-[6px] text-ink-muted hover:bg-hover hover:text-ink"
          >
            <ChevronsUpDown className="size-4" aria-hidden />
          </BaseCombobox.Trigger>
        </div>
      </div>
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner sideOffset={4} className="z-50">
          <BaseCombobox.Popup className={cn(popupClass, 'w-[var(--anchor-width)]')}>
            <BaseCombobox.Empty className="px-2 py-3 text-13 text-ink-muted empty:hidden">
              {emptyText}
            </BaseCombobox.Empty>
            <BaseCombobox.List className="max-h-72 overflow-y-auto outline-none">
              {(o: Option) => (
                <BaseCombobox.Item key={o.value} value={o} className={itemClass}>
                  <span className="flex-1 truncate">{o.label}</span>
                  <BaseCombobox.ItemIndicator>
                    <Check className="size-4 text-brand-700" aria-hidden />
                  </BaseCombobox.ItemIndicator>
                </BaseCombobox.Item>
              )}
            </BaseCombobox.List>
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  );
}
