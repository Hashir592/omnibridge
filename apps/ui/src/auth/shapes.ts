/**
 * PROPOSED SHAPES for the auth routes (T-0303, approved as ADR-048). S3 builds the real routes in
 * T-0203/T-0204. App code imports the shapes from here, never from `mocks/`, so the MSW mock
 * (`mocks/auth.ts`) stays out of production builds (T-0304, ADR-046).
 *
 * Errors use the contract's Problem body (`code` from ERROR_CODES), so no new codes are needed:
 * - 401 `unauthorized`: wrong email or password. One message for both (no account enumeration).
 * - 429 `rate_limited` + `Retry-After` seconds: locked out (USR-5). The server counts failures per
 *   email whether or not the account exists, so the lockout never reveals that an email is real.
 * - 422 `validation_failed`: `errors[].path` names the field; for passwords, `message` is the rule.
 * - 404 `not_found`: a reset or invite link that is unknown, used or expired (one message for all).
 */

/** POST /auth/sign-in → 200. The server sets a pre-MFA session cookie (httpOnly, 10 minutes). */
export interface SignInResult {
  next: 'mfa_code' | 'mfa_setup';
}

/** POST /auth/mfa/verify and /auth/mfa/recovery → 200. Full session cookie is set now. */
export interface MfaResult {
  /** `terms`: the current terms and privacy policy must be accepted first (WWW-7, T-0603). */
  next: 'workspace_picker' | 'app' | 'password_change' | 'terms';
  /** Recovery-code sign in only: how many unused codes are left. */
  recoveryCodesLeft?: number;
}

/** POST /auth/mfa/enrolment → 200: a new TOTP secret, not active until confirmed. */
export interface MfaEnrolment {
  /** Base32 secret for typing into the app by hand, grouped in fours for reading. */
  secret: string;
  /** Account label the authenticator shows, e.g. "OmniBridge (n***@example.test)". */
  label: string;
  /**
   * The otpauth:// URI as a QR module matrix, drawn by the UI as inline SVG: no QR library in
   * the bundle and nothing for the CSP to allow. One string per row, '1' = dark module.
   */
  qr: string[];
}

/** POST /auth/mfa/enrolment/confirm {code} → 200. Codes are shown once and never again. */
export interface MfaConfirmResult {
  recoveryCodes: string[];
}

/** GET /auth/password/reset/:token → 200 when usable; 404 otherwise. */
export interface ResetTokenInfo {
  /** Masked, for "Resetting the password for s***@example.test". */
  emailMasked: string;
  expiresAt: string;
}

/** GET /invites/:token → 200 when usable; 404 otherwise (TEN-7: 72 hours). */
export interface InviteInfo {
  workspaceName: string;
  invitedBy: string;
  email: string;
  expiresAt: string;
  /** The email already has an OmniBridge sign-in: they confirm with its password (T-0204). */
  existingUser: boolean;
}

/** GET /auth/terms → 200 (signed in): the version to accept and where to read it (WWW-7). */
export interface TermsInfo {
  /** The date the terms and privacy policy last changed, YYYY-MM-DD. */
  version: string;
  termsUrl: string;
  privacyUrl: string;
}

/** POST /auth/terms {version} → 200: where to go next once accepted. */
export interface TermsAccepted {
  next: 'workspace_picker' | 'app';
}

/** GET /auth/workspaces → 200 (only after MFA). */
export interface WorkspaceChoice {
  id: string;
  name: string;
  role: 'admin' | 'member';
  companies: number;
  /** Module toggles of the workspace (PLAT-2, ADR-059); off unless the platform turned it on. */
  modules: { website_connector: boolean };
}

/** USR-3 rules, checked live in the UI; the server checks them again plus breach and history. */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 12 characters' },
  { id: 'personal', label: 'Does not contain your name or the first part of your email' },
  { id: 'breached', label: 'Not found in lists of leaked passwords' },
  { id: 'history', label: 'Not one of your last 10 passwords' },
] as const;
