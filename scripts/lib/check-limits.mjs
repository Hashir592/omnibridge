// Checks a resolved Compose model (`docker compose config --format json`, read from stdin) against
// OPS-8 and OPS-10 / invariant 14:
//   - every service has mem_limit, cpus and pids_limit
//   - every long-running service has a healthcheck (one-off jobs, labelled
//     com.omnibridge.kind=job with restart "no", are exempt)
//   - services join only OmniBridge networks, none of them external
// Prints one line per problem and exits 1 if there is any.
import { readFileSync } from 'node:fs';

const OMNIBRIDGE_NETWORKS = new Set(['ob_edge', 'ob_app', 'ob_db', 'ob_pii', 'scan_ob']);

function checkModel(model) {
  const problems = [];
  for (const [name, svc] of Object.entries(model.services ?? {})) {
    const limits = svc.deploy?.resources?.limits ?? {};
    if (!svc.mem_limit && !limits.memory) problems.push(`${name}: no mem_limit`);
    if (!svc.cpus && !limits.cpus) problems.push(`${name}: no cpus limit`);
    if (!svc.pids_limit && !limits.pids) problems.push(`${name}: no pids_limit`);

    const isJob = svc.labels?.['com.omnibridge.kind'] === 'job' && svc.restart === 'no';
    if (!isJob && (!svc.healthcheck || svc.healthcheck.disable))
      problems.push(`${name}: no healthcheck`);

    for (const net of Object.keys(svc.networks ?? { default: null })) {
      const real = model.networks?.[net]?.name ?? net;
      if (!OMNIBRIDGE_NETWORKS.has(real))
        problems.push(`${name}: joins non-OmniBridge network ${real}`);
    }
    if (svc.network_mode) problems.push(`${name}: uses network_mode ${svc.network_mode}`);
  }
  for (const [key, net] of Object.entries(model.networks ?? {})) {
    if (net.external) problems.push(`network ${key}: external networks are not allowed`);
  }
  return problems;
}

const model = JSON.parse(readFileSync(0, 'utf8'));
const problems = checkModel(model);
for (const p of problems) console.error(`check-limits: ${p}`);
const count = Object.keys(model.services ?? {}).length;
if (problems.length === 0) console.log(`check-limits: ${count} services, all limited and isolated`);
process.exitCode = problems.length === 0 ? 0 : 1;
