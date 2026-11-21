import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  useMatches,
} from '@tanstack/react-router';
import { AppStateProvider } from './app/session.tsx';
import { BUILT, NAV } from './app/nav.ts';
import { Shell } from './components/Shell.tsx';
import type { ConnectionsSearch } from './routes/connections/page.tsx';
import type { OrdersSearch } from './routes/orders.tsx';
import type { ShippingSearch } from './routes/shipping.tsx';
import type { HealthSearch } from './routes/account-health.tsx';
import type { AdsSearch } from './routes/advertising.tsx';
import type { AuditSearch } from './routes/audit-log.tsx';
import type { CsSearch } from './routes/customer-service.tsx';
import type { FinanceSearch } from './routes/finance.tsx';
import type { ForecastSearch } from './routes/forecasting.tsx';
import type { NotesSearch } from './routes/notes.tsx';
import type { NotificationsSearch } from './routes/notifications.tsx';
import type { PlatformSearch } from './routes/platform/console.tsx';
import { isSection } from './routes/platform/rules.ts';
import type { SettingsSearch } from './routes/settings.tsx';
import type { SalesProfitSearch } from './routes/sales-profit.tsx';
import type { StockSearch } from './routes/stock.tsx';
import type { ListingsSearch } from './routes/catalogue/listings.tsx';
import type { SkusSearch } from './routes/catalogue/skus.tsx';

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
    for (const k of ['q', 'channel', 'status', 'flag', 'group'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v;
    }
    if (s.placed === 'today') out.placed = 'today';
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

const pageParams = (s: Record<string, unknown>) => {
  const out: { page?: number; size?: 20 | 100 } = {};
  const page = Number(s.page);
  if (Number.isInteger(page) && page > 1) out.page = page;
  const size = Number(s.size);
  if (size === 20 || size === 100) out.size = size;
  return out;
};
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): T | undefined =>
  typeof v === 'string' && (xs as readonly string[]).includes(v) ? (v as T) : undefined;

