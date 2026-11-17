import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AnyRoute } from '@omnibridge/contract';
import {
  ApiError,
  type AccountActor,
  type AuditAction,
  type PlatformActor,
  type SessionActor,
  type TenantRunner,
} from '@omnibridge/core';
import type { AuditLog, AuthStore, AuthUser, SessionStage, StoredSession } from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import type { FastifyRequest } from 'fastify';
import {
  clearCookie,
  CSRF_COOKIE,
  CSRF_HEADER,
  readCookie,
  readHeader,
  SESSION_COOKIE,
  setCookie,
} from './cookies.ts';
import {
  MAX_AGE_MS,
  MIN_AGE_MS,
  passwordProblems,
  passwordRejected,
  type PasswordRule,
  type Passwords,
} from './passwords.ts';
import { totpAad, type PlatformKeys } from './platform-keys.ts';
import {
  enrolmentView,
  maskEmail,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  recoveryCodeHmac,
  type Enrolment,
} from './totp.ts';

/** Lifetimes (USR-6, USR-7, ADR-048). */
export /** Reset requests worked on after their 202 at once, at most (F-M02h-04). */
const MAX_RESET_BACKLOG = 64;
const PRE_MFA_MS = 10 * 60_000;
export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 12 * 3_600_000;
/** A session's last-seen time is written at most this often. */
const TOUCH_MS = 60_000;

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Mail goes through the queue: web never sends SMTP itself (ADR-050). */
export interface AuthNotifier {
  /** The email locked (USR-5): the worker tells the user and each workspace's admins. */
  locked(input: {
    userId: string;
    workspaceIds: readonly string[];
    lockedUntil: Date;
  }): Promise<void>;
  /** The worker makes the reset token and emails the link, so the token never sits in a queue. */
  passwordReset(input: { userId: string; workspaceId: string }): Promise<void>;
  /** The worker makes the invite token and mails the link (USR-1). */
  invite(input: { workspaceId: string; inviteId: string }): Promise<void>;
}

export interface AuthServiceOptions {
  store: AuthStore;
  passwords: Passwords;
  platformKeys: PlatformKeys;
  tenancy: TenantRunner;
  audit: Pick<AuditLog, 'record'>;
  notifier: AuthNotifier;
  logger: Logger;
  /** auth_hmac_key: keys the lockout counters and the recovery codes. */
  hmacKey: Buffer;
  /** Origins allowed on state-changing requests (SEC-1), e.g. https://app.omnibridge.co.uk. */
  origins: readonly string[];
  /** The current version of the terms and privacy policy, a platform setting (WWW-7). */
  termsVersion: string;
  /** The clock; tests move it. */
  now?: () => Date;
  /** Secure cookies; off only for plain-HTTP tests. */
  secureCookies?: boolean;
}

export interface WithCookies<T> {
  body: T;
  cookies: string[];
}

export type MfaNext = 'workspace_picker' | 'app' | 'password_change' | 'terms';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const token = (): string => randomBytes(32).toString('base64url');

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const unauthorized = (detail?: string) =>
  new ApiError({ status: 401, code: 'unauthorized', ...(detail ? { detail } : {}) });
const forbidden = (detail: string) => new ApiError({ status: 403, code: 'forbidden', detail });
const notFound = () =>
  new ApiError({ status: 404, code: 'not_found', detail: 'This link is not valid any more' });

function rateLimited(until: Date, now: Date, detail: string): ApiError {
  return new ApiError({
    status: 429,
    code: 'rate_limited',
    detail,
    retryAfterSeconds: (until.getTime() - now.getTime()) / 1000,
  });
}

/**
 * Sign-in, MFA, lockout, sessions and password resets (T-0203: USR-2 to USR-7, SEC-1), on the
 * shapes of ADR-048. Every rule that can be checked server side is checked here, whatever the SPA
 * already checked.
 */
export class AuthService {
  readonly #o: AuthServiceOptions;
  readonly #now: () => Date;
  readonly #secure: boolean;
  /** The session each request resolved to, for its handler. */
  readonly #sessions = new WeakMap<FastifyRequest, StoredSession>();
  /** Reset requests still being worked on after their 202 (see forgotPassword). */
  readonly #background = new Set<Promise<void>>();

  constructor(options: AuthServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#secure = options.secureCookies ?? true;
  }

  // ---- request checks and resolvers (contract AuthOptions) ----

