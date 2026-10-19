import {
  BellRing,
  Boxes,
  ChartLine,
  HeartPulse,
  House,
  Landmark,
  Megaphone,
  MessagesSquare,
  Plug,
  ReceiptText,
  ScrollText,
  Settings,
  StickyNote,
  TrendingUp,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Tab } from '../mocks/types.ts';

export interface NavItem {
  key: Tab | 'connections' | 'users' | 'settings' | 'audit';
  label: string;
  path: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

/** PERM-4: the tickable tabs, then the admin-only ones. */
export const NAV: NavItem[] = [
  { key: 'home', label: 'Home', path: '/', icon: House },
  { key: 'orders', label: 'Orders', path: '/orders', icon: ReceiptText },
  { key: 'shipping', label: 'Shipping', path: '/shipping', icon: Truck },
  { key: 'stock', label: 'Stock & Catalogue', path: '/stock', icon: Boxes },
  {
    key: 'customer_service',
    label: 'Customer Service',
    path: '/customer-service',
    icon: MessagesSquare,
  },
  { key: 'account_health', label: 'Account Health', path: '/account-health', icon: HeartPulse },
  { key: 'advertising', label: 'Advertising', path: '/advertising', icon: Megaphone },
  { key: 'sales_profit', label: 'Sales & Profit', path: '/sales-profit', icon: ChartLine },
  { key: 'forecasting', label: 'Forecasting', path: '/forecasting', icon: TrendingUp },
  { key: 'finance', label: 'Finance', path: '/finance', icon: Landmark },
  { key: 'reminders', label: 'Reminders', path: '/reminders', icon: BellRing },
  { key: 'notes', label: 'Notes', path: '/notes', icon: StickyNote },
  { key: 'connections', label: 'Connections', path: '/connections', icon: Plug, adminOnly: true },
  { key: 'users', label: 'Users', path: '/users', icon: Users, adminOnly: true },
  { key: 'settings', label: 'Settings', path: '/settings', icon: Settings, adminOnly: true },
  { key: 'audit', label: 'Audit Log', path: '/audit-log', icon: ScrollText, adminOnly: true },
];

/** Mock-up screens built so far; every other tab shows a "not in the mock-ups" state. */
export const BUILT = new Set<string>(['/orders']);
