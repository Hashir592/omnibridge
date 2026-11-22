import type { AuditValues, ErasureState, ErasureWithdrawReason } from '@omnibridge/core';
import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely types for db-main, written by hand until kysely-codegen is wired in. bigint columns come
 * back from pg as strings, so they are read as string and written as number.
 */
type BigIntColumn = ColumnType<string, number, number>;

export interface DataKeysTable {
  workspace_id: string;
  version: BigIntColumn;
  kek_version: BigIntColumn;
  wrapped_key: Buffer;
  created_at: Generated<Date>;
  rewrapped_at: Date | null;
}

export interface CredentialsTable {
  id: string;
  workspace_id: string;
  kind: string;
  channel_account_id: string | null;
  slot: 'current' | 'next';
  /** INT-3: mock, sandbox or live (db-main 0037). */
  environment: ColumnType<
    'mock' | 'sandbox' | 'live',
    'mock' | 'sandbox' | 'live' | undefined,
    never
  >;
  encrypted_value: Buffer;
  key_version: BigIntColumn;
  is_active: Generated<boolean>;
  expires_at: Date | null;
  rotated_at: Date | null;
  /** When the purge hard-deletes a retired row (migration 0005). */
  delete_after: Date | null;
  created_at: Generated<Date>;
}

export interface JobRecordsTable {
  id: string;
  workspace_id: string;
  /** The one company a job belongs to (F-M02e-03); null for workspace-wide jobs. */
  company_id: ColumnType<string | null, string | null | undefined, never>;
  type: string;
  idempotency_key: string;
  state: ColumnType<
    'queued' | 'active' | 'retrying' | 'completed' | 'failed',
    'queued' | undefined,
    'queued' | 'active' | 'retrying' | 'completed' | 'failed'
  >;
  /** bigint columns with a default: read as string, written as number. */
  attempt: ColumnType<string, number | undefined, number>;
  percent: ColumnType<string, number | undefined, number>;
  result: ColumnType<unknown, string | null, string | null> | null;
  error_code: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface JobLeasesTable {
  workspace_id: string;
  scope_key: string;
  slot: ColumnType<string, number, number>;
  holder: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
}

export interface FilesTable {
  id: string;
  workspace_id: string;
  content_type: 'application/pdf' | 'image/png' | 'image/jpeg';
  size_bytes: ColumnType<string, number, number>;
  key_version: ColumnType<string, number, number>;
  state: ColumnType<
    'scanning' | 'clean' | 'infected' | 'scan_failed',
    'scanning' | undefined,
    'scanning' | 'clean' | 'infected' | 'scan_failed'
  >;
  scanned_at: Date | null;
  delete_after: Date | null;
  created_at: Generated<Date>;
}

/** bigint columns that may be null: read as string or null, written as number or null. */
type NullableBigInt = ColumnType<string | null, number | null | undefined, number | null>;
type NullableTime = ColumnType<Date | null, Date | null | undefined, Date | null>;

export interface WorkspacesTable {
  id: string;
  name: string;
  plan: Generated<'free_internal'>;
  max_channel_accounts: NullableBigInt;
  max_users: NullableBigInt;
  timezone: Generated<string>;
  currency: Generated<'GBP'>;
  default_vat_rate_bp: ColumnType<string, number | undefined, number>;
  /** Fixed at 25 and never written (TEN-6). */
  pii_retention_days: ColumnType<string, never, never>;
  /** Module toggles (0019): written only by app.workspace_set_module. */
  modules: ColumnType<Readonly<Record<string, unknown>>, never, never>;
  /** PLAT-2 (0033): written only by app.console_workspace_status. */
  status: ColumnType<'active' | 'suspended' | 'archived', never, never>;
  status_changed_at: ColumnType<Date | null, never, never>;
  created_at: Generated<Date>;
}

/**
 * API calls per account, provider, API and the provider's own day (0033, PLAT-2): the table M07's
 * governors reserve against (`calls + n <= cap` in one UPDATE).
 */
export interface ApiUsageDailyTable {
  workspace_id: string;
  channel_account_id: string;
  provider: 'amazon' | 'amazon_ads' | 'ebay' | 'website' | 'evri' | 'dpd';
  api: string;
  day: ColumnType<string, string, never>;
  calls: ColumnType<string, number | undefined, number>;
  cap: ColumnType<string | null, number | null | undefined, number | null>;
  updated_at: Date;
}

export type VatPeriod = 'stagger_1' | 'stagger_2' | 'stagger_3' | 'monthly';

export interface CompaniesTable {
  id: string;
  workspace_id: string;
  legal_name: string;
  trading_name: string;
  company_number: string | null;
  vat_number: string | null;
  address_line1: string;
  address_line2: string | null;
  address_city: string;
  address_postcode: string;
  address_country: Generated<string>;
  vat_period: Generated<VatPeriod>;
  /** Left out on insert: filled by the companies_first_defaults trigger (TEN-2). */
  is_fulfilment_provider: Generated<boolean>;
  is_purchasing_company: Generated<boolean>;
  badge_colour: Generated<string>;
  created_at: Generated<Date>;
}

export type ChannelProvider = 'amazon' | 'amazon_ads' | 'ebay' | 'website' | 'evri' | 'dpd';

export interface ChannelAccountsTable {
  id: string;
  workspace_id: string;
  company_id: string;
  provider: ChannelProvider;
  display_name: string;
  orders_seen_at: NullableTime;
  archived_at: NullableTime;
  created_at: Generated<Date>;
  /** Connection health (db-main 0037, INT-4, AMZ-12). */
  last_success_at: Date | null;
  last_token_refresh_at: Date | null;
  auth_failures: ColumnType<string, number | undefined, number>;
  auth_failure_times: ColumnType<Date[], Date[] | undefined, Date[]>;
  needs_reauth_at: Date | null;
  /** FA-16 (db-main 0048): stock writes held until the first clean reconciliation. */
  stock_push_held_since: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_error_code: string | null;
  last_error_at: Date | null;
  /** SAFE-2: set while the account's automated writes are paused. */
  paused_at: Date | null;
}

export interface SyncCursorsTable {
  workspace_id: string;
  channel_account_id: string;
  stream: string;
  cursor_at: Date | null;
  overlap: ColumnType<{ id: string; at: string }[], string | undefined, string>;
  resume: ColumnType<
    { since: string; page: string; maxAt: string | null } | null,
    string | null | undefined,
    string | null
  >;
  last_run_at: Date | null;
  last_success_at: Date | null;
  updated_at: Date;
}

export interface OAuthStatesTable {
  workspace_id: string;
  state_hash: Buffer;
  channel_account_id: string;
  user_id: string;
  provider: 'amazon' | 'amazon_ads' | 'ebay';
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
}

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  /** Never written by ob_app (column grants, migration 0007). */
  platform_admin: ColumnType<boolean, never, never>;
  created_at: Generated<Date>;
}

