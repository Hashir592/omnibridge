import { CirclePause, Construction } from 'lucide-react';
import type { MaintenanceState } from '../auth/api.ts';
import { formatDateTime } from '../lib/format.ts';

/**
 * SAFE-2: a paused account says so wherever it appears. A plain red line, icon and text, no tinted
 * box (Hashir's rule, as the incident line).
 */
export function PausedLine({ pausedAt, compact }: { pausedAt: string | null; compact?: boolean }) {
  return (
    <p data-testid="paused-line" className="flex items-start gap-2 text-13 text-danger">
      <CirclePause className="mt-px size-4 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold">Paused</span>
        {pausedAt ? ` since ${formatDateTime(pausedAt)}` : ''}
        {compact
          ? '. Writes wait until it is resumed.'
          : '. Automated writes wait; reads continue.'}
      </span>
    </p>
  );
}

/** SAFE-3: while the platform's maintenance switch is on, every write of every account waits. */
export function MaintenanceLine({ state }: { state: MaintenanceState }) {
  if (!state.on) return null;
  return (
    <p role="status" className="flex items-start gap-2 text-13 text-ink">
      <Construction className="mt-px size-4 shrink-0 text-warning" aria-hidden />
      <span>
        <span className="font-semibold">Maintenance</span>
        {state.since ? ` since ${formatDateTime(state.since)}` : ''}: writes to every account wait
        until it ends. Reads continue.
      </span>
    </p>
  );
}
