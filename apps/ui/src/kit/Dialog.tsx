import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.ts';
import { Button } from './Button.tsx';

const backdrop = 'fixed inset-0 z-50 bg-ink/25';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Buttons, right-aligned; put the main action last. */
  footer?: ReactNode;
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/** A centred dialog. Focus is trapped inside; Escape and the X close it. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  size = 'md',
}: DialogProps) {
  const width = {
    sm: 'w-[min(400px,calc(100vw-32px))]',
    md: 'w-[min(520px,calc(100vw-32px))]',
    lg: 'w-[min(720px,calc(100vw-32px))]',
  }[size];
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdrop} />
        <BaseDialog.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-64px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-card border border-border bg-card shadow-pop outline-none',
            width,
          )}
        >
          <Header
            title={title}
            description={description}
            Close={BaseDialog.Close}
            Title={BaseDialog.Title}
            Description={BaseDialog.Description}
          />
          {children && <div className="min-h-0 overflow-y-auto px-5 pb-5 text-13">{children}</div>}
          {footer && <Footer>{footer}</Footer>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** A panel that slides over the right edge, for longer forms and record previews. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: Omit<DialogProps, 'size'>) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdrop} />
        <BaseDialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-[min(480px,100vw)] flex-col border-l border-border bg-card shadow-pop outline-none">
          <Header
            title={title}
            description={description}
            Close={BaseDialog.Close}
            Title={BaseDialog.Title}
            Description={BaseDialog.Description}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 text-13">{children}</div>
          {footer && <Footer>{footer}</Footer>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/**
 * Asks before an action that cannot be undone (delete, void a label). The confirm button says
 * exactly what happens, for example "Delete 3 notes", never just "OK".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdrop} />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-card shadow-pop outline-none">
          <div className="px-5 pt-5 pb-4">
            <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
            <AlertDialog.Description className="mt-1.5 text-13 text-ink-muted">
              {description}
            </AlertDialog.Description>
          </div>
          <Footer>
            <AlertDialog.Close render={<Button variant="secondary" />}>Cancel</AlertDialog.Close>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </Footer>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function Header({
  title,
  description,
  Close,
  Title,
  Description,
}: {
  title: string;
  description?: ReactNode;
  Close: typeof BaseDialog.Close;
  Title: typeof BaseDialog.Title;
  Description: typeof BaseDialog.Description;
}) {
  return (
    <div className="flex items-start gap-3 px-5 pt-5 pb-4">
      <div className="min-w-0 flex-1">
        <Title className="text-base font-semibold">{title}</Title>
        {description && (
          <Description className="mt-1 text-13 text-ink-muted">{description}</Description>
        )}
      </div>
      <Close
        aria-label="Close"
        className="-mt-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink"
      >
        <X className="size-4" aria-hidden />
      </Close>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end gap-2 border-t border-divider bg-rail px-5 py-3 rounded-b-card">
      {children}
    </div>
  );
}
