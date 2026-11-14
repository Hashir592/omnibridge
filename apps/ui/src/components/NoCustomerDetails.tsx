import { ShieldAlert, TriangleAlert } from 'lucide-react';

/** TOOL-3 banner on Reminders and Notes: plain icon and text, no tinted box (ADR-041 rule). */
export function NoCustomerDetails() {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-13 font-medium text-ink">
      <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
      Do not store customer details here.
      <span className="font-normal text-ink-muted">
        Names, addresses, phone numbers and emails belong on the order only.
      </span>
    </span>
  );
}

/** The warning shown when the text looks like it holds customer details (TOOL-3). */
export function DetailsWarning({ found }: { found: string[] }) {
  if (found.length === 0) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-13 text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold">This looks like {found.join(' and ')}.</span>{' '}
        <span className="text-ink">Remove customer details, or press Save again to keep it.</span>
      </span>
    </p>
  );
}
