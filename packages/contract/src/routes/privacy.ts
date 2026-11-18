import { ERASURE_WITHDRAW_REASONS } from '@omnibridge/core';
import { z } from 'zod';
import { FileDownloadSchema } from '../download.ts';
import { defineRoute } from '../route.ts';

/*
 * Erasure and subject access requests (T-0404: DEL-4, DEL-5). PROPOSED SHAPE for S2 (T-0308).
 * Admins only, on the Users tab. The buyer's identifiers travel only in request bodies, never in
 * a URL, and are never stored: an erasure request keeps the matching record refs, and the access
 * export is streamed and kept nowhere. Errors:
 * - 404 not_found: no such request in this workspace
 * - 400 validation_failed: a withdraw reason missing or not in the list
 * - 409 conflict: the request is no longer open (confirmed or withdrawn)
 * - 400 validation_failed: the identifiers do not pin one buyer (no email, phone or marketplace
 *   ID, and not a name with a postcode)
 * - 422 validation_failed: an access export matches too many records
 * - 503 service_unavailable: the PII vault is not configured or not reachable
 */

const privacy = { auth: 'session', tab: 'users', adminOnly: true, companyScoped: false } as const;

/**
 * What an admin knows about the buyer; all given must match (AND). It must pin one person
 * (S5-20261118-04, ADR-068): an email, a phone, a marketplace ID or username, or a name with a
 * postcode. A postcode or a name alone matches many buyers, so it is refused (400).
 */
export const BuyerIdentifiersSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().min(1).max(254).optional(),
    phone: z.string().trim().min(1).max(40).optional(),
    postcode: z.string().trim().min(1).max(12).optional(),
    /** The marketplace buyer ID or username. */
    buyer: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (q) =>
      q.email !== undefined ||
      q.phone !== undefined ||
      q.buyer !== undefined ||
      (q.name !== undefined && q.postcode !== undefined),
    "Add the buyer's email, phone or marketplace ID, or their name and postcode",
  )
  .meta({ id: 'BuyerIdentifiers' });

/** One record found, shown masked (ORD-5): the admin checks it is the right buyer. */
export const ErasureMatchSchema = z
  .object({
    piiRef: z.uuid(),
    kind: z.enum(['buyer_contact', 'ebay_message', 'ebay_feedback']),
    subjectType: z.string(),
    subjectId: z.string(),
    channelAccountId: z.uuid().nullable(),
    /** Masked values only, computed now and never stored. */
    masked: z.record(z.string(), z.string()),
  })
  .meta({ id: 'ErasureMatch' });

export const ErasureRequestSchema = z
  .object({
    id: z.uuid(),
    requestedAt: z.iso.datetime(),
    /** DEL-4: one month after the request. */
    dueAt: z.iso.datetime(),
    /** Still open after its due date. A withdrawn request is never overdue (ADR-067). */
    overdue: z.boolean(),
    state: z.enum(['open', 'confirmed', 'withdrawn']),
    matchCount: z.number().int().min(0),
    confirmedAt: z.iso.datetime().nullable(),
    withdrawnAt: z.iso.datetime().nullable(),
    withdrawReason: z.enum(ERASURE_WITHDRAW_REASONS).nullable(),
    /** The deletion job (GET /jobs/:id shows its progress), once confirmed. */
    jobId: z.uuid().nullable(),
  })
  .meta({ id: 'ErasureRequest' });

/** DEL-4 step 1: search the PII store; nothing is deleted yet. */
export const createErasureRequest = defineRoute({
  id: 'createErasureRequest',
  method: 'POST',
  path: '/erasure-requests',
  summary: 'Start an erasure request: find every record of a buyer',
  body: z.object({ identifiers: BuyerIdentifiersSchema }).strict(),
  responses: {
    201: ErasureRequestSchema.extend({
      matches: z.array(ErasureMatchSchema),
      /** More matched than one answer holds: narrow the identifiers and start again. */
      truncated: z.boolean(),
    }).meta({ id: 'ErasureRequestCreated' }),
  },
  ...privacy,
});

export const listErasureRequests = defineRoute({
  id: 'listErasureRequests',
  method: 'GET',
  path: '/erasure-requests',
  summary: 'List erasure requests, newest first',
  responses: { 200: z.object({ items: z.array(ErasureRequestSchema) }) },
  ...privacy,
});

/** DEL-4 step 2: delete every match. The response is the admin's confirmation. */
export const confirmErasureRequest = defineRoute({
  id: 'confirmErasureRequest',
  method: 'POST',
  path: '/erasure-requests/:id/confirm',
  summary: 'Confirm an erasure request: delete every match',
  params: z.object({ id: z.uuid() }),
  responses: { 202: ErasureRequestSchema },
  ...privacy,
});

/**
 * ADR-067: close an open request without deleting anything (a wrong or empty search). The reason
 * is a code from a fixed list, never free text. 409 once it is confirmed or withdrawn.
 */
export const withdrawErasureRequest = defineRoute({
  id: 'withdrawErasureRequest',
  method: 'POST',
  path: '/erasure-requests/:id/withdraw',
  summary: 'Withdraw an open erasure request: nothing is deleted',
  params: z.object({ id: z.uuid() }),
  body: z.object({ reason: z.enum(ERASURE_WITHDRAW_REASONS) }).strict(),
  responses: { 200: ErasureRequestSchema },
  ...privacy,
});

/**
 * DEL-5: everything held about one buyer, as a JSON file streamed to the admin and stored
 * nowhere (the one export DP-8 allows, because the buyer asked for it). Every read is logged.
 */
export const exportSubjectAccess = defineRoute({
  id: 'exportSubjectAccess',
  method: 'POST',
  path: '/access-requests/export',
  summary: 'Export everything held about one buyer',
  body: z.object({ identifiers: BuyerIdentifiersSchema }).strict(),
  responses: { 200: FileDownloadSchema },
  ...privacy,
});

export const privacyRoutes = [
  createErasureRequest,
  listErasureRequests,
  confirmErasureRequest,
  withdrawErasureRequest,
  exportSubjectAccess,
] as const;
