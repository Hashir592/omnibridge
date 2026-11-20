import { createHash, randomBytes } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/**
 * Sign-in, MFA, lockout, sessions and password resets (T-0203, migration 0011).
 *
 * The one place that takes no TenantContext: sign-in happens before any workspace exists for the
 * request. Every call is one narrow SECURITY DEFINER function owned by ob_owner that acts on the
 * one user, token or counter key it is given; ob_app holds no grant on the tables themselves.
 * Times come from the caller's clock.
 */
export type SessionStage = 'pre_mfa' | 'signed_in' | 'password_change' | 'workspace' | 'platform';

export interface LoginAccount {
  userId: string;
  name: string;
  email: string;
  passwordHash: string;
  passwordSetAt: Date;
  mfaConfirmed: boolean;
  platformAdmin: boolean;
}

export interface AuthUser {
  userId: string;
  name: string;
  email: string;
  /** Null for a user who has no password yet (an invite not accepted). */
  passwordSetAt: Date | null;
  mfaConfirmed: boolean;
  platformAdmin: boolean;
}

export interface StoredSession {
  id: string;
  userId: string;
  stage: SessionStage;
  workspaceId: string | null;
  csrfHash: Buffer;
  signedInAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface MfaState {
  secret: Buffer | null;
  keyVersion: number | null;
  lastStep: number | null;
  pending: Buffer | null;
  pendingKeyVersion: number | null;
}

/**
 * On a new lock of a known user: send the notice, or not, because one went to them in the last
 * 24 hours or the platform sent 100 today (S5-20261117-03).
 */
export type LockNotice = 'send' | 'recent' | 'platform_capped';

/** A reset request: a mail may go, an email or address cap, or the platform-wide cap. */
export type ResetVerdict = 'ok' | 'capped' | 'global_capped';

export interface FailureResult {
  lockedUntil: Date | null;
  /** True only on the failure that started the lock (USR-5). */
  newlyLocked: boolean;
  ipBlockedUntil: Date | null;
  /** Set only when newly locked with a known user. */
  notice: LockNotice | null;
}

export interface WorkspaceChoiceRow {
  id: string;
  name: string;
  role: 'admin' | 'member';
  companies: number;
  /** Module toggles (PLAT-2, ADR-059): a module the workspace has no setting for is off. */
  modules: { website_connector: boolean };
}

export interface PlatformKeyRow {
  version: number;
  kekVersion: number;
  wrapped: Buffer;
}

const n = (v: string | number | null): number | null => (v === null ? null : Number(v));

export class AuthStore {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async loginLookup(email: string): Promise<LoginAccount | undefined> {
    const { rows } = await sql<{
      user_id: string;
      name: string;
      email: string;
      password_hash: string;
      password_set_at: Date;
      mfa_confirmed: boolean;
      platform_admin: boolean;
    }>`SELECT * FROM app.auth_login_lookup(${email})`.execute(this.#db);
    const r = rows[0];
    return r === undefined
      ? undefined
      : {
          userId: r.user_id,
          name: r.name,
          email: r.email,
          passwordHash: r.password_hash,
          passwordSetAt: r.password_set_at,
          mfaConfirmed: r.mfa_confirmed,
          platformAdmin: r.platform_admin,
        };
  }

