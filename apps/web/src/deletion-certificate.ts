import type { DeletionCertificate } from '@omnibridge/db';

/** UK date and time for the certificate, in Europe/London (units rule: DD/MM/YYYY). */
const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * The deletion certificate as plain text (DEL-3): the account, how many buyer records were deleted
 * for it, and every run aimed at it. IDs, times and counts only: nothing deleted is quoted.
 */
export function deletionCertificateText(cert: DeletionCertificate, provider: string): string {
  const lines = [
    'OmniBridge deletion certificate',
    '',
    `Channel account: ${cert.channelAccountId} (${provider})`,
    `Buyer records deleted for this account: ${String(cert.recordsDeleted)}`,
    'Deletion is a hard delete in the PII store, followed by VACUUM; each deleted record is',
    'tombstoned in three places and re-deleted after any restore. Backups age out within 30 days.',
    '',
    'Runs for this account (London time):',
  ];
  if (cert.runs.length === 0) lines.push('  none');
  for (const run of cert.runs) {
    lines.push(
      `  ${LONDON.format(run.finishedAt)}  ${run.trigger}  records: ${String(run.recordsDeleted)}  run: ${run.id}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
