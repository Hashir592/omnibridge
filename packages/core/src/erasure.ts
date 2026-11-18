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
