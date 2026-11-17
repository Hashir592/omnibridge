import { z } from 'zod';
import { defineRoute } from '../route.ts';

/*
 * Sign-in, MFA, password reset and the workspace picker (T-0203). The shapes are ADR-048 (PS-016)
 * exactly, camelCase as the SPA has them in apps/ui/src/auth/shapes.ts. Errors are the usual
 * problem bodies:
 * - 401 unauthorized: a wrong email or password (one answer for both), or a wrong code
 * - 429 rate_limited with Retry-After: locked (USR-5), slowed down (ADR-008) or too busy
 * - 422 validation_failed: errors[].path names the field; for a password, message is the rule
 * - 404 not_found: a reset link that is unknown, used or expired (one answer for all)
 * Every state-changing route needs the Origin check and the CSRF token (SEC-1).
 */

const Email = z.string().trim().min(3).max(254);
const Password = z.string().min(1).max(1024);
const NoBody = z.null();

/** Auth routes sit outside the app's tabs and companies. */
const outsideTabs = { tab: 'none', adminOnly: false, companyScoped: false } as const;

export const SignInResultSchema = z
  .object({ next: z.enum(['mfa_code', 'mfa_setup']) })
  .meta({ id: 'SignInResult' });

export const MfaResultSchema = z
  .object({
    /**
     * `password_change`: the password is over 365 days old (USR-3, ADR-050). `terms`: the current
     * terms and privacy policy are not accepted yet (WWW-7).
     */
    next: z.enum(['workspace_picker', 'app', 'password_change', 'terms']),
    /** Recovery-code sign in only: how many unused codes are left. */
    recoveryCodesLeft: z.number().int().min(0).max(10).optional(),
  })
  .meta({ id: 'MfaResult' });

export const MfaEnrolmentSchema = z
  .object({
    /** Base32, grouped in fours for reading. */
    secret: z.string(),
    /** What the authenticator shows, with the email masked. */
    label: z.string(),
    /** The otpauth URI as a QR module matrix: one string per row, '1' = dark. */
    qr: z.array(z.string().regex(/^[01]+$/)),
  })
  .meta({ id: 'MfaEnrolment' });

export const MfaConfirmResultSchema = z
  .object({ recoveryCodes: z.array(z.string()).length(10) })
  .meta({ id: 'MfaConfirmResult' });

export const ResetTokenInfoSchema = z
  .object({ emailMasked: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'ResetTokenInfo' });

export const WorkspaceChoiceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: z.enum(['admin', 'member']),
    companies: z.number().int().min(0),
  })
  .meta({ id: 'WorkspaceChoice' });

/** Sets the `__Host-ob_csrf` cookie the SPA echoes in `x-csrf-token` (SEC-1). */
export const getCsrf = defineRoute({
  id: 'getCsrf',
  method: 'GET',
  path: '/auth/csrf',
  summary: 'Set the CSRF cookie',
  responses: { 204: NoBody },
  auth: 'public',
  ...outsideTabs,
});

/** (1) Email and password (USR-5). Sets a pre-MFA session cookie, 10 minutes. */
export const signIn = defineRoute({
  id: 'signIn',
  method: 'POST',
  path: '/auth/sign-in',
  summary: 'Sign in with email and password',
  body: z.object({ email: Email, password: Password }),
  responses: { 200: SignInResultSchema },
  auth: 'public',
  ...outsideTabs,
});

/** (2) The 6-digit code from the authenticator (USR-4). */
export const verifyMfa = defineRoute({
  id: 'verifyMfa',
  method: 'POST',
  path: '/auth/mfa/verify',
  summary: 'Finish sign in with an authenticator code',
  body: z.object({ code: z.string().trim().min(1).max(16) }),
  responses: { 200: MfaResultSchema },
  auth: 'pre-mfa',
  ...outsideTabs,
});

/** (3) One of the 10 single-use recovery codes (USR-4). */
export const useRecoveryCode = defineRoute({
  id: 'useRecoveryCode',
  method: 'POST',
  path: '/auth/mfa/recovery',
  summary: 'Finish sign in with a recovery code',
  body: z.object({ code: z.string().trim().min(1).max(64) }),
  responses: { 200: MfaResultSchema },
  auth: 'pre-mfa',
  ...outsideTabs,
});

/** (4) A new TOTP secret, not active until confirmed. Never cached, never logged. */
export const startMfaEnrolment = defineRoute({
  id: 'startMfaEnrolment',
  method: 'POST',
  path: '/auth/mfa/enrolment',
  summary: 'Start setting up two-step sign in',
  responses: { 200: MfaEnrolmentSchema },
  auth: 'pre-mfa',
  ...outsideTabs,
});

/** (5) Confirms the secret with its first code; the recovery codes are shown once. */
export const confirmMfaEnrolment = defineRoute({
  id: 'confirmMfaEnrolment',
  method: 'POST',
  path: '/auth/mfa/enrolment/confirm',
  summary: 'Confirm two-step sign in',
  body: z.object({ code: z.string().trim().min(1).max(16) }),
  responses: { 200: MfaConfirmResultSchema },
  auth: 'pre-mfa',
  ...outsideTabs,
});

