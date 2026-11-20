import { useQuery } from '@tanstack/react-query';
import { companiesApi } from '../auth/api.ts';
import { useAppState } from './session.tsx';

/** A company as a notification row names it: trading name and badge colour (TEN-2). */
export interface CompanyName {
  name: string;
  colour: string;
}

/**
 * Company names from GET /companies (ADR-072): the user's permitted companies only (TEN-5,
 * invariant 4). An id the user may not see has no name, so nothing about it is shown.
 */
export function useCompanyNames(): (id: string | null) => CompanyName | undefined {
  const { session, persona } = useAppState();
  const { data } = useQuery({
    queryKey: ['companies', persona],
    queryFn: companiesApi.list,
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  return (id) => {
    if (id === null) return undefined;
    const c = data?.find((x) => x.id === id);
    return c ? { name: c.trading_name, colour: c.badge_colour } : undefined;
  };
}