  async user(userId: string): Promise<AuthUser | undefined> {
    const { rows } = await sql<{
      user_id: string;
      name: string;
      email: string;
      password_set_at: Date | null;
      mfa_confirmed: boolean;
      platform_admin: boolean;
    }>`SELECT * FROM app.auth_user(${userId}::uuid)`.execute(this.#db);
    const r = rows[0];
    return r === undefined
      ? undefined
      : {
          userId: r.user_id,
          name: r.name,
          email: r.email,
          passwordSetAt: r.password_set_at,
          mfaConfirmed: r.mfa_confirmed,
          platformAdmin: r.platform_admin,
        };
  }

  async lockState(
    key: Buffer,
    ip: string,
    now: Date,
  ): Promise<{ lockedUntil: Date | null; ipBlockedUntil: Date | null }> {
    const { rows } = await sql<{ locked_until: Date | null; ip_blocked_until: Date | null }>`
      SELECT * FROM app.auth_lock_state(${key}, ${ip}::inet, ${now})`.execute(this.#db);
    return {
      lockedUntil: rows[0]?.locked_until ?? null,
      ipBlockedUntil: rows[0]?.ip_blocked_until ?? null,
    };
  }

  /**
   * Records one failed sign-in (USR-5). With `who` (the email has an account) the
   * auth.login_failed row, and on a new lock auth.locked and the notice decision, are written in
   * the same call, so a real and an unknown email make the same database calls (S5-20261117-02).
   */
  async recordFailure(
    key: Buffer,
    ip: string,
    now: Date,
    who?: { userId: string; failure: string },
  ): Promise<FailureResult> {
    const { rows } = await sql<{
      locked_until: Date | null;
      newly_locked: boolean;
      ip_blocked_until: Date | null;
      notice: LockNotice | null;
    }>`SELECT * FROM app.auth_record_failure(${key}, ${ip}::inet, ${now},
         ${who?.userId ?? null}::uuid, ${who?.failure ?? null}::text)`.execute(this.#db);
    return {
      lockedUntil: rows[0]?.locked_until ?? null,
      newlyLocked: rows[0]?.newly_locked ?? false,
      ipBlockedUntil: rows[0]?.ip_blocked_until ?? null,
      notice: rows[0]?.notice ?? null,
    };
  }

  /** An open invite by its token hash, for the accept page (USR-1, TEN-7). */
  async findInvite(
    tokenHash: Buffer,
    now: Date,
  ): Promise<
    | {
        id: string;
        workspaceId: string;
        workspaceName: string;
        email: string;
        role: 'admin' | 'member';
        userExists: boolean;
        invitedBy: string;
        expiresAt: Date;
      }
    | undefined
  > {
    const { rows } = await sql<{
      id: string;
      workspace_id: string;
      workspace_name: string;
      email: string;
      role: 'admin' | 'member';
      user_exists: boolean;
      invited_by_name: string | null;
      expires_at: Date;
    }>`SELECT * FROM app.invite_find(${tokenHash}, ${now})`.execute(this.#db);
    const r = rows[0];
    return r === undefined
      ? undefined
      : {
          id: r.id,
          workspaceId: r.workspace_id,
          workspaceName: r.workspace_name,
          email: r.email,
          role: r.role,
          userExists: r.user_exists,
          invitedBy: r.invited_by_name ?? 'OmniBridge',
          expiresAt: r.expires_at,
        };
  }

  /**
   * Accepts an invite once: the person joins with its role and ticks; a new user is created
   * under `newUserId`. Undefined when the link is not usable or they are already a member.
   */
  async acceptInvite(
    tokenHash: Buffer,
    newUserId: string,
    name: string,
    now: Date,
    /** True when no password was checked: only a brand-new person may join this way. */
    newOnly: boolean,
  ): Promise<{ userId: string; workspaceId: string; created: boolean } | undefined> {
    const { rows } = await sql<{ user_id: string; workspace_id: string; created: boolean }>`
      SELECT * FROM app.invite_accept(${tokenHash}, ${newUserId}::uuid, ${name}, ${now}, ${newOnly})`.execute(
      this.#db,
    );
    const r = rows[0];
    return r === undefined
      ? undefined
      : { userId: r.user_id, workspaceId: r.workspace_id, created: r.created };
  }

  /** MFA set-up and last sign-in of each member of the context's workspace (Users list). */
  async memberAuthStatus(
    ctx: TenantContext,
  ): Promise<Map<string, { mfa: boolean; lastSignInAt: Date | null }>> {
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql<{ user_id: string; mfa: boolean; last_sign_in_at: Date | null }>`
        SELECT * FROM app.member_auth_status()`.execute(trx),
    );
    return new Map(
      rows.rows.map((r) => [r.user_id, { mfa: r.mfa, lastSignInAt: r.last_sign_in_at }]),
    );
  }

  /** A failed sign-in or lockout, per person, outside any workspace (ADR-052). */
  async recordAuthEvent(event: {
    userId: string | null;
    action:
      | 'auth.login'
      | 'auth.login_failed'
      | 'auth.locked'
      | 'mfa.enrolled'
      | 'auth.signed_out_everywhere';
    ip: string;
    detail: Readonly<Record<string, unknown>>;
    now: Date;
  }): Promise<void> {
    await sql`SELECT app.auth_event_record(${event.userId}::uuid, ${event.action},
      ${event.ip}::inet, ${JSON.stringify(event.detail)}::jsonb, ${event.now})`.execute(this.#db);
  }

  /**
   * A platform admin entered the console (S5-20261121-01, ADR-076): user, time and client address
   * in the platform audit, through the 0033 definer, which re-checks the admin.
   */
  async recordConsoleEntry(userId: string, ip: string, now: Date): Promise<void> {
    await sql`SELECT app.console_audit(${userId}::uuid, 'platform.console_entered', NULL,
      '{}'::jsonb, ${ip}::inet, ${now})`.execute(this.#db);
  }

  /** Whether the user has accepted this version of the terms and privacy policy (WWW-7). */
  async termsAccepted(userId: string, version: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT app.terms_accepted(${userId}::uuid,
      ${version}) AS ok`.execute(this.#db);
    return rows[0]?.ok ?? false;
  }

  /** Records an acceptance, with its version, time and address; append-only (WWW-7). */
  async acceptTerms(userId: string, version: string, now: Date, ip: string): Promise<void> {
    await sql`SELECT app.terms_accept(${userId}::uuid, ${version}, ${now},
      ${ip}::inet)`.execute(this.#db);
  }

  /**
   * Counts one password reset request (F-M02h-05, S5-20261117-01): 3 per email and 10 per
   * address an hour, counting every request. `mail` says the email has an account a mail would
   * go to; only those use the platform-wide 100 mails a day.
   */
  async allowReset(key: Buffer, ip: string, now: Date, mail: boolean): Promise<ResetVerdict> {
    const { rows } = await sql<{ verdict: ResetVerdict }>`SELECT app.auth_reset_allow(${key},
      ${ip}::inet, ${now}, ${mail}) AS verdict`.execute(this.#db);
    return rows[0]?.verdict ?? 'capped';
  }

  async clearFailures(key: Buffer): Promise<void> {
    await sql`SELECT app.auth_clear_failures(${key})`.execute(this.#db);
  }

  async createSession(s: {
    id: string;
    tokenHash: Buffer;
    csrfHash: Buffer;
    userId: string;
    stage: SessionStage;
    now: Date;
    expiresAt: Date;
  }): Promise<void> {
    await sql`SELECT app.session_create(${s.id}::uuid, ${s.tokenHash}, ${s.csrfHash},
      ${s.userId}::uuid, ${s.stage}, ${s.now}, ${s.expiresAt})`.execute(this.#db);
  }

  async findSession(tokenHash: Buffer): Promise<StoredSession | undefined> {
    const { rows } = await sql<{
      id: string;
      user_id: string;
      stage: SessionStage;
      active_workspace: string | null;
      csrf_hash: Buffer;
      signed_in_at: Date;
      last_seen_at: Date;
      expires_at: Date;
    }>`SELECT * FROM app.session_find(${tokenHash})`.execute(this.#db);
    const r = rows[0];
    return r === undefined
      ? undefined
      : {
          id: r.id,
          userId: r.user_id,
          stage: r.stage,
          workspaceId: r.active_workspace,
          csrfHash: r.csrf_hash,
          signedInAt: r.signed_in_at,
          lastSeenAt: r.last_seen_at,
          expiresAt: r.expires_at,
        };
  }

  async touchSession(id: string, now: Date): Promise<void> {
    await sql`SELECT app.session_touch(${id}::uuid, ${now})`.execute(this.#db);
  }

  /** Moves a session on under a new token; false when it is gone or the workspace is not its. */
  async advanceSession(a: {
    id: string;
    tokenHash: Buffer;
    csrfHash: Buffer;
    stage: SessionStage;
    workspaceId: string | null;
    now: Date;
    /** Restart the absolute lifetime here (on MFA, the real sign-in). */
    signedIn: boolean;
    expiresAt: Date;
  }): Promise<boolean> {
    const { rows } = await sql<{ moved: boolean }>`
      SELECT app.session_advance(${a.id}::uuid, ${a.tokenHash}, ${a.csrfHash}, ${a.stage},
        ${a.workspaceId}::uuid, ${a.now}, ${a.signedIn}, ${a.expiresAt}) AS moved`.execute(
      this.#db,
    );
    return rows[0]?.moved === true;
  }

  async revokeSession(id: string, now: Date): Promise<void> {
    await sql`SELECT app.session_revoke(${id}::uuid, ${now})`.execute(this.#db);
  }

  async revokeUserSessions(userId: string, now: Date): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT app.session_revoke_user(${userId}::uuid, ${now}) AS n`.execute(this.#db);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Retention (F-M02h-06), worker only: deletes sessions revoked or expired more than 30 days ago
   * and reset links used or expired more than 7 days ago. The cut-offs live in the function.
   */
  async purgeExpired(): Promise<{ sessions: number; resets: number }> {
    const { rows } = await sql<{ sessions: string; resets: string }>`
      SELECT * FROM app.auth_purge()`.execute(this.#db);
    return { sessions: Number(rows[0]?.sessions ?? 0), resets: Number(rows[0]?.resets ?? 0) };
  }

  async mfa(userId: string): Promise<MfaState | undefined> {
    const { rows } = await sql<{
      secret: Buffer | null;
      key_version: string | null;
      last_step: string | null;
      pending: Buffer | null;
      pending_key_version: string | null;
    }>`SELECT * FROM app.auth_mfa_get(${userId}::uuid)`.execute(this.#db);
    const r = rows[0];
    return r === undefined
      ? undefined
      : {
          secret: r.secret,
          keyVersion: n(r.key_version),
          lastStep: n(r.last_step),
          pending: r.pending,
          pendingKeyVersion: n(r.pending_key_version),
        };
  }

  async setPendingTotp(userId: string, sealed: Buffer, keyVersion: number): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT app.auth_mfa_set_pending(${userId}::uuid, ${sealed}, ${keyVersion}) AS ok`.execute(
      this.#db,
    );
    return rows[0]?.ok === true;
  }

  async confirmTotp(
    userId: string,
    step: number,
    recoveryHmacs: readonly Buffer[],
    now: Date,
  ): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT app.auth_mfa_confirm(${userId}::uuid, ${step}, ${[...recoveryHmacs]}::bytea[],
        ${now}) AS ok`.execute(this.#db);
    return rows[0]?.ok === true;
  }

  /** Accepts this TOTP step once; false on a replay. */
  async useTotpStep(userId: string, step: number): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT app.auth_mfa_use_step(${userId}::uuid, ${step}) AS ok`.execute(this.#db);
    return rows[0]?.ok === true;
  }

  /** Uses a recovery code; the number left, or undefined when it is unknown or used. */
  async useRecoveryCode(userId: string, hmac: Buffer, now: Date): Promise<number | undefined> {
    const { rows } = await sql<{ left: string }>`
      SELECT app.auth_recovery_use(${userId}::uuid, ${hmac}, ${now}) AS left`.execute(this.#db);
    const left = Number(rows[0]?.left ?? -1);
    return left < 0 ? undefined : left;
  }

  /**
   * A brand-new person accepts an invite and gets their first password in one definer call
   * (F-M02e-04), so the invite is never used up without the password being set. Undefined, and
   * nothing changed, when the link is not usable or the email already has a sign-in.
   */
  async acceptInviteNewUser(
    tokenHash: Buffer,
    newUserId: string,
    name: string,
    now: Date,
    passwordHash: string,
  ): Promise<{ userId: string; workspaceId: string } | undefined> {
    const { rows } = await sql<{ user_id: string; workspace_id: string }>`
      SELECT user_id, workspace_id
        FROM app.invite_accept_new_user(${tokenHash}, ${newUserId}::uuid, ${name}, ${now}, ${passwordHash})`.execute(
      this.#db,
    );
    const r = rows[0];
    return r === undefined ? undefined : { userId: r.user_id, workspaceId: r.workspace_id };
  }

  async passwordHashes(userId: string): Promise<string[]> {
    const { rows } = await sql<{ h: string }>`
      SELECT h FROM app.auth_password_hashes(${userId}::uuid) AS h`.execute(this.#db);
    return rows.map((r) => r.h);
  }

  async setPassword(userId: string, hash: string, now: Date): Promise<void> {
    await sql`SELECT app.auth_password_set(${userId}::uuid, ${hash}, ${now})`.execute(this.#db);
  }

  async createReset(tokenHash: Buffer, userId: string, now: Date, expiresAt: Date): Promise<void> {
    await sql`SELECT app.auth_reset_create(${tokenHash}, ${userId}::uuid, ${now}, ${expiresAt})`.execute(
      this.#db,
    );
  }

  async findReset(
    tokenHash: Buffer,
    now: Date,
  ): Promise<{ userId: string; expiresAt: Date } | undefined> {
    const { rows } = await sql<{ user_id: string; expires_at: Date }>`
      SELECT * FROM app.auth_reset_find(${tokenHash}, ${now})`.execute(this.#db);
    const r = rows[0];
    return r === undefined ? undefined : { userId: r.user_id, expiresAt: r.expires_at };
  }

  /**
   * Uses a reset link and sets the new password in one transaction, ending every session of the
   * user: either all of it happens or none. Returns the user, or undefined when the link is no
   * longer usable.
   */
  async resetPassword(tokenHash: Buffer, now: Date, newHash: string): Promise<string | undefined> {
    return this.#db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ who: string | null }>`
        SELECT app.auth_reset_consume(${tokenHash}, ${now}) AS who`.execute(trx);
      const who = rows[0]?.who ?? null;
      if (who === null) return undefined;
      await sql`SELECT app.auth_password_set(${who}::uuid, ${newHash}, ${now})`.execute(trx);
      await sql`SELECT app.session_revoke_user(${who}::uuid, ${now})`.execute(trx);
      return who;
    });
  }

  async userWorkspaces(userId: string): Promise<WorkspaceChoiceRow[]> {
    const { rows } = await sql<{
      id: string;
      name: string;
      role: 'admin' | 'member';
      companies: string;
      modules: Readonly<Record<string, unknown>>;
    }>`SELECT * FROM app.auth_user_workspaces_modules(${userId}::uuid)`.execute(this.#db);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      companies: Number(r.companies),
      modules: { website_connector: r.modules.website_connector === true },
    }));
  }

  /** The platform data keys, newest first; one version when `version` is given. */
  async platformKeys(version?: number): Promise<PlatformKeyRow[]> {
    const { rows } = await sql<{ version: string; kek_version: string; wrapped_key: Buffer }>`
      SELECT * FROM app.platform_key_get(${version ?? null}::bigint)`.execute(this.#db);
    return rows.map((r) => ({
      version: Number(r.version),
      kekVersion: Number(r.kek_version),
      wrapped: r.wrapped_key,
    }));
  }

  async insertPlatformKey(row: PlatformKeyRow): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT app.platform_key_insert(${row.version}, ${row.kekVersion}, ${row.wrapped}) AS ok`.execute(
      this.#db,
    );
    return rows[0]?.ok === true;
  }

  async rewrapPlatformKey(row: PlatformKeyRow): Promise<void> {
    await sql`SELECT app.platform_key_rewrap(${row.version}, ${row.kekVersion}, ${row.wrapped})`.execute(
      this.#db,
    );
  }
}

/** A password reset link is valid this long (USR-7). */
export const RESET_LINK_MS = 30 * 60_000;

/**
 * Makes a reset link for a user: a 256-bit token whose SHA-256 alone is stored. The worker calls
 * it just before it sends the email, so the token itself never sits in the database or a queue.
 */
export async function issuePasswordReset(
  store: Pick<AuthStore, 'createReset'>,
  userId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + RESET_LINK_MS);
  await store.createReset(createHash('sha256').update(token).digest(), userId, now, expiresAt);
  return { token, expiresAt };
}