// T-0305 client preview screens (mock-ups on MSW data).
const STOCK_VIEWS = ['all', 'low', 'oversold', 'sync', 'bundles', 'unmapped'] as const;
const stock = createRoute({
  getParentRoute: () => root,
  path: '/stock',
  validateSearch: (s: Record<string, unknown>): StockSearch => {
    const out: StockSearch = { ...pageParams(s) };
    const view = oneOf(s.view, STOCK_VIEWS);
    if (view && view !== 'all') out.view = view;
    for (const k of ['q', 'vat', 'channel'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v;
    }
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/stock.tsx'), 'StockPage'),
});
// T-0316 catalogue screens on the M08 routes (static paths win over /stock/$skuId).
const catalogueSkus = createRoute({
  getParentRoute: () => root,
  path: '/stock/skus',
  validateSearch: (s: Record<string, unknown>): SkusSearch => {
    const out: SkusSearch = { ...pageParams(s) };
    const view = oneOf(s.view, ['active', 'inactive', 'bundles'] as const);
    if (view) out.view = view;
    const q = str(s.q);
    if (q) out.q = q;
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/catalogue/skus.tsx'), 'SkusPage'),
});
const catalogueSku = createRoute({
  getParentRoute: () => root,
  path: '/stock/skus/$skuId',
  component: lazyRouteComponent(() => import('./routes/catalogue/sku-detail.tsx'), 'SkuDetailPage'),
});
const catalogueListings = createRoute({
  getParentRoute: () => root,
  path: '/stock/listings',
  validateSearch: (s: Record<string, unknown>): ListingsSearch => {
    const out: ListingsSearch = { ...pageParams(s) };
    const view = oneOf(s.view, ['mapped', 'all'] as const);
    if (view) out.view = view;
    for (const k of ['q', 'account'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v;
    }
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/catalogue/listings.tsx'), 'ListingsPage'),
});
const vatRates = createRoute({
  getParentRoute: () => root,
  path: '/stock/vat-rates',
  component: lazyRouteComponent(() => import('./routes/catalogue/vat-rates.tsx'), 'VatRatesPage'),
});
const stockDetail = createRoute({
  getParentRoute: () => root,
  path: '/stock/$skuId',
  component: lazyRouteComponent(() => import('./routes/stock-detail.tsx'), 'StockDetailPage'),
});

const salesProfit = createRoute({
  getParentRoute: () => root,
  path: '/sales-profit',
  validateSearch: (s: Record<string, unknown>): SalesProfitSearch => {
    const out: SalesProfitSearch = {};
    const period = oneOf(s.period, [
      'today',
      'yesterday',
      '7d',
      'month',
      'last_month',
      'quarter',
    ] as const);
    if (period) out.period = period;
    if (s.compare === 'last_year') out.compare = 'last_year';
    const by = oneOf(s.by, ['account', 'sku', 'cluster'] as const);
    if (by) out.by = by;
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/sales-profit.tsx'), 'SalesProfitPage'),
});
const finance = createRoute({
  getParentRoute: () => root,
  path: '/finance',
  validateSearch: (s: Record<string, unknown>): FinanceSearch => {
    const out: FinanceSearch = { ...pageParams(s) };
    const section = oneOf(s.section, ['expenses', 'pnl'] as const);
    if (section) out.section = section;
    const range = oneOf(s.range, ['quarter', 'year'] as const);
    if (range) out.range = range;
    for (const k of ['vatCompany', 'quarter', 'q', 'status', 'category'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v;
    }
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/finance.tsx'), 'FinancePage'),
});
const accountHealth = createRoute({
  getParentRoute: () => root,
  path: '/account-health',
  validateSearch: (s: Record<string, unknown>): HealthSearch =>
    s.market === 'ebay' ? { market: 'ebay' } : {},
  component: lazyRouteComponent(() => import('./routes/account-health.tsx'), 'AccountHealthPage'),
});
const usersFile = () => import('./routes/users.tsx');
const users = createRoute({
  getParentRoute: () => root,
  path: '/users',
  component: lazyRouteComponent(usersFile, 'UsersPage'),
});
const accessReviews = createRoute({
  getParentRoute: () => root,
  path: '/users/access-reviews',
  component: lazyRouteComponent(usersFile, 'AccessReviewsPage'),
});
const buyerData = createRoute({
  getParentRoute: () => root,
  path: '/users/buyer-data',
  component: lazyRouteComponent(() => import('./routes/buyer-data.tsx'), 'BuyerDataPage'),
});
const userDetail = createRoute({
  getParentRoute: () => root,
  path: '/users/$userId',
  component: lazyRouteComponent(usersFile, 'UserDetailPage'),
});
const connections = createRoute({
  getParentRoute: () => root,
  path: '/connections',
  // The OAuth return (T-0701): ?connected=<accountId> or ?error=<code>.
  validateSearch: (s: Record<string, unknown>): ConnectionsSearch => {
    const out: ConnectionsSearch = {};
    for (const k of ['connected', 'error'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v.slice(0, 200);
    }
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/connections/page.tsx'), 'ConnectionsPage'),
});

const customerService = createRoute({
  getParentRoute: () => root,
  path: '/customer-service',
  validateSearch: (s: Record<string, unknown>): CsSearch => {
    const out: CsSearch = {};
    const section = oneOf(s.section, ['amazon', 'feedback', 'reviews'] as const);
    if (section) out.section = section;
    const view = oneOf(s.view, ['unread', 'archived', 'done'] as const);
    if (view) out.view = view;
    for (const k of ['account', 'c'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v;
    }
    return out;
  },
  component: lazyRouteComponent(
    () => import('./routes/customer-service.tsx'),
    'CustomerServicePage',
  ),
});
const advertising = createRoute({
  getParentRoute: () => root,
  path: '/advertising',
  validateSearch: (s: Record<string, unknown>): AdsSearch => {
    const out: AdsSearch = {};
    const section = oneOf(s.section, ['rules', 'negatives'] as const);
    if (section) out.section = section;
    const days = Number(s.days);
    if (days === 7 || days === 14) out.days = days;
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/advertising.tsx'), 'AdvertisingPage'),
});
const forecasting = createRoute({
  getParentRoute: () => root,
  path: '/forecasting',
  validateSearch: (s: Record<string, unknown>): ForecastSearch => {
    const out: ForecastSearch = { ...pageParams(s) };
    const view = oneOf(s.view, ['now', 'all'] as const);
    if (view) out.view = view;
    const q = str(s.q);
    if (q) out.q = q;
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/forecasting.tsx'), 'ForecastingPage'),
});
const reminders = createRoute({
  getParentRoute: () => root,
  path: '/reminders',
  component: lazyRouteComponent(() => import('./routes/reminders.tsx'), 'RemindersPage'),
});
const notes = createRoute({
  getParentRoute: () => root,
  path: '/notes',
  validateSearch: (s: Record<string, unknown>): NotesSearch => {
    const n = str(s.n);
    return n ? { n } : {};
  },
  component: lazyRouteComponent(() => import('./routes/notes.tsx'), 'NotesPage'),
});
const auditLog = createRoute({
  getParentRoute: () => root,
  path: '/audit-log',
  validateSearch: (s: Record<string, unknown>): AuditSearch => {
    const out: AuditSearch = { ...pageParams(s) };
    for (const k of ['q', 'area', 'user'] as const) {
      const v = str(s[k]);
      if (v) out[k] = v;
    }
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/audit-log.tsx'), 'AuditLogPage'),
});
const settings = createRoute({
  getParentRoute: () => root,
  path: '/settings',
  validateSearch: (s: Record<string, unknown>): SettingsSearch => {
    const section = oneOf(s.section, ['companies', 'notifications', 'stock', 'security'] as const);
    return section ? { section } : {};
  },
  component: lazyRouteComponent(() => import('./routes/settings.tsx'), 'SettingsPage'),
});

// The notification centre (T-0312): every member has it, whatever tabs they have ticked. The id
// route is the link in an email (PS-031): it opens the centre on that notification.
const notificationsSearch = (s: Record<string, unknown>): NotificationsSearch => {
  const out: NotificationsSearch = {};
  if (s.view === 'email') out.view = 'email';
  const state = oneOf(s.state, ['unread', 'read', 'resolved'] as const);
  if (state) out.state = state;
  const severity = oneOf(s.severity, ['critical', 'warning', 'info'] as const);
  if (severity) out.severity = severity;
  return out;
};
const notificationCentre = lazyRouteComponent(
  () => import('./routes/notifications.tsx'),
  'NotificationsPage',
);
const notifications = createRoute({
  getParentRoute: () => root,
  path: '/notifications',
  validateSearch: notificationsSearch,
  component: notificationCentre,
});
const notificationLink = createRoute({
  getParentRoute: () => root,
  path: '/notifications/$notificationId',
  validateSearch: notificationsSearch,
  component: notificationCentre,
});

const preview = [
  stock,
  catalogueSkus,
  catalogueSku,
  catalogueListings,
  vatRates,
  stockDetail,
  salesProfit,
  finance,
  accountHealth,
  users,
  accessReviews,
  buyerData,
  userDetail,
  connections,
  customerService,
  advertising,
  forecasting,
  reminders,
  notes,
  auditLog,
  settings,
  notifications,
  notificationLink,
];

const others = NAV.filter((n) => !BUILT.has(n.path)).map((n) =>
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
  authRoute(
    '/sign-in/password-change',
    lazyRouteComponent(() => import('./routes/auth/password-change.tsx'), 'PasswordChangePage'),
  ),
  authRoute('/workspaces', lazyRouteComponent(inviteFile, 'WorkspacesPage')),
  authRoute(
    '/sign-in/terms',
    lazyRouteComponent(() => import('./routes/auth/terms.tsx'), 'TermsPage'),
  ),
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
// The platform console (T-0313): its own frame, since a console session has no workspace (PLAT-1).
const platform = createRoute({
  getParentRoute: () => root,
  path: '/platform',
  validateSearch: (s: Record<string, unknown>): PlatformSearch =>
    isSection(s.section) ? { section: s.section } : {},
  component: lazyRouteComponent(() => import('./routes/platform/console.tsx'), 'PlatformPage'),
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
  ...preview,
  ...others,
  ...gallery,
  ...auth,
  resetPassword,
  invite,
  platform,
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
