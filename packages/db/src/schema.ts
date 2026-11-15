import type { AuditValues } from '@omnibridge/core';
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
  created_at: Generated<Date>;
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

export type ChannelProvider = 'amazon' | 'amazon_ads' | 'ebay' | 'website';

export interface ChannelAccountsTable {
  id: string;
  workspace_id: string;
  company_id: string;
  provider: ChannelProvider;
  display_name: string;
  orders_seen_at: NullableTime;
  archived_at: NullableTime;
  created_at: Generated<Date>;
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
}
