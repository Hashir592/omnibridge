import { Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Incident } from '../auth/shapes.ts';
import { cn } from '../lib/cn.ts';
import { formatDateTime } from '../lib/format.ts';

const LOOK: Record<Incident['severity'], { icon: LucideIcon; tone: string; label: string }> = {
  info: { icon: Info, tone: 'text-brand-600', label: 'Notice' },
  warning: { icon: TriangleAlert, tone: 'text-warning', label: 'Warning' },
  critical: { icon: OctagonAlert, tone: 'text-danger', label: 'Incident' },
};

/**
 * The incident banner a platform admin set (PLAT-2, PS-032), across the top of every screen. A
 * plain line: icon and text on the page background, no tinted box (Hashir's rule).
 */
export function IncidentLine({ incident }: { incident: Incident | null | undefined }) {
  if (!incident) return null;
  const { icon: Icon, tone, label } = LOOK[incident.severity];
  return (
    <div
      role={incident.severity === 'critical' ? 'alert' : 'status'}
      className="flex shrink-0 items-start gap-2 border-b border-border bg-card px-4 py-2 text-13 lg:px-6"
    >
      <Icon className={cn('mt-px size-4 shrink-0', tone)} aria-hidden />
      <p className="min-w-0 flex-1 text-ink">
        <span className="font-semibold">{label}:</span> {incident.message}
      </p>
      <span className="hidden shrink-0 text-xs text-ink-muted sm:inline">
        {formatDateTime(incident.set_at)}
      </span>
    </div>
  );
}
