import { CircleAlert, Inbox, Lock } from 'lucide-react';
import type { ReactNode } from 'react';

interface StateProps {
  title: string;
  body: ReactNode;
  action?: { label: string; onClick: () => void } | undefined;
}

function Base({ icon, title, body, action }: StateProps & { icon: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-full bg-surface text-ink-muted">
        {icon}
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-13 text-ink-muted">{body}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-2 h-8 rounded-ctl border border-border bg-card px-3 text-13 font-medium shadow-card hover:bg-hover"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Nothing to show. Always says what to do next (DIRECTION §6). */
export function EmptyState(props: StateProps) {
  return <Base icon={<Inbox className="size-5" aria-hidden />} {...props} />;
}

/** The request failed. Plain words and a retry. */
export function ErrorState(props: StateProps) {
  return (
    <div role="alert">
      <Base icon={<CircleAlert className="size-5 text-danger" aria-hidden />} {...props} />
    </div>
  );
}

/**
 * The user lacks this tab or company (PERM-3). The sidebar already hides such tabs; this covers
 * a shared link. It names no data, so it leaks nothing about what the page holds.
 */
export function PermissionDenied({ action }: { action?: StateProps['action'] }) {
  return (
    <Base
      icon={<Lock className="size-5" aria-hidden />}
      title="You do not have access to this page"
      body="Your admin chooses which tabs and companies you can see. Ask them if you need this page."
      action={action}
    />
  );
}
