import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { mockApi } from '../mocks/api.ts';
import { getPersona, setPersona as setMockPersona, type Persona } from '../mocks/session.ts';
import type { Company, Session } from '../mocks/types.ts';

interface AppState {
  session: Session | undefined;
  persona: Persona;
  setPersona: (p: Persona) => void;
  /** 'all' is Combined: the user's permitted companies only (TEN-5, invariant 4). */
  companyId: string;
  setCompanyId: (id: string) => void;
  company: (id: string) => Company | undefined;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [persona, setPersonaState] = useState<Persona>(getPersona());
  const [companyId, setCompanyId] = useState('all');
  const { data: session } = useQuery({
    queryKey: ['session', persona],
    queryFn: mockApi.session,
    staleTime: Infinity,
  });

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

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState outside AppStateProvider');
  return v;
}
