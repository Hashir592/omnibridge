// Reads osv-scanner v2 JSON (stdin) and fails on any HIGH or CRITICAL finding (SEC-4:
// "a release with critical findings is blocked"; the task sets the bar at high).
// Lower findings are listed but do not fail the gate.
import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8').trim();
if (input === '') {
  console.error('osv: empty report (did the scanner run?)');
  process.exit(1);
}
const report = JSON.parse(input);
if (!Array.isArray(report.results)) {
  console.error('osv: report has no "results" array');
  process.exit(1);
}

const findings = [];
for (const result of report.results ?? []) {
  for (const pkg of result.packages ?? []) {
    for (const group of pkg.groups ?? []) {
      const score = Number.parseFloat(group.max_severity ?? '');
      findings.push({
        pkg: `${pkg.package?.name ?? '?'}@${pkg.package?.version ?? '?'}`,
        ids: (group.ids ?? []).join(', '),
        score: Number.isNaN(score) ? null : score,
      });
    }
  }
}

// An advisory without a CVSS score cannot be ranked, so it is treated as high until triaged.
const blocking = findings.filter((f) => f.score === null || f.score >= 7.0);
for (const f of findings) {
  const level = blocking.includes(f) ? 'BLOCK' : 'note';
  console.log(`osv: ${level} ${f.pkg} ${f.ids} (CVSS ${f.score ?? 'unknown'})`);
}
console.log(`osv: ${findings.length} finding(s), ${blocking.length} high or critical`);
process.exitCode = blocking.length === 0 ? 0 : 1;
