import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Notice } from './layout.tsx';

/**
 * The "Platform console" row in the workspace picker (PS-034, ADR-075). Shown only when
 * GET /auth/workspaces says platform_admin; the server still decides on entry (PLAT-1: flag, MFA
 * and allowlist re-read on every request), so a 403 here is shown, not hidden.
 */
export function ConsoleEntry({
  show,
  enter,
  onEntered,
  disabled,
}: {
  show: boolean;
  enter: () => Promise<{ ok: boolean; status: number }>;
  onEntered: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<'forbidden' | 'error'>();
  if (!show) return null;

  const open = async () => {
    setBusy(true);
    setRefused(undefined);
    try {
      const r = await enter();
      if (r.ok) {
        await onEntered();
        return;
      }
      setRefused(r.status === 403 ? 'forbidden' : 'error');
    } catch {
      setRefused('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="mt-1 border-t border-border pt-1">
      <button
        disabled={busy || disabled}
        onClick={() => void open()}
        className="flex w-full items-center gap-3 rounded-ctl px-2 py-2.5 text-left hover:bg-hover disabled:opacity-60"
      >
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-ctl bg-surface text-ink-muted"
        >
          <ShieldCheck className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">Platform console</span>
          <span className="block text-xs text-ink-muted">
            {busy ? 'Opening…' : 'Workspaces, jobs and system health'}
          </span>
        </span>
        <ChevronRight className="size-4 text-ink-muted" aria-hidden />
      </button>
      {refused === 'forbidden' && (
        <Notice
          tone="danger"
          title="The console is not open to this account here"
          className="mt-2 px-2"
        >
          It needs a platform operator signed in with two-step verification, on the office network
          or VPN.
        </Notice>
      )}
      {refused === 'error' && (
        <Notice
          tone="danger"
          title="The console could not be opened. Try again."
          className="mt-2 px-2"
        />
      )}
    </li>
  );
}
