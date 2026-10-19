import { Toast } from '@base-ui/react/toast';
import { CircleCheck, Info, OctagonAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

const ICON = {
  success: <CircleCheck className="size-4 text-success" aria-hidden />,
  error: <OctagonAlert className="size-4 text-danger" aria-hidden />,
  info: <Info className="size-4 text-brand-600" aria-hidden />,
};

/** Wrap the app once. Toasts stack at the bottom right and close after 5 s (errors stay). */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[min(360px,calc(100vw-32px))] flex-col-reverse gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root
      key={t.id}
      toast={t}
      // State change only, 150 ms, off under reduced motion (global rule in styles.css).
      className="flex items-start gap-3 rounded-card border border-border bg-card px-4 py-3 shadow-pop transition-opacity duration-150 data-[ending-style]:opacity-0 data-[limited]:hidden data-[starting-style]:opacity-0"
    >
      <span className="mt-0.5">{ICON[(t.type as ToastTone | undefined) ?? 'info']}</span>
      <div className="min-w-0 flex-1">
        <Toast.Title className="text-13 font-semibold text-ink" />
        <Toast.Description className="text-13 text-ink-muted" />
      </div>
      <Toast.Close
        aria-label="Dismiss"
        className="-mt-1 -mr-2 grid size-7 shrink-0 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink"
      >
        <X className="size-4" aria-hidden />
      </Toast.Close>
    </Toast.Root>
  ));
}

/** Show a toast: `toast({ title: 'Label created', tone: 'success' })`. */
export function useToast() {
  const manager = Toast.useToastManager();
  return ({
    title,
    description,
    tone = 'info',
  }: {
    title: string;
    description?: string;
    tone?: ToastTone;
  }) =>
    manager.add({
      title,
      description,
      type: tone,
      // Errors stay until dismissed, so nobody misses a failure.
      timeout: tone === 'error' ? 0 : 5000,
      priority: tone === 'error' ? 'high' : 'low',
    });
}