export type MembershipRole = 'admin' | 'member';

export interface MembershipsTable {
  workspace_id: string;
  user_id: string;
  role: MembershipRole;
  created_at: Generated<Date>;
}

export interface MembershipTabsTable {
  workspace_id: string;
  user_id: string;
  tab: string;
}

export interface MembershipCompaniesTable {
  workspace_id: string;
  user_id: string;
  company_id: string;
}

/** Revoked or accepted, never deleted (migration 0015); only the token hash and revoke change. */
export interface InvitesTable {
  workspace_id: string;
  id: string;
  email: string;
  role: MembershipRole;
  tabs: string[];
  company_ids: string[];
  invited_by: string | null;
  token_hash: Buffer | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: ColumnType<Date | null, never, never>;
  accepted_by: ColumnType<string | null, never, never>;
  revoked_at: Date | null;
}

export interface AccessReviewsTable {
  workspace_id: string;
  id: string;
  due_at: Date;
  created_at: Date;
  completed_at: Date | null;
  completed_by: string | null;
}

export type AuditActorKind = 'user' | 'system' | 'platform';

/** Append-only (migration 0010): ob_app inserts and reads, and never sets the id or time. */
export interface AuditEventsTable {
  id: Generated<string>;
  workspace_id: string;
  occurred_at: ColumnType<Date, never, never>;
  actor_kind: AuditActorKind;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  /** jsonb: written as JSON text, read as an object. */
  before: ColumnType<AuditValues | null, string | null, never>;
  after: ColumnType<AuditValues | null, string | null, never>;
  reason: string | null;
  ip: ColumnType<string | null, string | null, never>;
}

