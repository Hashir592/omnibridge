import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAppState } from '../app/session.tsx';
import { notificationApi, type ApiProblem, type EmailPreference } from '../auth/api.ts';
import { StatusLabel, type StatusTone } from '../kit/Badge.tsx';
import { ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { Card, SimpleTable, Td, Tr } from './Card.tsx';

const TONE: Record<EmailPreference['severity'], { tone: StatusTone; label: string }> = {
  critical: { tone: 'danger', label: 'Critical' },
  warning: { tone: 'warning', label: 'Warning' },
  info: { tone: 'info', label: 'Info' },
};

/**
 * NTF-4: email on or off for each type this user can receive. A critical type is locked on for an
 * admin. The server decides which types the list holds, so a child never sees a type of a tab they
 * do not have (NTF-2).
 */
export function EmailPreferences() {
  const { persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const key = ['notification-email-preferences', persona];
  const prefs = useQuery({ queryKey: key, queryFn: notificationApi.emailPreferences });
  const save = useMutation({
    mutationFn: (v: { type: string; title: string; email: boolean }) =>
      notificationApi.setEmailPreference(v.type, v.email),
    onSuccess: async (r, v) => {
      if (r.ok) {
        setError(undefined);
        qc.setQueryData(key, (r.body as { items: EmailPreference[] }).items);
        toast({
          title: v.email ? 'Emails on' : 'Emails off',
          description: v.title,
          tone: 'success',
        });
        return;
      }
      setError(
        r.status === 400
          ? ((r.body as ApiProblem | undefined)?.detail ??
              'That choice is not allowed for this notification.')
          : 'The change could not be saved. Try again.',
      );
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: () => {
      setError('The change could not be saved. Try again.');
    },
  });

  return (
    <Card
      title="Email me about"
      aside={<span className="text-xs text-ink-muted">Everything also appears under the bell</span>}
    >
      {prefs.isError ? (
        <ErrorState
          title="Email choices could not be loaded"
          body="Check your connection and try again."
          action={{
            label: 'Try again',
            onClick: () => {
              void prefs.refetch();
            },
          }}
        />
      ) : prefs.isPending ? (
        <p className="px-5 py-8 text-13 text-ink-muted" aria-busy>
          Loading…
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="px-5 pt-3 text-13 text-danger">
              {error}
            </p>
          )}
          <SimpleTable
            label="Notification emails"
            head={[{ label: 'Type' }, { label: 'Severity' }, { label: 'Email' }]}
          >
            {prefs.data.map((p) => (
              <Tr key={p.type}>
                <Td className="font-medium">{p.title}</Td>
                <Td>
                  <StatusLabel tone={TONE[p.severity].tone}>{TONE[p.severity].label}</StatusLabel>
                </Td>
                <Td>
                  <label className="flex items-center gap-2 text-13">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={p.email}
                      disabled={p.locked || save.isPending}
                      onChange={(e) => {
                        save.mutate({ type: p.type, title: p.title, email: e.target.checked });
                      }}
                    />
                    <span>
                      <span className="sr-only">Email me about {p.title}: </span>
                      {p.locked ? 'Always on for admins' : p.email ? 'On' : 'Off'}
                    </span>
                  </label>
                </Td>
              </Tr>
            ))}
          </SimpleTable>
        </>
      )}
    </Card>
  );
}
