import { statSync } from 'node:fs';

// Container healthcheck: healthy while the heartbeat file was touched in the last 150 seconds
// (the heartbeat runs every minute, plus pg-boss cron polling slack).
const file = process.env.WORKER_HEALTH_FILE ?? '/tmp/worker-heartbeat';
const maxAgeMs = 150_000;

try {
  const age = Date.now() - statSync(file).mtimeMs;
  process.exitCode = age <= maxAgeMs ? 0 : 1;
} catch {
  process.exitCode = 1;
}
