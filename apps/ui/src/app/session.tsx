import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi } from '../auth/api.ts';
import { Button, buttonClass } from '../kit/Button.tsx';
import type { SessionInfo } from '../auth/shapes.ts';
import { mockApi } from '../mocks/api.ts';
import { getPersona, setPersona as setMockPersona, type Persona } from '../mocks/session.ts';
import type { Company, Session } from '../mocks/types.ts';

/**
 * The session as the screens read it. Who the user is, which workspace the session is in, their
 * role there and the workspace's module toggles come from the real GET /auth/session (ADR-062),
 * the one source for them. Tabs, companies and channel accounts still come from the mock data
 * until their real routes exist.
 */
export type AppSession = Session & { modules: SessionInfo['modules'] };

interface AppState {
  session: AppSession | undefined;
  persona: Persona;
  setPersona: (p: Persona) => void;
  /** 'all' is Combined: the user's permitted companies only (TEN-5, invariant 4). */
  companyId: string;
  setCompanyId: (id: string) => void;
  company: (id: string) => Company | undefined;
}

const Ctx = createContext<AppState | null>(null);

/** Where an unfinished sign-in continues (USR-2, USR-3, USR-4, WWW-7). */
const STEP_PATH: Record<NonNullable<SessionInfo['next']>, string> = {
  mfa_code: '/sign-in/code',
  mfa_setup: '/sign-in/set-up-mfa',
  password_change: '/sign-in/password-change',
  terms: '/sign-in/terms',
  workspace_picker: '/workspaces',
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

/**
 * Reads GET /auth/session on load. Entering the app after any sign-in step or a workspace switch
 * drops every cached query first (useEnterApp), so it is read again then too.
 */
export function AppStateProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [persona, setPersonaState] = useState<Persona>(getPersona());
  const [companyId, setCompanyId] = useState('all');
  const auth = useQuery({
    queryKey: ['auth-session', persona],
    queryFn: () => authApi.session(),
    staleTime: Infinity,
  });
  const { data } = useQuery({
    queryKey: ['session', persona],
    queryFn: mockApi.session,
    staleTime: Infinity,
  });
  const info = auth.data?.ok ? (auth.data.body as SessionInfo) : undefined;

  // No session: sign in. A sign-in step still open: finish it before anything in the app opens.
  useEffect(() => {
    if (!auth.data) return;
    if (auth.data.status === 401) void navigate({ to: '/sign-in' });
    else if (info?.next) void navigate({ to: STEP_PATH[info.next] });
  }, [auth.data, info, navigate]);

  const session = useMemo<AppSession | undefined>(() => {
    if (!data || !info?.workspace || info.next) return undefined;
    return {
      ...data,
      user: {
        name: info.user.name,
        email: info.user.email,
        initials: initials(info.user.name),
        isAdmin: info.workspace.role === 'admin',
      },
      workspace: info.workspace.name,
      modules: info.modules,
    };
  }, [data, info]);

  const value = useMemo<AppState>(
    () => ({
      session,
      persona,
      setPersona: (p) => {
        setMockPersona(p);
        setPersonaState(p);
        setCompanyId('all');
        void qc.invalidateQueries();
      },
      companyId,
      setCompanyId,
      company: (id) => session?.companies.find((c) => c.id === id),
    }),
    [session, persona, companyId, qc],
  );

  // Nothing to show and nowhere to send them: say so plainly, with a way out (no blank app).
  const stuck = auth.isError
    ? 'error'
    : auth.data && !auth.data.ok && auth.data.status !== 401
      ? 'error'
      : info && !info.next && !info.workspace
        ? 'no_workspace'
        : undefined;
  if (stuck) {
    return (
      <main className="grid min-h-dvh place-items-center bg-surface p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">
            {stuck === 'error' ? 'OmniBridge could not load your session' : 'No workspace is open'}
          </h1>
          <p className="mt-2 text-13 text-ink-muted">
            {stuck === 'error'
              ? 'The server did not answer. Try again in a moment.'
              : info?.platform
                ? 'This session is in the platform console. Sign in again to open a workspace.'
                : 'Choose a workspace to continue.'}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            {stuck === 'error' ? (
              <Button variant="primary" onClick={() => void auth.refetch()}>
                Try again
              </Button>
            ) : (
              <Link
                to={info?.platform ? '/sign-in' : '/workspaces'}
                className={buttonClass('primary')}
              >
                {info?.platform ? 'Sign in again' : 'Choose a workspace'}
              </Link>
            )}
          </div>
        </div>
      </main>
    );
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState outside AppStateProvider');
  return v;
}
