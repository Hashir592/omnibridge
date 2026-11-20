/** A rendered system email (MAIL-2). */
export interface Email {
  subject: string;
  text: string;
  html: string;
}

/** Thrown when an email would carry buyer PII or a secret; it is never sent (invariant 7, SEC-5). */
export class EmailLintError extends Error {
  constructor(reason: string) {
    super(`Email refused: ${reason}`);
    this.name = 'EmailLintError';
  }
}

/** What must never appear in a system email. Reasons name the rule, never the matched text. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/PIIMARK-/, 'contains a PII marker value'],
  [/(?:^|[^A-Za-z0-9+/])[1-9][0-9]{0,8}:[A-Za-z0-9+/]{43}=/, 'contains a master key'],
  [/AGE-SECRET-KEY-1/, 'contains an age secret key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'contains a private key'],
];

/** Checks every part of an email before it is sent. */
export function lintEmail(email: Email): void {
  for (const part of [email.subject, email.text, email.html]) {
    for (const [pattern, reason] of FORBIDDEN) {
      if (pattern.test(part)) throw new EmailLintError(reason);
    }
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** The plain branded frame every system email shares. `bodyHtml` must already be escaped. */
function baseTemplate(title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="en-GB"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="margin:0;background:#f4f5f7;font-family:Inter,Arial,sans-serif;color:#121519">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px">',
    '<tr><td style="background:#0F6B66;color:#ffffff;padding:16px 24px;font-weight:600;border-radius:8px 8px 0 0">OmniBridge</td></tr>',
    `<tr><td style="padding:24px;font-size:15px;line-height:1.5">${bodyHtml}</td></tr>`,
    '<tr><td style="padding:16px 24px;font-size:12px;color:#5c6370">Sent by OmniBridge. You get this email because of your account.</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}

/**
 * The accept link must be an https URL on the app's own origin (plain http only for localhost in
 * dev), so no other scheme or host can reach the button (F-M01-end-09).
 */
function checkAppUrl(value: string, appOrigin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailLintError('The link is not a valid URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new EmailLintError('The link must use https');
  }
  if (url.origin !== new URL(appOrigin).origin) {
    throw new EmailLintError('The link must point at the app origin');
  }
  return url.href;
}

/** "72 hours": how long a link lasts, in whole hours, rounded down so it never promises more (TEN-7). */
export function lifetimeText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (!Number.isFinite(hours) || hours < 1) {
    throw new EmailLintError('A link lifetime must be at least an hour');
  }
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}

/**
 * Invitation to join a workspace. `appOrigin` is the app's configured origin; `validForMs` is the
 * invite's real lifetime (INVITE_LIFETIME_MS), so the mail never promises longer than the link.
 */
export function renderInvite(values: {
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  appOrigin: string;
  validForMs: number;
}): Email {
  const acceptUrl = checkAppUrl(values.acceptUrl, values.appOrigin);
  const validFor = lifetimeText(values.validForMs);
  const subject = `${values.inviterName} invited you to ${values.workspaceName} on OmniBridge`;
  const text = [
    `${values.inviterName} invited you to join ${values.workspaceName} on OmniBridge.`,
    '',
    `Accept the invitation: ${acceptUrl}`,
    '',
    `The link works for ${validFor}. If you did not expect this email, you can ignore it.`,
  ].join('\n');
  const html = baseTemplate(
    subject,
    [
      `<p>${escapeHtml(values.inviterName)} invited you to join <strong>${escapeHtml(values.workspaceName)}</strong> on OmniBridge.</p>`,
      `<p><a href="${escapeHtml(acceptUrl)}" style="background:#0F6B66;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">Accept the invitation</a></p>`,
      `<p>The link works for ${validFor}. If you did not expect this email, you can ignore it.</p>`,
    ].join(''),
  );
  return { subject, text, html };
}

/**
 * Sign-in locked (USR-5): to the person whose email was locked, and to each admin of their
 * workspace. `lockedUntil` is already London time for reading (NFR-9). Names only, no address.
 */
export function renderLockNotice(values: {
  recipientName: string;
  /** The locked person, when the email goes to an admin. */
  lockedName?: string;
  lockedUntil: string;
}): Email {
  const forAdmin = values.lockedName !== undefined;
  const who = forAdmin ? (values.lockedName ?? '') : 'your account';
  const subject = forAdmin
    ? `Sign in locked for ${who} on OmniBridge`
    : 'Sign in to your OmniBridge account is locked';
  const lines = [
    `Hello ${values.recipientName},`,
    '',
    `There were 10 failed sign-in attempts for ${who} in 15 minutes, so sign in is paused until ${values.lockedUntil} (UK time).`,
    '',
    forAdmin
      ? 'If this was not them, ask them to change their password once the lock ends.'
      : 'If this was not you, change your password once the lock ends.',
  ];
  const html = baseTemplate(
    subject,
    [
      `<p>Hello ${escapeHtml(values.recipientName)},</p>`,
      `<p>There were 10 failed sign-in attempts for ${escapeHtml(who)} in 15 minutes, so sign in is paused until <strong>${escapeHtml(values.lockedUntil)}</strong> (UK time).</p>`,
      `<p>${escapeHtml(lines[4] ?? '')}</p>`,
    ].join(''),
  );
  return { subject, text: lines.join('\n'), html };
}

/** Password reset link (USR-7): valid 30 minutes, once; signing in still needs MFA. */
export function renderPasswordReset(values: {
  recipientName: string;
  resetUrl: string;
  appOrigin: string;
  expiresAt: string;
}): Email {
  const resetUrl = checkAppUrl(values.resetUrl, values.appOrigin);
  const subject = 'Reset your OmniBridge password';
  const text = [
    `Hello ${values.recipientName},`,
    '',
    `Reset your password: ${resetUrl}`,
    '',
    `The link works once, until ${values.expiresAt} (UK time). You will still need your authenticator app to sign in.`,
    'If you did not ask for this, you can ignore this email: your password stays as it is.',
  ].join('\n');
  const html = baseTemplate(
    subject,
    [
      `<p>Hello ${escapeHtml(values.recipientName)},</p>`,
      `<p><a href="${escapeHtml(resetUrl)}" style="background:#0F6B66;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">Reset your password</a></p>`,
      `<p>The link works once, until ${escapeHtml(values.expiresAt)} (UK time). You will still need your authenticator app to sign in.</p>`,
      '<p>If you did not ask for this, you can ignore this email: your password stays as it is.</p>',
    ].join(''),
  );
  return { subject, text, html };
}

const SEVERITY_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Info' } as const;

/**
 * A notification email (NTF-3, MAIL-3): what happened (the type's title), how serious, which
 * company, and a link into the app, which needs a sign-in. Nothing from the record itself: no
 * buyer PII, no order contents, no secrets. The link is the app's own page, not a token, so it
 * does not expire; signing in decides who may open it.
 */
export function renderNotificationEmail(values: {
  recipientName: string;
  severity: keyof typeof SEVERITY_LABEL;
  title: string;
  /** The company's trading name; omitted for a workspace-wide or platform notice. */
  companyName?: string | undefined;
  /** Where the notice is, e.g. the platform console instead of the workspace. */
  scope: 'workspace' | 'platform';
  linkUrl: string;
  appOrigin: string;
}): Email {
  const linkUrl = checkAppUrl(values.linkUrl, values.appOrigin);
  const label = SEVERITY_LABEL[values.severity];
  const where =
    values.scope === 'platform'
      ? 'the platform console'
      : values.companyName === undefined
        ? 'your workspace'
        : values.companyName;
  const subject = `[${label}] ${values.title}${values.companyName === undefined ? '' : ` (${values.companyName})`}`;
  const text = [
    `Hello ${values.recipientName},`,
    '',
    `${label}: ${values.title}, in ${where}.`,
    '',
    `See it in OmniBridge (sign in first): ${linkUrl}`,
    '',
    'You can choose which alerts reach you by email in your notification settings.',
  ].join('\n');
  const html = baseTemplate(
    subject,
    [
      `<p>Hello ${escapeHtml(values.recipientName)},</p>`,
      `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(values.title)}, in ${escapeHtml(where)}.</p>`,
      `<p><a href="${escapeHtml(linkUrl)}" style="background:#0F6B66;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">See it in OmniBridge</a></p>`,
      '<p>You can choose which alerts reach you by email in your notification settings.</p>',
    ].join(''),
  );
  return { subject, text, html };
}

/** The daily health digest's numbers (OPS-6): counts only, nothing about any record. */
export interface DigestNumbers {
  jobsFailed: number;
  apiCalls: number;
  apiCappedCalls: number;
  apiCap: number;
  credentialsExpiring: number;
  deletionRuns: number;
  recordsDeleted: number;
}

const count = (n: number) => n.toLocaleString('en-GB');

/**
 * The daily health digest to platform admins (OPS-6): jobs failed, API usage against limits,
 * credentials expiring in the next 30 days and deletion runs, all as counts, with a link to the
 * console. Never a workspace's business data, a record, an address or a secret.
 */
export function renderPlatformDigest(values: {
  recipientName: string;
  /** The London date it covers, DD/MM/YYYY. */
  date: string;
  numbers: DigestNumbers;
  consoleUrl: string;
  appOrigin: string;
}): Email {
  const consoleUrl = checkAppUrl(values.consoleUrl, values.appOrigin);
  const n = values.numbers;
  const usage =
    n.apiCap > 0
      ? `${count(n.apiCalls)} (accounts with a daily limit: ${count(n.apiCappedCalls)} of ${count(n.apiCap)} allowed)`
      : `${count(n.apiCalls)} (no limits recorded)`;
  const rows: [string, string][] = [
    ['Jobs failed (last 24 hours)', count(n.jobsFailed)],
    ['API calls today', usage],
    ['Credentials expiring in 30 days', count(n.credentialsExpiring)],
    [
      'Deletion runs (last 24 hours)',
      `${count(n.deletionRuns)} (${count(n.recordsDeleted)} records deleted)`,
    ],
  ];
  const subject = `OmniBridge daily health digest, ${values.date}`;
  const text = [
    `Hello ${values.recipientName},`,
    '',
    `The platform on ${values.date}:`,
    ...rows.map(([label, value]) => `- ${label}: ${value}`),
    '',
    `Details are in the platform console (sign in first): ${consoleUrl}`,
  ].join('\n');
  const html = baseTemplate(
    subject,
    [
      `<p>Hello ${escapeHtml(values.recipientName)},</p>`,
      `<p>The platform on ${escapeHtml(values.date)}:</p>`,
      '<table style="border-collapse:collapse">',
      ...rows.map(
        ([label, value]) =>
          `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(label)}</td><td style="padding:4px 0"><strong>${escapeHtml(value)}</strong></td></tr>`,
      ),
      '</table>',
      `<p><a href="${escapeHtml(consoleUrl)}" style="background:#0F6B66;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the console</a></p>`,
    ].join(''),
  );
  return { subject, text, html };
}
