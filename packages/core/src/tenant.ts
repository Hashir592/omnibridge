/**
 * Who a repository call acts for (ARCHITECTURE.md §5 invariant 3). Every repository function takes
 * one, and runs inside a transaction that has run `SET LOCAL` for it, so row-level security limits
 * every statement to this workspace and these companies.
 */
export interface TenantContext {
  readonly workspaceId: string;
  /**
   * The companies in scope (`app.company_ids`). Always an explicit list, never "all": a bug or a
   * stray setting can then only show fewer rows (S1, 20 Oct 2026). Empty means no company rows.
   */
  readonly companyIds: readonly string[];
  /** The signed-in user (`app.user_id`), when there is one; a user can always see themselves. */
  readonly userId?: string;
}

/** Whom a tenant transaction is opened for, before its company list is known. */
export interface TenantActor {
  readonly workspaceId: string;
  readonly userId?: string;
}

/**
 * Opens one tenant transaction (invariant 3) and hands `fn` a context bound to it: every
 * repository call made with that context runs in that same transaction. Implemented by
 * packages/db `Tenancy`.
 */
export interface TenantRunner {
  /**
   * With every company of the workspace in scope: workspace admins and workspace-wide jobs. The
   * list comes from the database (`app.workspace_company_ids()`), never from a wildcard.
   */
  runWorkspace<T>(actor: TenantActor, fn: (ctx: TenantContext) => Promise<T>): Promise<T>;
  /** With exactly the context given, e.g. a workspace that is being created. */
  run<T>(ctx: TenantContext, fn: (ctx: TenantContext) => Promise<T>): Promise<T>;
}

/** A signed-in workspace user, as the session check resolves them (T-0203 builds the real one). */
export interface SessionActor {
  readonly workspaceId: string;
  readonly userId: string;
  /** Binds signed file links to the session (NFR-5). */
  readonly sessionId: string;
}

/**
 * A person part-way through sign-in (T-0203, ADR-048): `pre-mfa` after the password, before MFA;
 * `signed-in` after MFA, before a workspace is chosen (or while choosing another).
 */
export interface AccountActor {
  readonly userId: string;
  readonly sessionId: string;
}

/** A platform operator (PLAT-1). They see no tenant business data (PLAT-3). */
export interface PlatformActor {
  readonly userId: string;
}
