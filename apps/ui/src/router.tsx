import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  useMatches,
} from '@tanstack/react-router';
import { AppStateProvider } from './app/session.tsx';
import { NAV } from './app/nav.ts';
import { Shell } from './components/Shell.tsx';
import type { OrdersSearch } from './routes/orders.tsx';
import type { ShippingSearch } from './routes/shipping.tsx';

const VIEWS = new Set(['all', 'awaiting', 'overdue', 'today', 'flagged']);
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

// Auth screens (T-0303) are marked `staticData: { bare: true }` and render without the app shell.
// The signed-in app state (session, company) lives only inside the shell, so the auth screens
// never ask for a session.
function Root() {
  const bare = useMatches({ select: (ms) => ms.some((m) => m.staticData.bare === true) });
  return bare ? (
    <Outlet />
  ) : (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}

const root = createRootRoute({ component: Root });

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

// Component gallery (T-0302): dev server only. Production builds drop the route and its chunk,
// unless built with VITE_UI_GALLERY=1, which only the Playwright ui-perf test build sets; never set
// it for a deployable build.
const gallery =
  import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === '1'
    ? [
        createRoute({
          getParentRoute: () => root,
          path: '/__ui',
          component: lazyRouteComponent(() => import('./routes/gallery.tsx'), 'GalleryPage'),
        }),
      ]
    : [];

// Auth screens (T-0303). Search params are validated so a link can carry only what it needs.
const signIn = lazyRouteComponent(() => import('./routes/auth/sign-in.tsx'), 'SignInPage');
const mfa = () => import('./routes/auth/mfa.tsx');
const password = () => import('./routes/auth/password.tsx');
const inviteFile = () => import('./routes/auth/invite.tsx');
const authRoute = <P extends string>(path: P, component: ReturnType<typeof lazyRouteComponent>) =>
  createRoute({ getParentRoute: () => root, path, component, staticData: { bare: true } });
const auth = [
  authRoute('/sign-in', signIn),
  authRoute('/sign-in/code', lazyRouteComponent(mfa, 'CodePage')),
  authRoute('/sign-in/recovery', lazyRouteComponent(mfa, 'RecoveryPage')),
  authRoute(
    '/sign-in/set-up-mfa',
    lazyRouteComponent(() => import('./routes/auth/set-up-mfa.tsx'), 'SetUpMfaPage'),
  ),
  authRoute('/forgot-password', lazyRouteComponent(password, 'ForgotPasswordPage')),
  authRoute('/workspaces', lazyRouteComponent(inviteFile, 'WorkspacesPage')),
] as const;
const resetPassword = createRoute({
  getParentRoute: () => root,
  path: '/reset-password',
  validateSearch: (s: Record<string, unknown>): { token?: string } => {
    const token = str(s.token);
    return token ? { token } : {};
  },
  component: lazyRouteComponent(password, 'ResetPasswordPage'),
  staticData: { bare: true },
});
const invite = createRoute({
  getParentRoute: () => root,
  path: '/invite/$token',
  component: lazyRouteComponent(inviteFile, 'AcceptInvitePage'),
  staticData: { bare: true },
});

const routeTree = root.addChildren([
  home,
  orders,
  orderDetail,
  shipping,
  ...others,
  ...gallery,
  ...auth,
  resetPassword,
  invite,
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Render without the app shell (auth screens). */
    bare?: boolean;
  }
}
