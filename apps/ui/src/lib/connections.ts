/** Labels shared by Connections and the bulk-write dialog (INT-4, SAFE-1). */
import type { BulkAction, Provider } from '../auth/api.ts';

export const PROVIDER_LABEL: Record<Provider, string> = {
  amazon: 'Amazon',
  amazon_ads: 'Amazon Ads',
  ebay: 'eBay',
  website: 'Website',
  evri: 'Evri',
  dpd: 'DPD',
};

/** What the confirm button and toasts call each bulk action (SAFE-1). */
export const BULK_LABEL: Record<BulkAction, string> = {
  stock_push: 'Push stock',
  tracking_resend: 'Resend tracking',
  ads_change: 'Apply the ad change',
};

/** Why a bulk confirm was refused. Retrying the same token cannot fix 404 or 409. */
export function bulkConfirmProblem(status: number): string {
  if (status === 404) return 'This confirmation was not found. Close and start again.';
  if (status === 409) {
    return 'This confirmation expired, was already used, or the accounts changed. Close and start again.';
  }
  return 'The write could not be sent. Try again.';
}
