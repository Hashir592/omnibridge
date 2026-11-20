import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { authApi } from '../../auth/api.ts';
import type { SessionInfo } from '../../auth/shapes.ts';
import { readSession, STEP_PATH } from '../../app/session.tsx';
import { PageHeader } from '../../components/Card.tsx';
import { IncidentLine } from '../../components/IncidentLine.tsx';
import { Button } from '../../kit/Button.tsx';
import { Skeleton } from '../../kit/Skeleton.tsx';
import { Tabs } from '../../kit/Tabs.tsx';
import { ErrorState } from '../../kit/states.tsx';
import { AuthFrame, Notice } from '../auth/layout.tsx';
import { HealthSection, JobsSection } from './operations.tsx';
import { IncidentSection, FlagsSection, MaintenanceSection } from './settings.tsx';
import { SecretsSection } from './secrets.tsx';
import type { Section } from './rules.ts';
import { CredentialsSection, LiveUsageSection, UsageSection } from './usage.tsx';
import { WorkspacesSection } from './workspaces.tsx';

export interface PlatformSearch {
  section?: Section;
}

/**
 * The platform console (T-0313; PLAT-1, PLAT-2, PLAT-4, OPS-6). It has its own frame, outside the
 * workspace shell: a console session has no workspace. Only a session that GET /auth/session says
 * is in the console sees it (PLAT-1); anyone else gets the way in, which the server refuses unless
 * they are a platform admin with MFA on an allowed network.
 */
export function PlatformPage() {
  const navigate = useNavigate();
  const session = useQuery({
    queryKey: ['auth-session', 'console'],
    queryFn: readSession,
    staleTime: Infinity,
    retry: 1,
    refetchInterval: 60_000,
  });
  const info = session.data?.ok ? (session.data.body as SessionInfo) : undefined;

  useEffect(() => {
    if (session.data?.status === 401) void navigate({ to: '/sign-in' });
    else if (info?.next) void navigate({ to: STEP_PATH[info.next] });
  }, [session.data, info, navigate]);

  if (session.isError && session.data === undefined) {
    return (
      <main className="grid min-h-dvh place-items-center bg-surface p-6">
        <ErrorState
          title="OmniBridge could not load your session"
          body="The server did not answer. Try again in a moment."
          action={{ label: 'Try again', onClick: () => void session.refetch() }}
        />
      </main>
    );
  }
  if (!info || info.next) {
    return (
      <main className="min-h-dvh bg-surface p-6" aria-busy>
        <Skeleton className="h-7 w-56" />
      </main>
    );
  }
  if (!info.platform) return <EnterConsole onEntered={() => void session.refetch()} />;
  return <Console info={info} />;
}

/** The way in for an operator who signed in (MFA done) but has not entered the console yet. */
function EnterConsole({ onEntered }: { onEntered: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<'forbidden' | 'error'>();

  const enter = async () => {
    setBusy(true);
    setRefused(undefined);
    try {
      const r = await authApi.enterPlatform();
      if (r.ok) {
        // The workspace app's cached data must not survive into the console session.
        qc.removeQueries({
          predicate: (q) => !(q.queryKey[0] === 'auth-session' && q.queryKey[1] === 'console'),
        });
        onEntered();
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
    <AuthFrame
      title="Platform console"
      intro="For OmniBridge platform operators. It shows workspaces, jobs and system health, never a seller's orders, customers or money."
    >
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => void enter()}
      >
        <ShieldCheck className="size-4" aria-hidden />
        {busy ? 'Opening…' : 'Open the console'}
      </Button>
      {refused === 'forbidden' && (
        <Notice tone="danger" title="The console is not open to this account here" className="mt-4">
          It needs a platform operator signed in with two-step verification, on the office network
          or VPN.
        </Notice>
      )}
      {refused === 'error' && (
        <Notice
          tone="danger"
          title="The console could not be opened. Try again."
          className="mt-4"
        />
      )}
    </AuthFrame>
  );
}

function Console({ info }: { info: SessionInfo }) {
  const navigate = useNavigate({ from: '/platform' });
  const search: PlatformSearch = useSearch({ from: '/platform' });
  const section = search.section ?? 'workspaces';
  const go = (s: Section) => void navigate({ search: { section: s }, replace: true });

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-side px-4 text-white lg:px-6">
        <span className="text-sm font-semibold">OmniBridge</span>
        <span className="text-sm text-side-text">Platform console</span>
        <span className="ml-auto truncate text-13 text-side-text">{info.user.name}</span>
      </header>
      <IncidentLine incident={info.incident} />
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 lg:px-6">
        <PageHeader
          title="Platform console"
          sub="Counts, statuses and dates only. No seller's orders, customers, money or messages."
        />
        <div className="mt-4">
          <Tabs<Section>
            label="Console sections"
            value={section}
            onChange={go}
            items={[
              { value: 'workspaces', label: 'Workspaces', content: <WorkspacesSection /> },
              { value: 'jobs', label: 'Jobs', content: <JobsSection /> },
              {
                value: 'usage',
                label: 'API usage',
                content: (
                  <div className="flex flex-col gap-5">
                    <LiveUsageSection />
                    <UsageSection />
                  </div>
                ),
              },
              { value: 'credentials', label: 'Credentials', content: <CredentialsSection /> },
              { value: 'health', label: 'Health', content: <HealthSection /> },
              { value: 'incident', label: 'Incident banner', content: <IncidentSection /> },
              { value: 'secrets', label: 'App secrets', content: <SecretsSection /> },
              { value: 'maintenance', label: 'Maintenance', content: <MaintenanceSection /> },
              { value: 'flags', label: 'Flags', content: <FlagsSection /> },
            ]}
          />
        </div>
      </main>
    </div>
  );
}
