/**
 * System email (MAIL-2, ADR-020): SMTP adapter, the branded base template and the template lint
 * that refuses PII markers and secrets. Notification emails: T-0502.
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
  lifetimeText,
  lintEmail,
  renderInvite,
  renderLockNotice,
  renderNotificationEmail,
  renderPasswordReset,
  type Email,
} from './templates.ts';
