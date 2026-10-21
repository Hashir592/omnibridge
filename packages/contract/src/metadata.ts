/**
 * Permission metadata every route declares (ARCHITECTURE.md §5 invariant 4, SEC-3).
 */

/** Who may call a route. Checked by the server on every request (M02 builds the checks). */
export const AUTH_KINDS = [
  /** No session: health checks, the public site's forms. */
  'public',
  /** A signed-in workspace user: password, MFA and a chosen workspace. */
  'session',
  /** Password checked, MFA not yet: the MFA routes only (USR-4, ADR-048). */
  'pre-mfa',
  /** MFA done, no workspace chosen yet: the picker, sign-out, password change (USR-2). */
  'signed-in',
  /** A platform operator (console, M05). */
  'platform',
  /** Another OmniBridge service on an internal network. */
  'service',
  /** A provider webhook whose signature is verified before anything else. */
  'signed-webhook',
] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/** Tabs that can be ticked for a child user (PERM-4). */
export const TICKABLE_TABS = [
  'home',
  'orders',
  'shipping',
  'stock-catalogue',
  'customer-service',
  'account-health',
  'advertising',
  'sales-profit',
  'forecasting',
  'finance',
  'reminders',
  'notes',
] as const;

/** Tabs only workspace admins see (PERM-4). */
export const ADMIN_ONLY_TABS = ['connections', 'users', 'settings', 'audit-log'] as const;

/** Every tab a route can belong to; `none` is for routes outside the app's tabs, e.g. /healthz. */
export const TABS = [...TICKABLE_TABS, ...ADMIN_ONLY_TABS, 'none'] as const;
export type Tab = (typeof TABS)[number];

export interface RouteMetadata {
  auth: AuthKind;
  tab: Tab;
  /** Only workspace admins may call it, whatever tabs a child has ticked (PERM-5). */
  adminOnly: boolean;
  /** The route reads or writes company data, so the user's permitted companies apply (PERM-3). */
  companyScoped: boolean;
}
