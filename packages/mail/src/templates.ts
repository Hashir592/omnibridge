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
    '<tr><td style="background:#1B2A6B;color:#ffffff;padding:16px 24px;font-weight:600;border-radius:8px 8px 0 0">OmniBridge</td></tr>',
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

/** Invitation to join a workspace. `appOrigin` is the app's configured origin. */
export function renderInvite(values: {
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  appOrigin: string;
}): Email {
  const acceptUrl = checkAppUrl(values.acceptUrl, values.appOrigin);
  const subject = `${values.inviterName} invited you to ${values.workspaceName} on OmniBridge`;
  const text = [
    `${values.inviterName} invited you to join ${values.workspaceName} on OmniBridge.`,
    '',
    `Accept the invitation: ${acceptUrl}`,
    '',
    'The link works for 7 days. If you did not expect this email, you can ignore it.',
  ].join('\n');
  const html = baseTemplate(
    subject,
    [
      `<p>${escapeHtml(values.inviterName)} invited you to join <strong>${escapeHtml(values.workspaceName)}</strong> on OmniBridge.</p>`,
      `<p><a href="${escapeHtml(acceptUrl)}" style="background:#1B2A6B;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none">Accept the invitation</a></p>`,
      '<p>The link works for 7 days. If you did not expect this email, you can ignore it.</p>',
    ].join(''),
  );
  return { subject, text, html };
}
