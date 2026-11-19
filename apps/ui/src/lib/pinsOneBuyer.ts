import type { BuyerIdentifiers } from '../auth/api.ts';

/**
 * The server's rule (ADR-068): an email, a phone, a marketplace ID, or a name with a postcode.
 * A test holds this and the mock to the contract's own schema (F-M04e-04).
 */
export const pinsOneBuyer = (q: BuyerIdentifiers) =>
  q.email !== undefined ||
  q.phone !== undefined ||
  q.buyer !== undefined ||
  (q.name !== undefined && q.postcode !== undefined);
