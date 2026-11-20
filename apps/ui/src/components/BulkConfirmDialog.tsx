/**
 * SAFE-1: any write that reaches more than one channel account is confirmed here, naming every
 * account the server's preview returned. Confirm sends the preview's token only, so the server
 * runs exactly what was shown. Shared by the screens that start bulk writes (stock, tracking, ads).
 */
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { bulkApi, type BulkAction, type BulkConfirmed, type BulkPreview } from '../auth/api.ts';
import type { CompanyName } from '../app/companies.ts';
import { Button } from '../kit/Button.tsx';
import { Dialog } from '../kit/Dialog.tsx';
import { useToast } from '../kit/Toast.tsx';
import { formatTime } from '../lib/format.ts';
import { BULK_LABEL, bulkConfirmProblem, PROVIDER_LABEL } from '../lib/connections.ts';
import { PausedLine } from './PausedLine.tsx';

export function BulkConfirmDialog({
  preview,
  onClose,
  onConfirm,
  busy,
  error,
  companyName,
}: {
  preview: BulkPreview | null;
  onClose: () => void;
  onConfirm: (token: string) => void;
  busy: boolean;
  error: string | undefined;
  companyName: (id: string) => CompanyName | undefined;
}) {
  if (!preview) return null;
  const n = preview.accounts.length;
  const pausedCount = preview.accounts.filter((a) => a.paused).length;
  const label = `${BULK_LABEL[preview.action]} to ${String(n)} accounts`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`${BULK_LABEL[preview.action]} to ${String(n)} accounts?`}
      description={`This reaches every account below. The confirmation lasts until ${formatTime(preview.expires_at)}.`}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              onConfirm(preview.token);
            }}
          >
            {label}
          </Button>
        </>
      }
    >
      <ul aria-label="Accounts this reaches" className="flex flex-col">
        {preview.accounts.map((a) => {
          const co = companyName(a.company_id);
          return (
            <li key={a.id} className="border-b border-divider py-2.5 last:border-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{a.display_name}</span>
                <span className="shrink-0 text-xs text-ink-muted">
                  {PROVIDER_LABEL[a.provider]}
                  {co ? ` · ${co.name}` : ''}
                </span>
              </div>
              {a.paused && (
                <div className="mt-1">
                  <PausedLine pausedAt={null} compact />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {pausedCount > 0 && (
        <p className="mt-3 text-ink-muted">
          {pausedCount === 1 ? 'One account is' : `${String(pausedCount)} accounts are`} paused: the
          write is queued for {pausedCount === 1 ? 'it' : 'them'} and sent when resumed.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-danger">
          <CircleAlert className="mt-px size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * Preview, then confirm. `start` asks the server which accounts the write reaches and opens the
 * dialog; the dialog's confirm sends the token. Render `dialog` once in the screen.
 */
export function useBulkWrite(
  companyName: (id: string) => CompanyName | undefined,
  onDone?: (r: BulkConfirmed) => void,
) {
  const toast = useToast();
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = () => {
    setPreview(null);
    setError(undefined);
  };

  const start = async (
    action: BulkAction,
    accountIds: string[],
    params?: Record<string, string | number | boolean | string[]>,
  ) => {
    setBusy(true);
    try {
      const r = await bulkApi.preview(action, accountIds, params);
      if (r.ok) {
        setError(undefined);
        setPreview(r.body as BulkPreview);
      } else {
        toast({
          title: 'The accounts could not be checked',
          description: 'Try again.',
          tone: 'error',
        });
      }
    } catch {
      toast({
        title: 'The accounts could not be checked',
        description: 'Try again.',
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (token: string) => {
    setBusy(true);
    try {
      const r = await bulkApi.confirm(token);
      if (r.status === 202) {
        const done = r.body as BulkConfirmed;
        close();
        toast({
          title: `${BULK_LABEL[done.action]}: ${String(done.account_count)} accounts`,
          description: 'Queued. Paused accounts get it when they are resumed.',
          tone: 'success',
        });
        onDone?.(done);
      } else setError(bulkConfirmProblem(r.status));
    } catch {
      setError(bulkConfirmProblem(0));
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <BulkConfirmDialog
      preview={preview}
      onClose={close}
      onConfirm={(token) => void confirm(token)}
      busy={busy}
      error={error}
      companyName={companyName}
    />
  );
  return { start, busy, dialog };
}
