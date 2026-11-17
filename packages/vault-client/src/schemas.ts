import { z } from 'zod';

/**
 * The pii-vault API (T-0402, DP-4 to DP-7, ADR-007): one shape for the vault and its callers.
 * Requests carry IDs and, for ingest only, the PII itself. Responses carry pii_refs, IDs, masked
 * strings computed on request, or a full record for one logged purpose.
 */

const uuid = z.uuid();

/** DP-5: the only things the vault holds, grouped by what they belong to. */
export const RECORD_FIELDS = {
  buyer_contact: [
    'name',
    'email',
    'phone',
    'address_line1',
    'address_line2',
    'address_line3',
    'city',
    'county',
    'postcode',
    'country',
    'delivery_instructions',
    'channel_buyer_id',
    'channel_username',
  ],
  ebay_message: ['message_body', 'sender_username'],
  ebay_feedback: ['buyer_username'],
} as const;

export type RecordKind = keyof typeof RECORD_FIELDS;
export const RECORD_KINDS = Object.keys(RECORD_FIELDS) as [RecordKind, ...RecordKind[]];
export type FieldName = (typeof RECORD_FIELDS)[RecordKind][number];

/** The capabilities of invariant 8. Each caller's token carries a fixed set of them. */
export const CAPABILITIES = ['ingest', 'read_full', 'mask', 'search', 'match', 'delete'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** DP-7: why a full record is read. Logged with every read. */
export const READ_PURPOSES = ['label', 'order_detail', 'inbox'] as const;
export type ReadPurpose = (typeof READ_PURPOSES)[number];

/** DP-7: which kinds of record each purpose may open (a label never needs a message). */
export const PURPOSE_KINDS: Readonly<Record<ReadPurpose, readonly RecordKind[]>> = {
  label: ['buyer_contact'],
  order_detail: ['buyer_contact'],
  inbox: ['buyer_contact', 'ebay_message', 'ebay_feedback'],
};

/** Why a search runs (ORD-2 order search, DEL-4 erasure, DEL-5 access request). Logged. */
export const SEARCH_PURPOSES = ['order_search', 'erasure', 'access_request'] as const;
export type SearchPurpose = (typeof SEARCH_PURPOSES)[number];

const fieldValue = z.string().min(1).max(4000);

export const IngestRequest = z
  .object({
    workspace_id: uuid,
    kind: z.enum(RECORD_KINDS),
    channel_account_id: uuid.optional(),
    subject_type: z.enum(['order', 'conversation', 'feedback']),
    subject_id: z.string().min(1).max(200),
    /** Set by the caller from delivery or dispatch + pii_expiry_days (DEL-1); may come later. */
    delete_after: z.iso.datetime({ offset: true }).optional(),
    fields: z.record(z.string(), fieldValue),
  })
  .strict()
  .superRefine((req, ctx) => {
    const allowed: readonly string[] = RECORD_FIELDS[req.kind];
    const names = Object.keys(req.fields);
    if (names.length === 0)
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'no fields' });
    for (const name of names) {
      if (!allowed.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', name],
          message: `not a ${req.kind} field`,
        });
      }
    }
  });
export type IngestRequest = z.infer<typeof IngestRequest>;
export const IngestResponse = z.object({ pii_ref: uuid }).strict();
export type IngestResponse = z.infer<typeof IngestResponse>;

export const ExpiryRequest = z
  .object({
    workspace_id: uuid,
    pii_refs: z.array(uuid).min(1).max(500),
    delete_after: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ExpiryRequest = z.infer<typeof ExpiryRequest>;
export const ExpiryResponse = z.object({ updated: z.number().int().min(0) }).strict();
export type ExpiryResponse = z.infer<typeof ExpiryResponse>;

export const ReadFullRequest = z
  .object({
    workspace_id: uuid,
    pii_ref: uuid,
    purpose: z.enum(READ_PURPOSES),
    /** The signed-in user the read is for, when there is one (ORD-5: user, order, time). */
    actor_user_id: uuid.optional(),
  })
  .strict();
export type ReadFullRequest = z.infer<typeof ReadFullRequest>;
export const ReadFullResponse = z
  .object({
    pii_ref: uuid,
    kind: z.enum(RECORD_KINDS),
    subject_type: z.string(),
    subject_id: z.string(),
    fields: z.record(z.string(), z.string()),
  })
  .strict();
export type ReadFullResponse = z.infer<typeof ReadFullResponse>;

export const MaskRequest = z
  .object({ workspace_id: uuid, pii_refs: z.array(uuid).min(1).max(200) })
  .strict();
export type MaskRequest = z.infer<typeof MaskRequest>;
export const MaskResponse = z
  .object({
    records: z.array(
      z.object({ pii_ref: uuid, fields: z.record(z.string(), z.string()) }).strict(),
    ),
  })
  .strict();
export type MaskResponse = z.infer<typeof MaskResponse>;

export const SearchRequest = z
  .object({
    workspace_id: uuid,
    purpose: z.enum(SEARCH_PURPOSES),
    actor_user_id: uuid.optional(),
    query: z
      .object({
        name: fieldValue.optional(),
        email: fieldValue.optional(),
        phone: fieldValue.optional(),
        postcode: fieldValue.optional(),
        buyer: fieldValue.optional(),
      })
      .strict()
      .refine((q) => Object.values(q).some((v) => v !== undefined), 'at least one identifier'),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequest>;
const Subject = z
  .object({
    pii_ref: uuid,
    kind: z.enum(RECORD_KINDS),
    subject_type: z.string(),
    subject_id: z.string(),
    channel_account_id: uuid.nullable(),
  })
  .strict();
/** truncated: more matched than one answer holds; an erasure must narrow the query and search again. */
export const SearchResponse = z
  .object({ matches: z.array(Subject), truncated: z.boolean() })
  .strict();
export type SearchResponse = z.infer<typeof SearchResponse>;

export const MatchRequest = z.object({ workspace_id: uuid, pii_ref: uuid }).strict();
export type MatchRequest = z.infer<typeof MatchRequest>;
/** ORD-9, ADR-055: the subject IDs of the same buyer on the same channel account. Nothing else. */
export const MatchResponse = z.object({ subject_ids: z.array(z.string()) }).strict();
export type MatchResponse = z.infer<typeof MatchResponse>;

export const ErrorBody = z.object({ error: z.string() }).strict();
