import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAppState } from '../app/session.tsx';
import { PermissionDenied } from '../kit/states.tsx';
import type { Tab } from '../mocks/types.ts';

/**
 * Shows the page only if the user has its tab (PERM-3) or, for admin pages, is an admin (PERM-4).
 * The sidebar already hides such tabs; this covers a shared link. The server enforces it too.
 */
export function TabGate({ tab, children }: { tab: Tab | 'admin'; children: ReactNode }) {
  const { session } = useAppState();
  const navigate = useNavigate();
  if (!session) return <div aria-busy className="h-40" />;
  const allowed = tab === 'admin' ? session.user.isAdmin : session.tabs.includes(tab);
  if (allowed) return children;
  return (
    <div className="px-4 pt-6 lg:px-6">
      <PermissionDenied
        action={{
          label: 'Go to Home',
          onClick: () => {
            void navigate({ to: '/' });
          },
        }}
      />
    </div>
  );
}
