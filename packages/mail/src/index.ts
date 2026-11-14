/**
 * System email (MAIL-2, ADR-020): SMTP adapter, the branded base template and the template lint
 * that refuses PII markers and secrets. Notification emails arrive in M05.
 */
export const PACKAGE_NAME = '@omnibridge/mail';

export {
  isPlainAddress,
  Mailer,
  RecipientRejected,
  SYSTEM_FROM,
  type SmtpConfig,
} from './mailer.ts';
export {
  EmailLintError,
  escapeHtml,
  lintEmail,
  renderInvite,
  renderLockNotice,
  renderPasswordReset,
  type Email,
} from './templates.ts';
