/** Labels for the tickable tabs, keyed as the contract keys them (PERM-3). No side effects. */
import type { UserTab } from './api.ts';

export const USER_TABS: Array<{ key: UserTab; label: string }> = [
  { key: 'home', label: 'Home' },
  { key: 'orders', label: 'Orders' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'stock-catalogue', label: 'Stock & Catalogue' },
  { key: 'customer-service', label: 'Customer Service' },
  { key: 'account-health', label: 'Account Health' },
  { key: 'advertising', label: 'Advertising' },
  { key: 'sales-profit', label: 'Sales & Profit' },
  { key: 'forecasting', label: 'Forecasting' },
  { key: 'finance', label: 'Finance' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'notes', label: 'Notes' },
];
