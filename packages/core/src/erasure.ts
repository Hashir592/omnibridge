/**
 * ADR-067 (T-0408, DEL-4): why an admin withdrew an erasure request. A fixed list, never free
 * text: a typed reason could carry the buyer's name or email into db-main and the audit log.
 */
export const ERASURE_WITHDRAW_REASONS = [
  'wrong_identifiers',
  'no_match',
  'duplicate',
  'buyer_withdrew',
  'other',
] as const;

export type ErasureWithdrawReason = (typeof ERASURE_WITHDRAW_REASONS)[number];

/**
 * DEL-4: the life of an erasure request. A-006 (ADR-069): `confirmed` means its deletion is
 * queued or running; the deletion job sets `completed` when it has run and `failed` when its
 * last attempt failed (an admin may retry). Overdue counts until it is `completed` or
 * `withdrawn` (ADR-067).
 */
export const ERASURE_STATES = ['open', 'confirmed', 'completed', 'failed', 'withdrawn'] as const;

export type ErasureState = (typeof ERASURE_STATES)[number];

/** True for a request whose one-month clock (DEL-4) has stopped. */
export function erasureClosed(state: ErasureState): boolean {
  return state === 'completed' || state === 'withdrawn';
}

/** The deletion job's queue (packages/queue registry); db-main's stuck rule reads its pg-boss rows. */
export const PII_DELETE_JOB_TYPE = 'pii.delete';