  /** SEC-1 on every state-changing request: the Origin, and the double-submit CSRF token. */
  checkRequest = (request: FastifyRequest): void => {
    const origin = readHeader(request.headers, 'origin');
    if (origin === undefined || !this.#o.origins.includes(origin)) {
      throw forbidden('This request did not come from OmniBridge');
    }
    const header = readHeader(request.headers, CSRF_HEADER);
    const cookie = readCookie(request.headers, CSRF_COOKIE);
    if (
      header === undefined ||
      cookie === undefined ||
      !sameBytes(sha256(header), sha256(cookie))
    ) {
      throw forbidden('The CSRF token is missing or wrong. Reload the page and try again.');
    }
  };

  resolvePreMfa = async (request: FastifyRequest, route: AnyRoute) => {
    const s = await this.#resolve(request, route, ['pre_mfa']);
    return s === undefined ? undefined : this.#account(s);
  };

  resolveSignedIn = async (
    request: FastifyRequest,
    route: AnyRoute,
  ): Promise<AccountActor | undefined> => {
    const s = await this.#resolve(request, route, [
      'signed_in',
      'workspace',
      'platform',
      'password_change',
    ]);
    if (s === undefined) return undefined;
    // An expired password opens only the change itself (USR-3 maximum age).
    if (
      s.stage === 'password_change' &&
      !['changePassword', 'signOutEverywhere'].includes(route.id)
    ) {
      throw forbidden('Change your password to continue');
    }
    return this.#account(s);
  };

  resolveSession = async (
    request: FastifyRequest,
    route: AnyRoute,
  ): Promise<SessionActor | undefined> => {
    const s = await this.#resolve(request, route, ['workspace']);
    if (s?.workspaceId == null) return undefined;
    return { workspaceId: s.workspaceId, userId: s.userId, sessionId: s.id };
  };

  /** Any live session, whatever its stage (ADR-062): GET /auth/session only. */
  resolveAnySession = async (request: FastifyRequest, route: AnyRoute) => {
    const s = await this.#resolve(request, route, [
      'pre_mfa',
      'signed_in',
      'password_change',
      'workspace',
      'platform',
    ]);
    return s === undefined ? undefined : this.#account(s);
  };

  resolvePlatform = async (
    request: FastifyRequest,
    route: AnyRoute,
  ): Promise<PlatformActor | undefined> => {
    const s = await this.#resolve(request, route, ['platform']);
    return s === undefined ? undefined : { userId: s.userId };
  };

  #account(s: StoredSession): AccountActor {
    return { userId: s.userId, sessionId: s.id };
  }

  /** The live session of the request at one of `stages`, with the idle and absolute limits. */
  async #resolve(
    request: FastifyRequest,
    route: AnyRoute,
    stages: readonly SessionStage[],
  ): Promise<StoredSession | undefined> {
    const raw = readCookie(request.headers, SESSION_COOKIE);
    if (raw === undefined) return undefined;
    const s = await this.#o.store.findSession(sha256(raw));
    if (s === undefined) return undefined;
    const now = this.#now();
    const idle = s.stage !== 'pre_mfa' && now.getTime() - s.lastSeenAt.getTime() >= IDLE_MS;
    if (now >= s.expiresAt || idle) {
      await this.#o.store.revokeSession(s.id, now);
      return undefined;
    }
    if (!stages.includes(s.stage)) return undefined;
    if (!SAFE_METHODS.has(route.method)) {
      // The double-submit token must also be this session's own (SEC-1).
      const header = readHeader(request.headers, CSRF_HEADER);
      if (header === undefined || !sameBytes(sha256(header), s.csrfHash)) {
        throw forbidden('The CSRF token is missing or wrong. Reload the page and try again.');
      }
    }
    if (now.getTime() - s.lastSeenAt.getTime() >= TOUCH_MS) {
      await this.#o.store.touchSession(s.id, now);
    }
    this.#sessions.set(request, s);
    return s;
  }

  #sessionOf(request: FastifyRequest): StoredSession {
    const s = this.#sessions.get(request);
    if (s === undefined) throw unauthorized();
    return s;
  }

  // ---- cookies ----

  #issue(sessionToken: string, csrf: string): string[] {
    return [
      setCookie(SESSION_COOKIE, sessionToken, { httpOnly: true, secure: this.#secure }),
      setCookie(CSRF_COOKIE, csrf, { httpOnly: false, secure: this.#secure }),
    ];
  }

  #cleared(): string[] {
    return [clearCookie(SESSION_COOKIE, { httpOnly: true, secure: this.#secure })];
  }

  /** GET /auth/csrf: a CSRF cookie for a browser that has none yet. */
  csrfCookie(request: FastifyRequest): string[] {
    if (readCookie(request.headers, CSRF_COOKIE) !== undefined) return [];
    return [setCookie(CSRF_COOKIE, token(), { httpOnly: false, secure: this.#secure })];
  }

  // ---- lockout (USR-5, ADR-048, ADR-008) ----

  /** The counter key of an email: HMAC-SHA256 under auth_hmac_key; the email is never stored. */
  emailKey(email: string): Buffer {
    return createHmac('sha256', this.#o.hmacKey)
      .update(`login\0${email.trim().toLowerCase()}`)
      .digest();
  }

  async #refuseIfBlocked(key: Buffer, ip: string, now: Date): Promise<void> {
    const { lockedUntil, ipBlockedUntil } = await this.#o.store.lockState(key, ip, now);
    if (lockedUntil !== null) {
      throw rateLimited(lockedUntil, now, 'Too many failed attempts. Sign in is paused.');
    }
    if (ipBlockedUntil !== null) {
      throw rateLimited(ipBlockedUntil, now, 'Too many failed attempts. Wait a moment.');
    }
  }

  /**
   * After a correct answer: attempts that ran at the same time may have locked the email
   * meanwhile, and a lock wins over a right guess (USR-5: at most 10 tries per lock window).
   */
  async #refuseIfLockedMeanwhile(key: Buffer, ip: string, now: Date): Promise<void> {
    const { lockedUntil } = await this.#o.store.lockState(key, ip, now);
    if (lockedUntil !== null) {
      throw rateLimited(lockedUntil, now, 'Too many failed attempts. Sign in is paused.');
    }
  }

  /** Counts a failure and answers it: 429 once locked, 401 otherwise. Never returns. */
  async #failed(
    key: Buffer,
    ip: string,
    now: Date,
    user: { userId: string } | undefined,
    failure: 'password' | 'code' | 'recovery_code',
  ): Promise<never> {
    const lockedUntil = await this.#countFailure(key, ip, now, user, failure);
    if (lockedUntil !== null) {
      throw rateLimited(lockedUntil, now, 'Too many failed attempts. Sign in is paused.');
    }
    throw unauthorized(failure === 'password' ? 'invalid_credentials' : 'invalid_code');
  }

  /**
   * Records one failure; returns when the email is locked until, if it is. The audit row of a
   * real account is written inside that one call, so a real and an unknown email make the same
   * database calls (S5-20261117-02). After a lock, both answer 429 alike, so the notice may take
   * more calls: at most one per user a day, and 100 a day in all (S5-20261117-03).
   */
  async #countFailure(
    key: Buffer,
    ip: string,
    now: Date,
    user: { userId: string } | undefined,
    failure: 'password' | 'code' | 'recovery_code' | 'current_password',
  ): Promise<Date | null> {
    const result = await this.#o.store.recordFailure(
      key,
      ip,
      now,
      user === undefined ? undefined : { userId: user.userId, failure },
    );
    if (user !== undefined && result.newlyLocked && result.lockedUntil !== null) {
      if (result.notice === 'send') {
        const workspaceIds = (await this.#o.store.userWorkspaces(user.userId)).map((w) => w.id);
        await this.#o.notifier.locked({
          userId: user.userId,
          workspaceIds,
          lockedUntil: result.lockedUntil,
        });
      } else if (result.notice === 'platform_capped') {
        this.#o.logger.warn(
          { event: 'auth.lock_notices_capped' },
          'lock notices over the platform daily cap: not sent',
        );
      }
    }
    return result.lockedUntil;
  }

  /**
   * Writes one event into the one workspace it belongs to (AUD-2, ADR-052): an admin of one
   * workspace never sees what a user did in another.
   */
  async #auditIn(
    workspaceId: string,
    userId: string,
    action: AuditAction,
    ip: string,
  ): Promise<void> {
    await this.#o.tenancy.run({ workspaceId, companyIds: [], userId }, (ctx) =>
      this.#o.audit.record(ctx, {
        action,
        actor: { kind: 'user', userId },
        entityId: userId,
        ip,
      }),
    );
  }

  /**
   * An account event (MFA set up, sign out everywhere) goes into the user's workspace when there
   * is exactly one; with several there is no one workspace it belongs to, so it is kept per
   * person (ADR-052).
   */
  async #auditAccount(
    userId: string,
    action: 'mfa.enrolled' | 'auth.signed_out_everywhere',
    ip: string,
    workspaceId: string | null,
  ): Promise<void> {
    const workspaces = await this.#o.store.userWorkspaces(userId);
    const only = workspaceId ?? (workspaces.length === 1 ? (workspaces[0]?.id ?? null) : null);
    if (only !== null) {
      await this.#auditIn(only, userId, action, ip);
    } else {
      await this.#o.store.recordAuthEvent({ userId, action, ip, detail: {}, now: this.#now() });
    }
  }

  // ---- (1) sign in ----

  async signIn(
    input: { email: string; password: string },
    ip: string,
  ): Promise<WithCookies<{ next: 'mfa_code' | 'mfa_setup' }>> {
    const now = this.#now();
    const email = input.email.trim().toLowerCase();
    const key = this.emailKey(email);
    await this.#refuseIfBlocked(key, ip, now);
    const account = await this.#o.store.loginLookup(email);
    // An unknown email runs the same argon2 check, against a dummy hash (ADR-048).
    const ok = await this.#o.passwords.check(account?.passwordHash, input.password);
    if (!ok || account === undefined) {
      return this.#failed(key, ip, now, account, 'password');
    }
    await this.#refuseIfLockedMeanwhile(key, ip, now);
    await this.#o.store.clearFailures(key);
    return {
      body: { next: account.mfaConfirmed ? 'mfa_code' : 'mfa_setup' },
      cookies: await this.#preMfaSession(account.userId, now),
    };
  }

  /** A new session at the pre-MFA stage, after a correct password (USR-4, ADR-051). */
  async #preMfaSession(userId: string, now: Date): Promise<string[]> {
    const sessionToken = token();
    const csrf = token();
    await this.#o.store.createSession({
      id: randomUUID(),
      tokenHash: sha256(sessionToken),
      csrfHash: sha256(csrf),
      userId,
      stage: 'pre_mfa',
      now,
      expiresAt: new Date(now.getTime() + PRE_MFA_MS),
    });
    return this.#issue(sessionToken, csrf);
  }

  // ---- invites (USR-1, TEN-7) ----

  async inviteInfo(rawToken: string): Promise<{
    workspaceName: string;
    invitedBy: string;
    email: string;
    expiresAt: string;
    existingUser: boolean;
  }> {
    const invite = await this.#o.store.findInvite(sha256(rawToken), this.#now());
    if (invite === undefined) throw notFound();
    return {
      workspaceName: invite.workspaceName,
      invitedBy: invite.invitedBy,
      email: maskEmail(invite.email),
      expiresAt: invite.expiresAt.toISOString(),
      existingUser: invite.userExists,
    };
  }

  /**
   * Accepts an invite. A new person sets their first password (USR-3 rules); someone who already
   * has a sign-in confirms with it, under the same lock as sign-in (USR-5). Either way the session
   * then starts at MFA, so an invite never skips it (USR-4).
   */
  async acceptInvite(
    input: { token: string; name?: string | undefined; password: string },
    ip: string,
  ): Promise<WithCookies<{ next: 'mfa_code' | 'mfa_setup' }>> {
    const now = this.#now();
    const tokenHash = sha256(input.token);
    const invite = await this.#o.store.findInvite(tokenHash, now);
    if (invite === undefined) throw notFound();
    if (invite.userExists) {
      const key = this.emailKey(invite.email);
      await this.#refuseIfBlocked(key, ip, now);
      const account = await this.#o.store.loginLookup(invite.email);
      const ok = await this.#o.passwords.check(account?.passwordHash, input.password);
      if (!ok || account === undefined) return this.#failed(key, ip, now, account, 'password');
      await this.#refuseIfLockedMeanwhile(key, ip, now);
      await this.#o.store.clearFailures(key);
      // An existing sign-in keeps its own name (PS-024); passed only for the function's shape.
      const joined = await this.#o.store.acceptInvite(
        tokenHash,
        randomUUID(),
        account.name,
        now,
        false,
      );
      if (joined === undefined) throw notFound();
      await this.#auditJoined(joined.workspaceId, joined.userId, invite.role, ip);
      return {
        body: { next: account.mfaConfirmed ? 'mfa_code' : 'mfa_setup' },
        cookies: await this.#preMfaSession(account.userId, now),
      };
    }
    const name = input.name;
    if (name === undefined) {
      throw new ApiError({
        status: 422,
        code: 'validation_failed',
        detail: 'Enter your name',
        errors: [{ location: 'body', path: 'name', message: 'required' }],
      });
    }
    const rules = passwordProblems(input.password, { name, email: invite.email });
    if (rules.length > 0) throw passwordRejected(rules);
    const hash = await this.#o.passwords.hash(input.password);
    // One definer call joins and sets the first password (F-M02e-04). Like newOnly, it may never
    // join (or set the password of) an account that appeared for this email meanwhile.
    const joined = await this.#o.store.acceptInviteNewUser(
      tokenHash,
      randomUUID(),
      name,
      now,
      hash,
    );
    if (joined === undefined) throw notFound();
    await this.#auditJoined(joined.workspaceId, joined.userId, invite.role, ip);
    return { body: { next: 'mfa_setup' }, cookies: await this.#preMfaSession(joined.userId, now) };
  }

  async #auditJoined(workspaceId: string, userId: string, role: string, ip: string): Promise<void> {
    await this.#o.tenancy.run({ workspaceId, companyIds: [], userId }, (ctx) =>
      this.#o.audit.record(ctx, {
        action: 'user.joined',
        actor: { kind: 'user', userId },
        entityId: userId,
        after: { role },
        ip,
      }),
    );
  }

  // ---- (2) and (3) MFA ----

  async #user(userId: string): Promise<AuthUser> {
    const user = await this.#o.store.user(userId);
    if (user === undefined) throw unauthorized();
    return user;
  }

  async verifyMfa(
    request: FastifyRequest,
    account: AccountActor,
    code: string,
  ): Promise<WithCookies<{ next: MfaNext }>> {
    const now = this.#now();
    const user = await this.#user(account.userId);
    const key = this.emailKey(user.email);
    await this.#refuseIfBlocked(key, request.ip, now);
    const mfa = await this.#o.store.mfa(user.userId);
    if (mfa?.secret == null || mfa.keyVersion === null) throw forbidden('Set up two-step sign in');
    const dataKey = await this.#o.platformKeys.version(mfa.keyVersion);
    const secret = dataKey.decrypt(mfa.secret, totpAad(user.userId));
    const step = matchTotp(secret, code.trim(), now);
    if (step === undefined || !(await this.#o.store.useTotpStep(user.userId, step))) {
      return this.#failed(key, request.ip, now, user, 'code');
    }
    await this.#refuseIfLockedMeanwhile(key, request.ip, now);
    await this.#o.store.clearFailures(key);
    return this.#finishSignIn(request, user, now);
  }

  async useRecoveryCode(
    request: FastifyRequest,
    account: AccountActor,
    code: string,
  ): Promise<WithCookies<{ next: MfaNext; recoveryCodesLeft: number }>> {
    const now = this.#now();
    const user = await this.#user(account.userId);
    const key = this.emailKey(user.email);
    await this.#refuseIfBlocked(key, request.ip, now);
    const left = await this.#o.store.useRecoveryCode(
      user.userId,
      recoveryCodeHmac(this.#o.hmacKey, user.userId, code),
      now,
    );
    if (left === undefined) return this.#failed(key, request.ip, now, user, 'recovery_code');
    await this.#refuseIfLockedMeanwhile(key, request.ip, now);
    await this.#o.store.clearFailures(key);
    const done = await this.#finishSignIn(request, user, now);
    return { body: { ...done.body, recoveryCodesLeft: left }, cookies: done.cookies };
  }

  /**
   * MFA passed: the real sign-in. The session moves on under a new token, its 12-hour lifetime
   * starts, and it enters the only workspace when there is one (USR-2).
   */
  async #finishSignIn(
    request: FastifyRequest,
    user: AuthUser,
    now: Date,
  ): Promise<WithCookies<{ next: MfaNext }>> {
    const session = this.#sessionOf(request);
    const expired =
      user.passwordSetAt !== null && now.getTime() - user.passwordSetAt.getTime() >= MAX_AGE_MS;
    const workspaces = await this.#o.store.userWorkspaces(user.userId);
    let stage: SessionStage = 'signed_in';
    let workspaceId: string | null = null;
    let next: MfaNext = 'workspace_picker';
    if (expired) {
      stage = 'password_change';
      next = 'password_change';
    } else if (!(await this.#o.store.termsAccepted(user.userId, this.#o.termsVersion))) {
      // A new version is accepted before anything else opens (WWW-7): no workspace yet.
      next = 'terms';
    } else if (workspaces.length === 1 && workspaces[0] !== undefined) {
      stage = 'workspace';
      workspaceId = workspaces[0].id;
      next = 'app';
    }
    const cookies = await this.#advance(session, stage, workspaceId, now, true);
    // The sign-in is recorded in the workspace it enters; with the picker, when one is chosen.
    if (workspaceId !== null)
      await this.#auditIn(workspaceId, user.userId, 'auth.login', request.ip);
    return { body: { next }, cookies };
  }

  async #advance(
    session: StoredSession,
    stage: SessionStage,
    workspaceId: string | null,
    now: Date,
    signedIn: boolean,
  ): Promise<string[]> {
    const sessionToken = token();
    const csrf = token();
    const moved = await this.#o.store.advanceSession({
      id: session.id,
      tokenHash: sha256(sessionToken),
      csrfHash: sha256(csrf),
      stage,
      workspaceId,
      now,
      signedIn,
      expiresAt: signedIn ? new Date(now.getTime() + ABSOLUTE_MS) : session.expiresAt,
    });
    if (!moved) throw forbidden('That workspace is not open to you');
    return this.#issue(sessionToken, csrf);
  }

  // ---- (4) and (5) MFA enrolment ----

  async startEnrolment(account: AccountActor): Promise<Enrolment> {
    const user = await this.#user(account.userId);
    if (user.mfaConfirmed) throw forbidden('Two-step sign in is already set up');
    const secret = newTotpSecret();
    const dataKey = await this.#o.platformKeys.current();
    const sealed = dataKey.encrypt(secret, totpAad(user.userId));
    if (!(await this.#o.store.setPendingTotp(user.userId, sealed, dataKey.version))) {
      throw forbidden('Two-step sign in is already set up');
    }
    const view = enrolmentView(secret, user.email);
    return { secret: view.secret, label: view.label, qr: view.qr };
  }

  async confirmEnrolment(
    request: FastifyRequest,
    account: AccountActor,
    code: string,
  ): Promise<WithCookies<{ recoveryCodes: string[] }>> {
    const now = this.#now();
    const user = await this.#user(account.userId);
    const key = this.emailKey(user.email);
    await this.#refuseIfBlocked(key, request.ip, now);
    const mfa = await this.#o.store.mfa(user.userId);
    if (mfa?.pending == null || mfa.pendingKeyVersion === null) {
      throw forbidden('Start setting up two-step sign in first');
    }
    const dataKey = await this.#o.platformKeys.version(mfa.pendingKeyVersion);
    const secret = dataKey.decrypt(mfa.pending, totpAad(user.userId));
    const step = matchTotp(secret, code.trim(), now);
    if (step === undefined) return this.#failed(key, request.ip, now, user, 'code');
    const recoveryCodes = newRecoveryCodes();
    const hmacs = recoveryCodes.map((c) => recoveryCodeHmac(this.#o.hmacKey, user.userId, c));
    if (!(await this.#o.store.confirmTotp(user.userId, step, hmacs, now))) {
      throw forbidden('Start setting up two-step sign in first');
    }
    await this.#o.store.clearFailures(key);
    await this.#auditAccount(user.userId, 'mfa.enrolled', request.ip, null);
    const done = await this.#finishSignIn(request, { ...user, mfaConfirmed: true }, now);
    return { body: { recoveryCodes }, cookies: done.cookies };
  }

  // ---- (6) and (7) password reset ----

  /** Always succeeds from the outside (USR-7): nothing tells whether the email has an account. */
  /**
   * Answers at once and does the work afterwards, so a real and an unknown email take the same
   * time to answer (USR-7, F-M02h-04). Errors are logged, never shown.
   */
  forgotPassword(email: string, ip: string): void {
    // Bounded: a flood answers 202 as usual but starts no more work than this at once.
    if (this.#background.size >= MAX_RESET_BACKLOG) {
      this.#o.logger.warn({ event: 'auth.reset_backlog_full' }, 'password reset backlog full');
      return;
    }
    const work = this.#forgotPassword(email.trim().toLowerCase(), ip, this.#now())
      .catch((err: unknown) => {
        this.#o.logger.error({ err, event: 'auth.reset_failed' }, 'password reset request failed');
      })
      .finally(() => this.#background.delete(work));
    this.#background.add(work);
  }

  /** Resolves once every reset request started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.#background]);
  }

  async #forgotPassword(email: string, ip: string, now: Date): Promise<void> {
    // The lookup comes first: the 202 has already gone, so it costs no answer time, and only a
    // mail that goes out may use the platform-wide cap (S5-20261117-01).
    const account = await this.#o.store.loginLookup(email);
    const first =
      account === undefined ? undefined : (await this.#o.store.userWorkspaces(account.userId))[0];
    // Every request counts toward the per-email and per-address caps, real email or not.
    const verdict = await this.#o.store.allowReset(
      this.emailKey(email),
      ip,
      now,
      first !== undefined,
    );
    if (verdict === 'global_capped') {
      this.#o.logger.warn(
        { event: 'auth.reset_capped', cap: 'platform' },
        'password reset over the platform daily cap: not sent',
      );
      return;
    }
    if (verdict === 'capped') {
      this.#o.logger.info({ event: 'auth.reset_capped' }, 'password reset over a cap: not sent');
      return;
    }
    if (account === undefined) return;
    if (first === undefined) {
      // Every mail job carries a workspace (invariant 12); an operator with none is told in M05.
      this.#o.logger.warn(
        { event: 'auth.reset_skipped', userId: account.userId },
        'password reset for a user with no workspace: not sent',
      );
      return;
    }
    await this.#o.notifier.passwordReset({ userId: account.userId, workspaceId: first.id });
  }

  async resetInfo(rawToken: string): Promise<{ emailMasked: string; expiresAt: string }> {
    const now = this.#now();
    const reset = await this.#o.store.findReset(sha256(rawToken), now);
    if (reset === undefined) throw notFound();
    const user = await this.#o.store.user(reset.userId);
    if (user === undefined) throw notFound();
    return { emailMasked: maskEmail(user.email), expiresAt: reset.expiresAt.toISOString() };
  }

  async resetPassword(rawToken: string, password: string): Promise<void> {
    const now = this.#now();
    const tokenHash = sha256(rawToken);
    const reset = await this.#o.store.findReset(tokenHash, now);
    if (reset === undefined) throw notFound();
    const user = await this.#user(reset.userId);
    // No minimum age here: whoever forgot a password set today can still reset it (USR-3 as
    // amended, ADR-061).
    await this.#checkNewPassword(user, password, now, { minAge: false });
    const hash = await this.#o.passwords.hash(password);
    // Every session ends with it; signing in again still needs MFA (USR-7).
    if ((await this.#o.store.resetPassword(tokenHash, now, hash)) === undefined) throw notFound();
  }

  /**
   * USR-3 for a new password: the rules, the last 10, and (in the app, not by an emailed reset
   * link) a day since the last change.
   */
  async #checkNewPassword(
    user: AuthUser,
    password: string,
    now: Date,
    { minAge = true }: { minAge?: boolean } = {},
  ): Promise<void> {
    const rules: PasswordRule[] = passwordProblems(password, user);
    if (
      minAge &&
      user.passwordSetAt !== null &&
      now.getTime() - user.passwordSetAt.getTime() < MIN_AGE_MS
    ) {
      rules.push('min_age');
    }
    if (rules.length === 0) {
      const history = await this.#o.store.passwordHashes(user.userId);
      if (await this.#o.passwords.matchesAny(history, password)) rules.push('history');
    }
    if (rules.length > 0) throw passwordRejected(rules);
  }

  async changePassword(
    request: FastifyRequest,
    account: AccountActor,
    input: { currentPassword: string; password: string },
  ): Promise<string[]> {
    const now = this.#now();
    const user = await this.#user(account.userId);
    // The current password is a second verifier of the same secret, so it shares sign-in's
    // email lock and per-address delay (USR-5, F-M02h-02).
    const key = this.emailKey(user.email);
    await this.#refuseIfBlocked(key, request.ip, now);
    const current = await this.#o.store.loginLookup(user.email);
    if (!(await this.#o.passwords.check(current?.passwordHash, input.currentPassword))) {
      const lockedUntil = await this.#countFailure(key, request.ip, now, user, 'current_password');
      if (lockedUntil !== null) {
        throw rateLimited(lockedUntil, now, 'Too many failed attempts. Sign in is paused.');
      }
      throw new ApiError({
        status: 422,
        code: 'validation_failed',
        detail: 'The current password is wrong',
        errors: [{ location: 'body', path: 'currentPassword', message: 'wrong' }],
      });
    }
    await this.#refuseIfLockedMeanwhile(key, request.ip, now);
    await this.#o.store.clearFailures(key);
    await this.#checkNewPassword(user, input.password, now);
    // Setting it also marks open reset links used, so an older mail cannot undo it.
    await this.#o.store.setPassword(user.userId, await this.#o.passwords.hash(input.password), now);
    // Every session ends, this one included: sign in again with the new password and MFA.
    await this.#o.store.revokeUserSessions(user.userId, now);
    return this.#cleared();
  }

  // ---- the current session (ADR-062) ----

  /**
   * Where the request's session is: the user, the sign-in step still to do, the workspace it is
   * in with that workspace's modules, or the console. The SPA's one source for the toggles.
   */
  async currentSession(request: FastifyRequest): Promise<{
    user: { id: string; name: string; email: string };
    next: 'mfa_code' | 'mfa_setup' | 'password_change' | 'terms' | 'workspace_picker' | null;
    platform: boolean;
    workspace: { id: string; name: string; role: 'admin' | 'member' } | null;
    modules: { website_connector: boolean };
  }> {
    const session = this.#sessionOf(request);
    const user = await this.#user(session.userId);
    let next: 'mfa_code' | 'mfa_setup' | 'password_change' | 'terms' | 'workspace_picker' | null =
      null;
    if (session.stage === 'pre_mfa') next = user.mfaConfirmed ? 'mfa_code' : 'mfa_setup';
    else if (session.stage === 'password_change') next = 'password_change';
    else if (session.stage === 'signed_in') {
      const accepted = await this.#o.store.termsAccepted(user.userId, this.#o.termsVersion);
      next = accepted ? 'workspace_picker' : 'terms';
    }
    // Read through the membership list, so a workspace the user has left never shows.
    const current =
      session.stage === 'workspace' && session.workspaceId !== null
        ? (await this.#o.store.userWorkspaces(user.userId)).find(
            (w) => w.id === session.workspaceId,
          )
        : undefined;
    // A workspace session whose workspace is gone (left meanwhile) is sent back to the picker.
    if (session.stage === 'workspace' && current === undefined) next = 'workspace_picker';
    return {
      user: { id: user.userId, name: user.name, email: user.email },
      next,
      platform: session.stage === 'platform',
      workspace:
        current === undefined ? null : { id: current.id, name: current.name, role: current.role },
      modules: current?.modules ?? { website_connector: false },
    };
  }

  // ---- (9) workspace picker, platform console ----

  async workspaces(account: AccountActor) {
    return this.#o.store.userWorkspaces(account.userId);
  }

  async chooseWorkspace(request: FastifyRequest, workspaceId: string): Promise<string[]> {
    const session = this.#sessionOf(request);
    await this.#requireTerms(session);
    const cookies = await this.#advance(session, 'workspace', workspaceId, this.#now(), false);
    // Leaving the picker for a workspace completes the sign-in there (ADR-052).
    if (session.stage === 'signed_in') {
      await this.#auditIn(workspaceId, session.userId, 'auth.login', request.ip);
    }
    return cookies;
  }

  async enterPlatform(request: FastifyRequest, account: AccountActor): Promise<string[]> {
    await this.#requireTerms(this.#sessionOf(request));
    const user = await this.#user(account.userId);
    if (!user.platformAdmin) throw forbidden('Only platform operators can open the console');
    return this.#advance(this.#sessionOf(request), 'platform', null, this.#now(), false);
  }

  // ---- terms and privacy policy (WWW-7) ----

  terms(): { version: string; termsUrl: string; privacyUrl: string } {
    return {
      version: this.#o.termsVersion,
      termsUrl: 'https://omnibridge.co.uk/terms',
      privacyUrl: 'https://omnibridge.co.uk/privacy',
    };
  }

  /**
   * Accepts the current version, logged with its version, time and address, then moves on as
   * the sign-in would have: into the only workspace, or to the picker.
   */
  async acceptTerms(
    request: FastifyRequest,
    account: AccountActor,
    version: string,
  ): Promise<WithCookies<{ next: 'workspace_picker' | 'app' }>> {
    if (version !== this.#o.termsVersion) {
      throw new ApiError({
        status: 422,
        code: 'validation_failed',
        detail: 'These terms have been replaced; read the current version',
        errors: [{ location: 'body', path: 'version', message: 'stale' }],
      });
    }
    const now = this.#now();
    await this.#o.store.acceptTerms(account.userId, version, now, request.ip);
    const session = this.#sessionOf(request);
    const workspaces = await this.#o.store.userWorkspaces(account.userId);
    if (session.stage === 'signed_in' && workspaces.length === 1 && workspaces[0] !== undefined) {
      const cookies = await this.#advance(session, 'workspace', workspaces[0].id, now, false);
      return { body: { next: 'app' }, cookies };
    }
    return { body: { next: 'workspace_picker' }, cookies: [] };
  }

  /**
   * A session fresh from sign-in (signed_in) opens nothing until the current version is accepted.
   * A session already in a workspace or the console passed this at its sign-in; a new version
   * is asked for at the next sign-in (WWW-7), not in the middle of one.
   */
  async #requireTerms(session: StoredSession): Promise<void> {
    if (session.stage !== 'signed_in') return;
    if (!(await this.#o.store.termsAccepted(session.userId, this.#o.termsVersion))) {
      throw forbidden('Accept the terms and privacy policy to continue');
    }
  }

  // ---- sign out ----

  async signOut(request: FastifyRequest): Promise<string[]> {
    const raw = readCookie(request.headers, SESSION_COOKIE);
    if (raw !== undefined) {
      const s = await this.#o.store.findSession(sha256(raw));
      if (s !== undefined) await this.#o.store.revokeSession(s.id, this.#now());
    }
    return this.#cleared();
  }

  async signOutEverywhere(request: FastifyRequest, account: AccountActor): Promise<string[]> {
    const session = this.#sessionOf(request);
    await this.#o.store.revokeUserSessions(account.userId, this.#now());
    await this.#auditAccount(
      account.userId,
      'auth.signed_out_everywhere',
      request.ip,
      session.workspaceId,
    );
    return this.#cleared();
  }
}
