import { Link, useRouterState } from '@tanstack/react-router';
import { NAV } from '../app/nav.ts';

/** Tabs that are not in the T-0301 mock-ups yet. Says what exists and where to go next. */
export function PlaceholderPage() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const item = NAV.find((n) => n.path === path);
  return (
    <div className="px-4 pt-4 lg:px-5">
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{item?.label ?? 'Page'}</h1>
      <div className="mt-4 max-w-xl rounded-card border border-border bg-card p-5 shadow-card">
        <p className="text-sm font-medium">This tab is not part of the design mock-ups</p>
        <p className="mt-1 text-13 text-ink-muted">
          The mock-ups cover Home, Orders, Order detail and the Shipping desk.{' '}
          {item?.label ?? 'This tab'} is designed with its own module.
        </p>
        <Link
          to="/orders"
          className="mt-4 inline-flex h-8 items-center rounded-ctl bg-brand-700 px-3 text-13 font-medium text-white hover:bg-brand-800"
        >
          Go to Orders
        </Link>
      </div>
    </div>
  );
}
