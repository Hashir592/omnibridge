import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { platformApi, type DeadLetter, type PlatformHealth } from '../../auth/api.ts';
import { Card, DetailRow, SimpleTable, Stack, Td, Tr } from '../../components/Card.tsx';
import { StatusLabel } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog } from '../../kit/Dialog.tsx';
import { EmptyState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { formatDateTime, formatInt } from '../../lib/format.ts';
import { CONSOLE, ConsoleFailure, Loading, refusal } from './parts.tsx';
import { useWorkspaceNames } from './workspaces.tsx';

const JOBS_KEY = [CONSOLE, 'jobs'] as const;
const DEAD_KEY = [CONSOLE, 'dead-letters'] as const;

/** PLAT-2: queue depth per job type, and the dead letters with a redrive for each (NFR-3). */
export function JobsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const name = useWorkspaceNames();
  const jobs = useQuery({ queryKey: JOBS_KEY, queryFn: platformApi.jobs, refetchInterval: 60_000 });
  const dead = useQuery({ queryKey: DEAD_KEY, queryFn: () => platformApi.deadLetters(50) });
  const [ask, setAsk] = useState<DeadLetter>();
  const [error, setError] = useState<string>();

  const redrive = useMutation({
    mutationFn: (d: DeadLetter) => platformApi.redrive(d.type, d.id),
    onSuccess: (r, d) => {
      if (r.ok) {
        setError(undefined);
        toast({ title: 'Sent back to its queue', description: d.type, tone: 'success' });
      } else {
        setError(
          r.status === 404
            ? 'That job is no longer dead-lettered. The list is refreshed.'
            : (refusal(r.status) ?? 'The job could not be redriven. Try again.'),
        );
      }
    },
    onError: () => {
      setError('The job could not be redriven. Try again.');
    },
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: DEAD_KEY });
      await qc.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Queues"
        aside={<span className="text-xs text-ink-muted">Counts can lag by up to a minute</span>}
      >
        {jobs.isError ? (
          <ConsoleFailure error={jobs.error} retry={() => void jobs.refetch()} />
        ) : jobs.isPending ? (
          <Loading />
        ) : jobs.data.length === 0 ? (
          <EmptyState title="No queues yet" body="Job types appear once the worker has run." />
        ) : (
          <SimpleTable
            label="Queues"
            head={[
              { label: 'Job type' },
              { label: 'Queued', align: 'right' },
              { label: 'Running', align: 'right' },
              { label: 'Failed', align: 'right' },
              { label: 'Dead-lettered', align: 'right' },
            ]}
          >
            {jobs.data.map((q) => (
              <Tr key={q.type}>
                <Td className="font-mono text-xs">{q.type}</Td>
                <Td align="right">{formatInt(q.queued)}</Td>
                <Td align="right">{formatInt(q.active)}</Td>
                <Td align="right">{formatInt(q.failed)}</Td>
                <Td align="right">
                  {q.dead_letter > 0 ? (
                    <StatusLabel tone="danger">{formatInt(q.dead_letter)}</StatusLabel>
                  ) : (
                    '0'
                  )}
                </Td>
              </Tr>
            ))}
          </SimpleTable>
        )}
      </Card>

      <Card
        title="Dead letters"
        aside={<span className="text-xs text-ink-muted">Newest first, up to 50</span>}
      >
        {dead.isError ? (
          <ConsoleFailure error={dead.error} retry={() => void dead.refetch()} />
        ) : dead.isPending ? (
          <Loading />
        ) : dead.data.length === 0 ? (
          <EmptyState
            title="No dead letters"
            body="Jobs that fail every retry land here, ready to send back."
          />
        ) : (
          <>
            {error && (
              <p role="alert" className="px-5 pt-3 text-13 text-danger">
                {error}
              </p>
            )}
            <SimpleTable
              label="Dead letters"
              head={[
                { label: 'Job type' },
                { label: 'Workspace' },
                { label: 'Attempts', align: 'right' },
                { label: 'Error code' },
                { label: 'Dead-lettered' },
                { label: 'Action', align: 'right' },
              ]}
            >
              {dead.data.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <Stack
                      value={<span className="font-mono text-xs">{d.type}</span>}
                      sub={`Job ${d.id.slice(0, 8)}`}
                    />
                  </Td>
                  <Td>{name(d.workspace_id)}</Td>
                  <Td align="right">{d.attempt === null ? '–' : formatInt(d.attempt)}</Td>
                  <Td className="font-mono text-xs">{d.error_code ?? '–'}</Td>
                  <Td className="num whitespace-nowrap">{formatDateTime(d.dead_lettered_at)}</Td>
                  <Td align="right">
                    <Button
                      size="sm"
                      disabled={redrive.isPending}
                      aria-label={`Redrive ${d.type} job ${d.id.slice(0, 8)}`}
                      onClick={() => {
                        setAsk(d);
                      }}
                    >
                      Redrive
                    </Button>
                  </Td>
                </Tr>
              ))}
            </SimpleTable>
          </>
        )}
      </Card>
      {ask && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setAsk(undefined);
          }}
          title="Send this job back to its queue?"
          description={`${ask.type} for ${name(ask.workspace_id)} runs again. Handlers are idempotent, so a job that partly ran is safe to repeat.`}
          confirmLabel="Redrive job"
          onConfirm={() => {
            redrive.mutate(ask);
          }}
        />
      )}
    </div>
  );
}

const SERVICES: Array<{ key: keyof PlatformHealth['services']; label: string }> = [
  { key: 'web', label: 'Web and API' },
  { key: 'db_main', label: 'Main database' },
  { key: 'pii_vault', label: 'PII vault' },
  { key: 'worker', label: 'Worker' },
];

/** PLAT-2, OPS-6: health per service, the worker's heartbeat and the queue backlog. */
export function HealthSection() {
  const health = useQuery({
    queryKey: [CONSOLE, 'health'],
    queryFn: platformApi.health,
    refetchInterval: 60_000,
  });
  if (health.isError) {
    return (
      <Card title="System health">
        <ConsoleFailure error={health.error} retry={() => void health.refetch()} />
      </Card>
    );
  }
  if (health.isPending) {
    return (
      <Card title="System health">
        <Loading />
      </Card>
    );
  }
  const h = health.data;
  return (
    <Card
      title="System health"
      aside={
        <StatusLabel tone={h.status === 'ok' ? 'success' : 'warning'}>
          {h.status === 'ok' ? 'All services ok' : 'Degraded'}
        </StatusLabel>
      }
    >
      <dl className="max-w-xl px-5 py-2">
        {SERVICES.map((s) => (
          <DetailRow key={s.key} label={s.label}>
            <StatusLabel tone={h.services[s.key] === 'ok' ? 'success' : 'danger'}>
              {h.services[s.key] === 'ok' ? 'Ok' : 'Not answering'}
            </StatusLabel>
          </DetailRow>
        ))}
        <DetailRow label="Worker heartbeat">
          {h.worker_heartbeat_at ? formatDateTime(h.worker_heartbeat_at) : 'Never'}
        </DetailRow>
        <DetailRow label="Jobs queued">{formatInt(h.queue.queued)}</DetailRow>
        <DetailRow label="Dead-lettered">{formatInt(h.queue.dead_letter)}</DetailRow>
        <DetailRow label="Version">
          <span className="font-mono text-xs">{h.version}</span>
        </DetailRow>
      </dl>
    </Card>
  );
}
