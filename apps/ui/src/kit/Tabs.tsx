import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import type { ReactNode } from 'react';

export interface TabItem<V extends string> {
  value: V;
  label: string;
  content: ReactNode;
}

/**
 * Section tabs inside a page (order detail, settings). The active tab has a graphite underline.
 * List views use ViewTabs (round, with counts) instead.
 */
export function Tabs<V extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: Array<TabItem<V>>;
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <BaseTabs.Root
      value={value}
      onValueChange={(v) => {
        onChange(v as V);
      }}
    >
      <BaseTabs.List aria-label={label} className="flex gap-5 border-b border-border">
        {items.map((t) => (
          <BaseTabs.Tab
            key={t.value}
            value={t.value}
            className="-mb-px flex h-10 items-center border-b-2 border-transparent text-13 font-medium text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-600 data-[active]:border-side data-[active]:text-ink"
          >
            {t.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {items.map((t) => (
        <BaseTabs.Panel key={t.value} value={t.value} className="pt-4 outline-none">
          {t.content}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}
