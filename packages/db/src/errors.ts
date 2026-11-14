/** A workspace limit (TEN-10) is set and already reached. */
export class WorkspaceLimitReached extends Error {
  readonly limit: 'max_channel_accounts' | 'max_users';

  constructor(limit: 'max_channel_accounts' | 'max_users') {
    super(`Workspace limit reached: ${limit}`);
    this.name = 'WorkspaceLimitReached';
    this.limit = limit;
  }
}

/** A channel account with orders cannot move to another company (TEN-3); archive it instead. */
export class ChannelAccountCompanyLocked extends Error {
  constructor() {
    super('A channel account with orders cannot move to another company; archive it instead');
    this.name = 'ChannelAccountCompanyLocked';
  }
}

/** The last admin of a workspace cannot be removed or demoted (PERM-7). */
export class LastAdmin extends Error {
  constructor() {
    super('The last admin of a workspace cannot be removed or demoted');
    this.name = 'LastAdmin';
  }
}

/** The SQLSTATE of a PostgreSQL error, as raised through pg. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/** Turns the tenancy triggers' own SQLSTATEs (migration 0007) into typed errors. */
export function tenancyError(err: unknown): unknown {
  const code = pgCode(err);
  if (code === 'OBL01') {
    const message = err instanceof Error ? err.message : '';
    return new WorkspaceLimitReached(
      message.includes('max_users') ? 'max_users' : 'max_channel_accounts',
    );
  }
  if (code === 'OBC01') return new ChannelAccountCompanyLocked();
  if (code === 'OBA01') return new LastAdmin();
  return err;
}

/** Runs `fn`, turning the tenancy triggers' errors into typed ones. */
export async function mapTenancyErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw tenancyError(err);
  }
}
