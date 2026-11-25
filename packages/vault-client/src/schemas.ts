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

/** A delivery address (ADR-081 7): line 1 and the postcode; outside the UK the town is enough. */
export function hasDeliveryAddress(
  fields: Readonly<Partial<Record<FieldName, string | undefined>>>,
): boolean {
  const given = (v: string | undefined) => v !== undefined && v.trim() !== '';
  // No country counts as the UK.
  const abroad = given(fields.country) && fields.country?.trim().toUpperCase() !== 'GB';
  return given(fields.address_line1) && (given(fields.postcode) || (abroad && given(fields.city)));
}

/** The capabilities of invariant 8. Each caller's token carries a fixed set of them. */
export const CAPABILITIES = [
  'ingest',
  'read_full',
  'mask',
  'search',
  'match',
  'delete',
  // SEC-12 (T-0503): counts and IDs of reads, for the security alerts; the worker's token only.
  'signals',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** DP-7: why a full record is read. Logged with every read. */
export const READ_PURPOSES = ['label', 'order_detail', 'inbox', 'subject_access'] as const;
export type ReadPurpose = (typeof READ_PURPOSES)[number];

/** DP-7: which kinds of record each purpose may open (a label never needs a message). */
export const PURPOSE_KINDS: Readonly<Record<ReadPurpose, readonly RecordKind[]>> = {
  label: ['buyer_contact'],
  order_detail: ['buyer_contact'],
  inbox: ['buyer_contact', 'ebay_message', 'ebay_feedback'],
  /** DEL-5: everything held about one buyer, for the export the buyer asked for. */
  subject_access: ['buyer_contact', 'ebay_message', 'ebay_feedback'],
};

/** Why a search runs (ORD-2 order search, DEL-4 erasure, DEL-5 access request). Logged. */
export const SEARCH_PURPOSES = [
  'order_search',
  'erasure',
  'access_request',
  'ebay_account_deletion',
] as const;
export type SearchPurpose = (typeof SEARCH_PURPOSES)[number];

const fieldValue = z.string().min(1).max(4000);

/** The sales channels a buyer can come from. */
export const CHANNELS = ['amazon', 'ebay', 'website'] as const;

export const IngestRequest = z
  .object({
    workspace_id: uuid,
    kind: z.enum(RECORD_KINDS),
    channel_account_id: uuid.optional(),
    subject_type: z.enum(['order', 'conversation', 'feedback']),
    subject_id: z.string().min(1).max(200),
    /** Set by the caller from delivery or dispatch + pii_expiry_days (DEL-1); may come later. */
    delete_after: z.iso.datetime({ offset: true }).optional(),
    /**
     * When the order was placed (orders only). ADR-068: a buyer named in an eBay deletion notice
     * by username alone is refused for orders placed before the notice; a later order under a
     * reused username belongs to someone else.
     */
    placed_at: z.iso.datetime({ offset: true }).optional(),
    /** The channel the buyer came from. The eBay deletion check covers eBay; absent means eBay. */
    channel: z.enum(CHANNELS).optional(),
    /** The channel's time of the update these fields came with (orders only). */
    source_updated_at: z.iso.datetime({ offset: true }).optional(),
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

/**
 * The buyer block of an order's one record, corrected by the channel before dispatch. Same
 * pii_ref, same delete_after; it never makes a record. `changed` is false whenever nothing was
 * written: no live record, an older update, the same values, or a block that is no address.
 */
export const ReplaceRequest = z
  .object({
    workspace_id: uuid,
    pii_ref: uuid,
    channel: z.enum(CHANNELS).optional(),
    subject_id: z.string().min(1).max(200),
    placed_at: z.iso.datetime({ offset: true }).optional(),
    source_updated_at: z.iso.datetime({ offset: true }),
    fields: z.partialRecord(z.enum(RECORD_FIELDS.buyer_contact), fieldValue),
  })
  .strict();
export type ReplaceRequest = z.infer<typeof ReplaceRequest>;
export const ReplaceResponse = z.object({ changed: z.boolean() }).strict();
export type ReplaceResponse = z.infer<typeof ReplaceResponse>;

/**
 * Why an expiry moves (DEL-1): the order was dispatched or delivered, so the live copy goes
 * `pii_expiry_days` after that date; or the nightly sweep found a record no order points at
 * (FA-10), which then goes at the next hourly expiry run. Each change is journalled off-site
 * (ADR-068), so a restore re-applies it.
 */
export const EXPIRY_REASONS = ['dispatch', 'delivery', 'orphan'] as const;
export type ExpiryReason = (typeof EXPIRY_REASONS)[number];

export const ExpiryRequest = z
  .object({
    workspace_id: uuid,
    pii_refs: z.array(uuid).min(1).max(500),
    delete_after: z.iso.datetime({ offset: true }),
    reason: z.enum(EXPIRY_REASONS),
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

/**
 * AT-10 (FA-14): an eBay deletion notice names an eBay user, not a workspace. The vault checks
 * every workspace that holds PII for records of that user (the `buyer_exact` blind index, by user
 * ID or username) and answers the refs per workspace. Nothing is deleted here.
 *
 * A-001 (ADR-069): one answer holds at most 5,000 refs. `next` says where the next page starts
 * (workspace, then pii_ref order); the caller asks again with it as `cursor` until it is null, so
 * every record is found.
 */
export const EbayUserMatchCursor = z.object({ workspace_id: uuid, pii_ref: uuid }).strict();
export type EbayUserMatchCursor = z.infer<typeof EbayUserMatchCursor>;
export const EbayUserMatchRequest = z
  .object({
    user_id: z.string().min(1).max(200).optional(),
    username: z.string().min(1).max(200).optional(),
    /** The notice's eventDate; absent means now, and it never counts as later than now. */
    noticed_at: z.iso.datetime({ offset: true }).optional(),
    cursor: EbayUserMatchCursor.optional(),
  })
  .strict()
  .refine((r) => r.user_id !== undefined || r.username !== undefined, 'user_id or username');
export type EbayUserMatchRequest = z.infer<typeof EbayUserMatchRequest>;
export const EbayUserMatchResponse = z
  .object({
    workspaces: z.array(z.object({ workspace_id: uuid, matches: z.array(Subject) }).strict()),
    next: EbayUserMatchCursor.nullable(),
  })
  .strict();
export type EbayUserMatchResponse = z.infer<typeof EbayUserMatchResponse>;

export const MatchRequest = z.object({ workspace_id: uuid, pii_ref: uuid }).strict();
export type MatchRequest = z.infer<typeof MatchRequest>;
/** ORD-9, ADR-055: the subject IDs of the same buyer on the same channel account. Nothing else. */
export const MatchResponse = z.object({ subject_ids: z.array(z.string()) }).strict();
export type MatchResponse = z.infer<typeof MatchResponse>;

/**
 * SEC-12 (T-0503): what the security alerts need from one workspace's vault logs, as counts and
 * IDs only: full reads per user since `read_full_since`, and canary reads since `canary_since`.
 */
export const SignalsRequest = z
  .object({ workspace_id: uuid, read_full_since: z.iso.datetime(), canary_since: z.iso.datetime() })
  .strict();
export type SignalsRequest = z.infer<typeof SignalsRequest>;

export const SignalsResponse = z
  .object({
    read_full: z.array(z.object({ actor_user_id: uuid, count: z.number().int().min(0) }).strict()),
    canary: z.array(
      z
        .object({
          id: z.string().regex(/^[1-9]\d{0,18}$/),
          at: z.iso.datetime({ offset: true }),
          caller: z.enum(['web', 'worker', 'deletion']),
          capability: z.enum(['read_full', 'mask']),
          actor_user_id: uuid.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type SignalsResponse = z.infer<typeof SignalsResponse>;

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

/**
 * The nightly orphan sweep (FA-10): order records older than `created_before`, IDs only, in
 * pii_ref order from `after`. The worker compares them with db-main's order references and queues
 * the ones no order points at for deletion.
 */
export const SubjectsRequest = z
  .object({
    workspace_id: uuid,
    subject_type: z.literal('order'),
    created_before: z.iso.datetime({ offset: true }),
    after: uuid.optional(),
    limit: z.number().int().min(1).max(5000).default(1000),
  })
  .strict();
export type SubjectsRequest = z.input<typeof SubjectsRequest>;
export const SubjectsResponse = z
  .object({
    records: z.array(z.object({ pii_ref: uuid, subject_id: z.string() }).strict()),
    next: uuid.nullable(),
  })
  .strict();
export type SubjectsResponse = z.infer<typeof SubjectsResponse>;
