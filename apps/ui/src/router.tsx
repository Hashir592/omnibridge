import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { NAV } from './app/nav.ts';
import { Shell } from './components/Shell.tsx';
import type { OrdersSearch } from './routes/orders.tsx';
import type { ShippingSearch } from './routes/shipping.tsx';

const VIEWS = new Set(['all', 'awaiting', 'overdue', 'today', 'flagged']);
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

const root = createRootRoute({ component: Shell });

const placeholder = lazyRouteComponent(() => import('./routes/placeholder.tsx'), 'PlaceholderPage');

const home = createRoute({
  getParentRoute: () => root,
  path: '/',
  component: lazyRouteComponent(() => import('./routes/home.tsx'), 'HomePage'),
});

const orders = createRoute({
  getParentRoute: () => root,
  path: '/orders',
  // Filters live in the URL so a filtered list can be shared (DIRECTION §4).
  validateSearch: (s: Record<string, unknown>): OrdersSearch => {
    const view = str(s.view);
    const out: OrdersSearch = {};
    if (view && VIEWS.has(view)) out.view = view as NonNullable<OrdersSearch['view']>;
    for (const k of ['q', 'channel', 'status', 'flag'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v;
    }
    const page = Number(s.page);
    if (Number.isInteger(page) && page > 1) out.page = page;
    const size = Number(s.size);
    if (size === 20 || size === 100) out.size = size;
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/orders.tsx'), 'OrdersPage'),
});

const orderDetail = createRoute({
  getParentRoute: () => root,
  path: '/orders/$orderId',
  component: lazyRouteComponent(() => import('./routes/order-detail.tsx'), 'OrderDetailPage'),
});

const shipping = createRoute({
  getParentRoute: () => root,
  path: '/shipping',
  validateSearch: (s: Record<string, unknown>): ShippingSearch => {
    const out: ShippingSearch = {};
    const due = str(s.due);
    if (due === 'late' || due === 'today' || due === 'tomorrow' || due === 'later') out.due = due;
    const ch = str(s.channel);
    if (ch === 'amazon' || ch === 'ebay' || ch === 'website') out.channel = ch;
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/shipping.tsx'), 'ShippingPage'),
});

const others = NAV.filter((n) => !['/', '/orders', '/shipping'].includes(n.path)).map((n) =>
  createRoute({ getParentRoute: () => root, path: n.path, component: placeholder }),
);

const routeTree = root.addChildren([home, orders, orderDetail, shipping, ...others]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