/** app.deletion_runs (T-0403, DEL-3): counts and IDs only. */
export interface DeletionRunsTable {
  workspace_id: string;
  id: string;
  trigger: string;
  scope_type: string;
  /** jsonb of IDs: written as JSON text, read as an object. */
  scope: ColumnType<unknown, string, never>;
  channel_account_id: string | null;
  /** bigint: read as string. */
  records_deleted: ColumnType<string, number, never>;
  result: 'done';
  started_at: ColumnType<Date, Date, never>;
  finished_at: ColumnType<Date, Date, never>;
}

/** app.erasure_requests (T-0404, DEL-4): the refs a search found, never the identifiers. */
export interface ErasureRequestsTable {
  workspace_id: string;
  id: string;
  requested_by: string;
  requested_at: ColumnType<Date, Date, never>;
  due_at: ColumnType<Date, Date, never>;
  pii_refs: ColumnType<string[], string[], never>;
  state: ErasureState;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  job_id: string | null;
  withdrawn_by: string | null;
  withdrawn_at: Date | null;
  withdraw_reason: ErasureWithdrawReason | null;
  /** A-006 (ADR-069): set from the deletion job's outcome. */
  completed_at: Date | null;
  failed_at: Date | null;
  retry_count: ColumnType<string, number | undefined, number>;
}

/** app.pii_tombstones (T-0403, invariant 10): the db-main copy, IDs only. */
export interface PiiTombstonesTable {
  workspace_id: string;
  pii_ref: string;
  run_id: string;
  channel_account_id: string | null;
  deleted_at: ColumnType<Date, Date, never>;
}

/** app.notifications (T-0501, NTF-1): IDs, counts and codes only. Written by raw SQL upserts. */
export interface NotificationsTable {
  workspace_id: string;
  id: string;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  signal: 'native' | 'derived' | 'estimate' | null;
  tab: string;
  company_id: string | null;
  channel_account_id: string | null;
  record_kind: string;
  record_id: string;
  params: ColumnType<unknown, string, string>;
  created_at: ColumnType<Date, Date, never>;
  updated_at: Date;
  resolved_at: Date | null;
  version: ColumnType<string, number | undefined, number>;
}

export interface OutboundWritesTable {
  workspace_id: string;
  id: string;
  channel_account_id: string;
  provider: ChannelProvider;
  operation: string;
  urgent: Generated<boolean>;
  idempotency_key: string;
  payload: ColumnType<Record<string, unknown>, string, string>;
  state: ColumnType<
    'pending' | 'sending' | 'sent' | 'failed' | 'cancelled',
    'pending' | undefined,
    'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
  >;
  paused_reason: 'kill_switch' | 'maintenance' | null;
  attempts: ColumnType<string, number | undefined, number>;
  dispatch_seq: ColumnType<string, number | undefined, number>;
  next_attempt_at: Date | null;
  claimed_at: Date | null;
  last_error_code: string | null;
  result: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
}

export interface BulkConfirmationsTable {
  workspace_id: string;
  token_hash: Buffer;
  user_id: string;
  action: 'stock_push' | 'tracking_resend' | 'ads_change';
  account_ids: string[];
  params: ColumnType<Record<string, string | number | boolean | string[]>, string, string>;
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
}

export interface AmazonRateBucketsTable {
  workspace_id: string;
  channel_account_id: string;
  operation: string;
  rate: number;
  burst: number;
  tokens: number;
  refilled_at: Date;
}

