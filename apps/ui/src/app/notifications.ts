import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationApi } from '../auth/api.ts';
import { useAppState } from './session.tsx';

/** The bell's number: refreshed every minute and when the window is focused again. */
export function useUnreadCount() {
  const { session, persona } = useAppState();
  return useQuery({
    queryKey: ['notifications', persona, 'count'],
    queryFn: notificationApi.unreadCount,
    enabled: !!session,
    refetchInterval: 60_000,
  });
}

/** Marking read changes the count and every list, so all of them are read again. */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationApi.markRead(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => notificationApi.markAllRead(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