/** (6) Always 202, account or not (USR-7). */
export const forgotPassword = defineRoute({
  id: 'forgotPassword',
  method: 'POST',
  path: '/auth/password/forgot',
  summary: 'Email a password reset link',
  body: z.object({ email: Email }),
  responses: { 202: NoBody },
  auth: 'public',
  ...outsideTabs,
});

/** (7) Whether a reset link is usable; 404 for unknown, used or expired. */
export const getPasswordReset = defineRoute({
  id: 'getPasswordReset',
  method: 'GET',
  path: '/auth/password/reset/:token',
  summary: 'Check a password reset link',
  params: z.object({ token: z.string().min(1).max(128) }),
  responses: { 200: ResetTokenInfoSchema },
  auth: 'public',
  ...outsideTabs,
});

/** (7) Sets the new password (USR-3). MFA is still needed to sign in afterwards. */
export const resetPassword = defineRoute({
  id: 'resetPassword',
  method: 'POST',
  path: '/auth/password/reset',
  summary: 'Reset the password',
  body: z.object({ token: z.string().min(1).max(128), password: Password }),
  responses: { 204: NoBody },
  auth: 'public',
  ...outsideTabs,
});

/** (9) The user's workspaces, after MFA (USR-2). */
export const listMyWorkspaces = defineRoute({
  id: 'listMyWorkspaces',
  method: 'GET',
  path: '/auth/workspaces',
  summary: 'Workspaces the signed-in user belongs to',
  responses: { 200: z.array(WorkspaceChoiceSchema) },
  auth: 'signed-in',
  ...outsideTabs,
});

/** (9) Enters a workspace; the session cookie is replaced. */
export const chooseWorkspace = defineRoute({
  id: 'chooseWorkspace',
  method: 'POST',
  path: '/auth/workspace',
  summary: 'Enter a workspace',
  body: z.object({ workspaceId: z.uuid() }),
  responses: { 204: NoBody },
  auth: 'signed-in',
  ...outsideTabs,
});

/** A platform operator enters the console instead of a workspace (MFA already done). */
export const enterPlatform = defineRoute({
  id: 'enterPlatform',
  method: 'POST',
  path: '/auth/platform',
  summary: 'Enter the platform console',
  responses: { 204: NoBody },
  auth: 'signed-in',
  ...outsideTabs,
});

export const TermsSchema = z
  .object({
    /** The version to accept: the date the terms and privacy policy last changed. */
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    termsUrl: z.url(),
    privacyUrl: z.url(),
  })
  .meta({ id: 'Terms' });

export const TermsAcceptedSchema = z
  .object({ next: z.enum(['workspace_picker', 'app']) })
  .meta({ id: 'TermsAccepted' });

/** The current terms and privacy policy to accept (WWW-7). */
export const getTerms = defineRoute({
  id: 'getTerms',
  method: 'GET',
  path: '/auth/terms',
  summary: 'The current terms and privacy policy',
  responses: { 200: TermsSchema },
  auth: 'signed-in',
  ...outsideTabs,
});

/** Accepts the current terms and privacy policy; logged with the version (WWW-7). */
export const acceptTerms = defineRoute({
  id: 'acceptTerms',
  method: 'POST',
  path: '/auth/terms',
  summary: 'Accept the current terms and privacy policy',
  body: z.object({ version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  responses: { 200: TermsAcceptedSchema },
  auth: 'signed-in',
  ...outsideTabs,
});

/** Changes the password (USR-3: rules, history, minimum age). Other sessions end. */
export const changePassword = defineRoute({
  id: 'changePassword',
  method: 'POST',
  path: '/auth/password/change',
  summary: 'Change the password',
  body: z.object({ currentPassword: Password, password: Password }),
  responses: { 204: NoBody },
  auth: 'signed-in',
  ...outsideTabs,
});

/** Ends this browser's session, whatever stage it is at. */
export const signOut = defineRoute({
  id: 'signOut',
  method: 'POST',
  path: '/auth/sign-out',
  summary: 'Sign out',
  responses: { 204: NoBody },
  auth: 'public',
  ...outsideTabs,
});

/** Ends every session of the user, on every device (USR-6). */
export const signOutEverywhere = defineRoute({
  id: 'signOutEverywhere',
  method: 'POST',
  path: '/auth/sign-out-all',
  summary: 'Sign out on all devices',
  responses: { 204: NoBody },
  auth: 'signed-in',
  ...outsideTabs,
});

export const authRoutes = [
  getCsrf,
  signIn,
  verifyMfa,
  useRecoveryCode,
  startMfaEnrolment,
  confirmMfaEnrolment,
  forgotPassword,
  getPasswordReset,
  resetPassword,
  listMyWorkspaces,
  chooseWorkspace,
  enterPlatform,
  getTerms,
  acceptTerms,
  changePassword,
  signOut,
  signOutEverywhere,
] as const;