export type VatType = 'standard' | 'reduced' | 'zero' | 'no_vat';
export type ListingProvider = 'amazon' | 'ebay' | 'website';
/** A calendar day: written as 'YYYY-MM-DD', read back with to_char (no time-zone shift). */
type DayColumn = ColumnType<Date, string, string>;
type OptionalBigInt = ColumnType<string | null, number | null | undefined, number | null>;

export interface MasterSkusTable {
  workspace_id: string;
  id: string;
  sku: string;
  title: string;
  short_description: string;
  barcode: string | null;
  manufacturer: string | null;
  weight_g: ColumnType<string, number | undefined, number>;
  length_mm: OptionalBigInt;
  width_mm: OptionalBigInt;
  height_mm: OptionalBigInt;
  image_url: string | null;
  purchase_vat_rate_bp: OptionalBigInt;
  active: Generated<boolean>;
  lead_time_days: ColumnType<string, number | undefined, number>;
  safety_days: ColumnType<string, number | undefined, number>;
  target_cover_days: ColumnType<string, number | undefined, number>;
  bundle_component_id: string | null;
  pack_size: OptionalBigInt;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SkuVatTypesTable {
  workspace_id: string;
  master_sku_id: string;
  vat_type: VatType;
  effective_from: DayColumn;
  created_by: string | null;
  created_at: Date;
}

export interface VatRatesTable {
  workspace_id: string;
  vat_type: VatType;
  effective_from: DayColumn;
  rate_bp: BigIntColumn;
  created_at: Date;
}

export interface CogsHistoryTable {
  workspace_id: string;
  master_sku_id: string;
  effective_from: DayColumn;
  cogs_pence: BigIntColumn;
  created_by: string | null;
  created_at: Date;
}

export interface ListingsTable {
  workspace_id: string;
  id: string;
  /** INT-6 origin tag; for a listing it is the provider. */
  origin: ListingProvider;
  channel_account_id: string;
  provider: ListingProvider;
  external_sku: string;
  external_id: string;
  title: string | null;
  fulfilment: 'mfn' | 'fba' | null;
  inventory_api: boolean | null;
  channel_qty: OptionalBigInt;
  master_sku_id: string | null;
  mapping_source: 'auto' | 'manual' | null;
  mapped_at: Date | null;
  mapped_by: string | null;
  discovered_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  updated_at: Date;
}

export interface MainDb {
  'app.workspaces': WorkspacesTable;
  'app.companies': CompaniesTable;
  'app.channel_accounts': ChannelAccountsTable;
  'app.users': UsersTable;
  'app.memberships': MembershipsTable;
  'app.data_keys': DataKeysTable;
  'app.credentials': CredentialsTable;
  'app.job_records': JobRecordsTable;
  'app.job_leases': JobLeasesTable;
  'app.files': FilesTable;
  'app.audit_events': AuditEventsTable;
  'app.membership_tabs': MembershipTabsTable;
  'app.membership_companies': MembershipCompaniesTable;
  'app.invites': InvitesTable;
  'app.access_reviews': AccessReviewsTable;
  'app.deletion_runs': DeletionRunsTable;
  'app.pii_tombstones': PiiTombstonesTable;
  'app.erasure_requests': ErasureRequestsTable;
  'app.notifications': NotificationsTable;
  'app.api_usage_daily': ApiUsageDailyTable;
  'app.sync_cursors': SyncCursorsTable;
  'app.oauth_states': OAuthStatesTable;
  'app.outbound_writes': OutboundWritesTable;
  'app.bulk_confirmations': BulkConfirmationsTable;
  'app.amazon_rate_buckets': AmazonRateBucketsTable;
  'app.master_skus': MasterSkusTable;
  'app.sku_vat_types': SkuVatTypesTable;
  'app.vat_rates': VatRatesTable;
  'app.cogs_history': CogsHistoryTable;
  'app.listings': ListingsTable;
}
