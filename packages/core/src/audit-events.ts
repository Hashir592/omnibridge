/**
 * The audit event catalogue (AUD-2): every kind of event the audit log can hold, what it is
 * about, and which fields its before/after values may carry. A field that is not listed can never
 * be written (AUD-3), so buyer PII cannot reach the log by accident. Later modules write these
 * events through the audit writer in packages/db; a new kind of event is added here first.
 */
export interface AuditEventSpec {
  /** What the event is about, e.g. `channel_account`; stored as the entity type. */
  readonly entityType: string;
  /** The only before/after fields allowed; never a buyer field (AUD-3). */
  readonly fields: readonly string[];
  /** The user must type a reason (AUD-1), e.g. unlocking a filed VAT quarter (VQ-3). */
  readonly reasonRequired: boolean;
  /** A finance event (AUD-3): kept 6 years. Everything is kept 6 years today (PRD default). */
  readonly finance: boolean;
}

function spec(
  entityType: string,
  fields: readonly string[],
  extra: Partial<Pick<AuditEventSpec, 'reasonRequired' | 'finance'>> = {},
): AuditEventSpec {
  return {
    entityType,
    fields,
    reasonRequired: extra.reasonRequired ?? false,
    finance: extra.finance ?? false,
  };
}

const FINANCE_FIELDS = [
  'company_id',
  'category',
  'date',
  'net_pence',
  'vat_pence',
  'gross_pence',
  'vat_rate_bp',
] as const;

export const AUDIT_EVENTS = {
  // Sign-in and MFA (USR-4, USR-5, USR-6), written by T-0203.
  'auth.login': spec('user', []),
  'auth.login_failed': spec('user', ['failure']),
  'auth.locked': spec('user', ['locked_until']),
  'auth.signed_out_everywhere': spec('user', []),
  'mfa.enrolled': spec('user', []),
  'mfa.reset': spec('user', []),
  'mfa.recovery_codes_regenerated': spec('user', []),
  // Users and permissions (USR-1, USR-8, PERM-1 to PERM-7), written by T-0204.
  'user.invited': spec('invite', ['role', 'tabs', 'company_ids', 'expires_at']),
  'user.joined': spec('membership', ['role']),
  'user.removed': spec('membership', ['role']),
  'user.role_changed': spec('membership', ['role']),
  'user.permissions_changed': spec('membership', ['tabs', 'company_ids']),
  'user.access_review_completed': spec('membership', []),
  // Channel and carrier connections (M07, M12).
  'connection.added': spec('channel_account', ['provider', 'company_id', 'display_name']),
  'connection.removed': spec('channel_account', ['provider', 'company_id', 'display_name']),
  'connection.reauthorised': spec('channel_account', ['provider', 'expires_at']),
  // The platform console (PLAT-2, T-0504): a platform admin changed the workspace.
  'workspace.status_changed': spec('workspace', ['status']),
  'workspace.module_changed': spec('workspace', ['module', 'enabled']),
  // Kill switch (invariant 13).
  // SAFE-2 (T-0702): one account's automated writes paused or resumed.
  'kill_switch.changed': spec('channel_account', ['paused']),
  // Stock (INV-4): a manual adjustment needs a reason.
  'stock.adjusted': spec('master_sku', ['delta', 'on_hand_after', 'reason_code'], {
    reasonRequired: true,
  }),
  // Catalogue and COGS (T-0801). A SKU's create and edit, its VAT-type history (CAT-2) and
  // COGS (CAT-4); a VAT rate (admins); a listing's mapping (CAT-5); a CSV import, as one row.
  'catalogue.changed': spec('master_sku', [
    'sku',
    'title',
    'status',
    'active',
    'bundle_component_id',
    'pack_size',
    'vat_type',
    'vat_effective_from',
  ]),
  'cogs.changed': spec('master_sku', ['cogs_pence', 'effective_from']),
  'vat_rate.created': spec('vat_rate', ['vat_type', 'rate_bp', 'effective_from']),
  'listing.mapped': spec('listing', ['master_sku_id', 'source']),
  'listing.unmapped': spec('listing', ['master_sku_id']),
  'catalogue.imported': spec('catalogue_import', ['kind', 'row_count']),
  // Finance (M16, M17): every create, edit and delete; moving a cost to another company needs a
  // reason (EXP-4).
  'finance.created': spec('finance_record', FINANCE_FIELDS, { finance: true }),
  'finance.edited': spec('finance_record', FINANCE_FIELDS, { finance: true }),
  'finance.deleted': spec('finance_record', FINANCE_FIELDS, { finance: true }),
  'finance.company_moved': spec('finance_record', ['company_id'], {
    finance: true,
    reasonRequired: true,
  }),
  // Intercompany transfers (ICT-4): edit and delete need a typed reason.
  'intercompany.edited': spec(
    'intercompany_transfer',
    ['from_company_id', 'to_company_id', 'date', 'net_pence', 'vat_pence', 'version'],
    { finance: true, reasonRequired: true },
  ),
  'intercompany.deleted': spec('intercompany_transfer', ['version'], {
    finance: true,
    reasonRequired: true,
  }),
  // VAT quarters (VQ-3): unlocking needs a reason.
  'vat_quarter.locked': spec('vat_quarter', ['company_id', 'period'], { finance: true }),
  'vat_quarter.unlocked': spec('vat_quarter', ['company_id', 'period'], {
    finance: true,
    reasonRequired: true,
  }),
  // Exports, including the audit log's own (AUD-4).
  'export.created': spec('export', ['kind', 'row_count']),
  'audit_log.exported': spec('audit_log', [
    'user_id',
    'action',
    'entity_type',
    'entity_id',
    'from',
    'to',
    'row_count',
  ]),
  // Deletions run by the deletion service (invariant 8).
  'deletion.run': spec('deletion_request', ['kind', 'row_count']),
  // Amazon Ads changes (M15).
  'ads.changed': spec('ad_entity', ['kind', 'state', 'bid_pence', 'budget_pence']),
} as const satisfies Record<string, AuditEventSpec>;

