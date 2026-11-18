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

/** DEL-1: the seven triggers of the one deletion service. */
export const DELETION_TRIGGERS = [
  'expiry',
  'cancellation',
  'erasure',
  'ebay_account_deletion',
  'amazon_revocation',
  'ebay_termination',
  'workspace_closure',
] as const;
export type DeletionTrigger = (typeof DELETION_TRIGGERS)[number];

/**
 * What a run deletes. IDs only, never PII (invariant 7a): an erasure or eBay deletion notice
 * resolves its identifiers to pii_refs with a logged search first (FA-14), then deletes by ref.
 */
export const DeletionScope = z.discriminatedUnion('type', [
  /** Every record of the workspace whose delete_after has passed (the hourly job). */
  z.object({ type: z.literal('expiry') }).strict(),
  /** Every record of these subjects (an order's cancellation). */
  z
    .object({
      type: z.literal('subjects'),
      subject_type: z.enum(['order', 'conversation', 'feedback']),
      subject_ids: z.array(z.string().min(1).max(200)).min(1).max(1000),
    })
    .strict(),
  /** These records (erasure and eBay account deletion, after a search). */
  z.object({ type: z.literal('refs'), pii_refs: z.array(uuid).min(1).max(5000) }).strict(),
  /** Every record of one channel account (Amazon revocation, eBay termination). */
  z.object({ type: z.literal('channel_account'), channel_account_id: uuid }).strict(),
  /** Every record and key of the workspace (closure). */
  z.object({ type: z.literal('workspace') }).strict(),
]);
export type DeletionScope = z.infer<typeof DeletionScope>;

/** Which scope each trigger may use (DEL-1); anything else is refused before it runs. */
export const TRIGGER_SCOPES: Readonly<Record<DeletionTrigger, readonly DeletionScope['type'][]>> = {
  expiry: ['expiry'],
  cancellation: ['subjects'],
  erasure: ['refs'],
  ebay_account_deletion: ['refs'],
  amazon_revocation: ['channel_account'],
  ebay_termination: ['channel_account'],
  workspace_closure: ['workspace'],
};

export const DeleteRequest = z
  .object({
    workspace_id: uuid,
    /** The caller's run id: a retry with the same id reports what that run already deleted. */
    run_id: uuid,
    trigger: z.enum(DELETION_TRIGGERS),
    scope: DeletionScope,
  })
  .strict()
  .refine((r) => TRIGGER_SCOPES[r.trigger].includes(r.scope.type), {
    message: 'scope does not fit the trigger',
    path: ['scope'],
  });
export type DeleteRequest = z.infer<typeof DeleteRequest>;
export const DeleteResponse = z
  .object({
    run_id: uuid,
    /** Every record this run has deleted, this call and any earlier attempt: IDs only. */
    deleted: z.array(z.object({ pii_ref: uuid, channel_account_id: uuid.nullable() }).strict()),
    /** True when the scope had more than one batch: call again with the same run id. */
    more: z.boolean(),
    /** Rows removed by this call: 0 on a repeat (DEL-3: counts, never values). */
    counts: z
      .object({ records: z.number().int(), fields: z.number().int(), index: z.number().int() })
      .strict(),
  })
  .strict();
export type DeleteResponse = z.infer<typeof DeleteResponse>;
