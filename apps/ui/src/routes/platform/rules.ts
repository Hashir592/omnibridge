/**
 * The console's rules that need no server (T-0313), kept apart so unit tests can prove them. The
 * server checks every one again: a wrong move is 409, a bad banner is 422 (PS-032, PS-033).
 */
import type { StatusMove, WorkspaceStatus } from '../../auth/api.ts';

export const SECTIONS = [
  'workspaces',
  'jobs',
  'usage',
  'credentials',
  'health',
  'incident',
  'secrets',
  'flags',
] as const;
export type Section = (typeof SECTIONS)[number];

export const isSection = (v: unknown): v is Section =>
  typeof v === 'string' && (SECTIONS as readonly string[]).includes(v);

/**
 * The status moves a workspace allows (PLAT-2). Archive is final: an archived workspace allows
 * nothing, and reactivate works from suspended only.
 */
export function allowedMoves(status: WorkspaceStatus): StatusMove[] {
  if (status === 'active') return ['suspend', 'archive'];
  if (status === 'suspended') return ['reactivate', 'archive'];
  return [];
}

export const INCIDENT_MAX = 200;

/** The banner text rule (PS-032): 1 to 200 characters after trimming, and no email address. */
export function incidentProblem(message: string): string | undefined {
  const m = message.trim();
  if (m.length === 0) return 'Write the message people will see.';
  if (m.length > INCIDENT_MAX) return `Keep it to ${String(INCIDENT_MAX)} characters.`;
  if (m.includes('@')) return 'Leave out email addresses.';
  return undefined;
}

/** Share of a daily cap used, as a whole percent; null when the provider has no cap. */
export function capShare(calls: number, cap: number | null): number | null {
  if (cap === null || cap === 0) return null;
  return Math.round((calls / cap) * 100);
}

/** Whole days from now to a date, rounded down; negative once it has passed. */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

/** App secret names as people say them (PLAT-4); the stored name stays in the row. */
export const SECRET_LABEL: Record<string, string> = {
  'amazon.lwa_client_id': 'Amazon LWA client ID',
  'amazon.lwa_client_secret': 'Amazon LWA client secret',
  'ads.client_id': 'Amazon Ads client ID',
  'ads.client_secret': 'Amazon Ads client secret',
  'ebay.client_id': 'eBay client ID (App ID)',
  'ebay.client_secret': 'eBay client secret (Cert ID)',
  'ebay.dev_id': 'eBay developer ID',
  'ebay.verification_token': 'eBay deletion verification token',
};