export type AuditAction = keyof typeof AUDIT_EVENTS;

export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as [AuditAction, ...AuditAction[]];

/** Every entity type of the catalogue, once each. */
export const AUDIT_ENTITY_TYPES = [
  ...new Set(Object.values(AUDIT_EVENTS).map((event: AuditEventSpec) => event.entityType)),
] as [string, ...string[]];

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_EVENTS, value);
}

/** A before/after value: a scalar, or a list of scalars (e.g. ticked tabs). */
export type AuditValue = string | number | boolean | null | (string | number)[];

export type AuditValues = Record<string, AuditValue>;

/** A before/after value the catalogue does not allow; the event is refused, never trimmed. */
export class AuditValueRejected extends Error {
  constructor(action: string, field: string, why: string) {
    super(`Audit event ${action}: field "${field}" ${why}`);
    this.name = 'AuditValueRejected';
  }
}

/** The prefix of synthetic PII in fixtures; the marker scan looks for it (AT-9). */
export const PII_MARKER = 'PIIMARK-';

const MAX_TEXT = 500;

function checkValue(action: string, field: string, value: unknown): AuditValue {
  const scalar = (v: unknown): v is string | number | boolean | null =>
    v === null || typeof v === 'string' || typeof v === 'boolean' || Number.isFinite(v);
  const text = (v: unknown) => (typeof v === 'string' ? [v] : []);
  let values: unknown[];
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string' || Number.isFinite(v))) {
      throw new AuditValueRejected(action, field, 'must be a list of strings or numbers');
    }
    values = value;
  } else if (scalar(value)) {
    values = [value];
  } else {
    throw new AuditValueRejected(action, field, 'must be a scalar or a list of scalars');
  }
  for (const s of values.flatMap(text)) {
    if (s.length > MAX_TEXT) throw new AuditValueRejected(action, field, 'is too long');
    if (s.includes(PII_MARKER)) throw new AuditValueRejected(action, field, 'carries PII');
  }
  return value as AuditValue;
}

/**
 * The before/after pair to store for an event (AUD-1, AUD-3): only the catalogue's fields for
 * this action, and of those only the ones that changed. Every field given must be in the
 * catalogue: an unknown field (say a buyer's name) throws, it is never silently dropped. A create
 * passes `before` null, a delete `after` null.
 */
export function auditDiff(
  action: AuditAction,
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): { before: AuditValues | null; after: AuditValues | null } {
  const allowed: readonly string[] = AUDIT_EVENTS[action].fields;
  const check = (values: Readonly<Record<string, unknown>> | null) => {
    if (values === null) return null;
    const out: Record<string, AuditValue> = {};
    for (const [field, value] of Object.entries(values)) {
      if (!allowed.includes(field)) {
        throw new AuditValueRejected(action, field, 'is not in the audit catalogue');
      }
      if (value !== undefined) out[field] = checkValue(action, field, value);
    }
    return out;
  };
  const b = check(before);
  const a = check(after);
  if (b === null || a === null) return { before: b, after: a };
  const same = (x: AuditValue | undefined, y: AuditValue | undefined) =>
    JSON.stringify(x) === JSON.stringify(y);
  const changed = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(
    (field) => !same(b[field], a[field]),
  );
  const pick = (values: Record<string, AuditValue>) =>
    Object.fromEntries(changed.filter((f) => f in values).map((f) => [f, values[f] ?? null]));
  return { before: pick(b), after: pick(a) };
}
