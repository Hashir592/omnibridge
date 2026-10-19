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

export interface MainDb {
  'app.data_keys': DataKeysTable;
  'app.credentials': CredentialsTable;
  'app.job_records': JobRecordsTable;
  'app.job_leases': JobLeasesTable;
}
