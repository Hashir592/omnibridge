// Reads `pnpm audit --json` (stdin) and fails on any high or critical advisory, except one
// covered by an unexpired time-boxed exception (PS-026). Replaces `pnpm audit --audit-level high`.
import { readFileSync } from 'node:fs';
import { activeException, loadExceptions } from './audit-exceptions.mjs';

const input = readFileSync(0, 'utf8').trim();
if (input === '') {
  console.error('pnpm-audit: empty report (did pnpm audit run?)');
  process.exit(1);
}
const report = JSON.parse(input);
if (report.error || typeof report.advisories !== 'object' || report.advisories === null) {
  console.error(
    `pnpm-audit: unusable report${report.error ? `: ${report.error.code ?? report.error}` : ''}`,
  );
  process.exit(1);
}

const exceptions = loadExceptions();
let blocking = 0;
for (const a of Object.values(report.advisories)) {
  const ids = [a.github_advisory_id, ...(a.cves ?? [])].filter(Boolean);
  const high = a.severity === 'high' || a.severity === 'critical';
  const excepted = activeException(exceptions, ids);
  const level =
    high && !excepted ? 'BLOCK' : excepted ? `excepted until ${excepted.expires}` : 'note';
  if (high && !excepted) blocking += 1;
  console.log(`pnpm-audit: ${level} ${a.module_name} ${ids.join(', ')} (${a.severity})`);
}
console.log(`pnpm-audit: ${blocking} high or critical`);
process.exitCode = blocking === 0 ? 0 : 1;
