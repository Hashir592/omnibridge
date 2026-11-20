import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  platformApi,
  type ConsoleWorkspace,
  type StatusMove,
  type WorkspaceStatus,
} from '../../auth/api.ts';
import { Card, SimpleTable, Stack, Td, Tr } from '../../components/Card.tsx';
import { StatusLabel, type StatusTone } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog } from '../../kit/Dialog.tsx';
import { EmptyState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { formatDate, formatInt } from '../../lib/format.ts';
import { CONSOLE, ConsoleFailure, Loading, refusal } from './parts.tsx';
import { allowedMoves } from './rules.ts';

export const WORKSPACES_KEY = [CONSOLE, 'workspaces'] as const;

/** Workspace names by id, for the sections that only carry an id (PLAT-3: names, not data). */
export function useWorkspaceNames(): (id: string | null) => string {
  const list = useQuery({ queryKey: WORKSPACES_KEY, queryFn: platformApi.workspaces });
  return (id) => {
    if (id === null) return 'Platform';
    return list.data?.find((w) => w.id === id)?.name ?? `Workspace ${id.slice(0, 8)}`;
  };
}

const STATUS: Record<WorkspaceStatus, { tone: StatusTone; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  suspended: { tone: 'warning', label: 'Suspended' },
  archived: { tone: 'neutral', label: 'Archived' },
};

const MOVE_LABEL: Record<StatusMove, string> = {
  suspend: 'Suspend',
  reactivate: 'Reactivate',
  archive: 'Archive',
};

/** What each move does, said before it happens (PS-032). */
function confirmText(move: StatusMove, name: string): { title: string; body: string } {
  if (move === 'archive') {
    return {
      title: `Archive ${name}?`,
      body: 'This cannot be undone. Everyone is signed out, open invites end, every member is removed and the workspace data is deleted.',
    };
  }
  if (move === 'suspend') {
    return {
      title: `Suspend ${name}?`,
      body: 'Everyone in it is signed out now and nobody can sign in until it is reactivated. Its data is kept.',
    };
  }
  return { title: `Reactivate ${name}?`, body: 'Its members can sign in again.' };
}

/** PLAT-2: every workspace with status, modules and counts only; suspend, reactivate, archive. */
export function WorkspacesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: WORKSPACES_KEY, queryFn: platformApi.workspaces });
  const [ask, setAsk] = useState<{ ws: ConsoleWorkspace; move: StatusMove }>();
  const [error, setError] = useState<string>();

  const move = useMutation({
    mutationFn: (v: { ws: ConsoleWorkspace; move: StatusMove }) =>
      platformApi.moveWorkspace(v.ws.id, v.move),
    onSuccess: (r, v) => {
      if (r.ok) {
        setError(undefined);
        toast({ title: `${MOVE_LABEL[v.move]}: done`, description: v.ws.name, tone: 'success' });
      } else {
        setError(
          r.status === 409
            ? `${v.ws.name} cannot be changed that way now. Archive is final, and only a suspended workspace can be reactivated.`
            : r.status === 404
              ? `${v.ws.name} no longer exists.`
              : (refusal(r.status) ?? 'The change could not be saved. Try again.'),
        );
      }
    },
    onError: () => {
      setError('The change could not be saved. Try again.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: WORKSPACES_KEY }),
  });

  const modules = useMutation({
    mutationFn: (v: { ws: ConsoleWorkspace; on: boolean }) =>
      platformApi.setModules(v.ws.id, { website_connector: v.on }),
    onSuccess: (r, v) => {
      if (r.ok) {
        setError(undefined);
        toast({
          title: v.on ? 'Website connector on' : 'Website connector off',
          description: v.ws.name,
          tone: 'success',
        });
      } else {
        setError(
          r.status === 409
            ? `${v.ws.name} is archived, so its modules cannot change.`
            : (refusal(r.status) ?? 'The change could not be saved. Try again.'),
        );
      }
    },
    onError: () => {
      setError('The change could not be saved. Try again.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: WORKSPACES_KEY }),
  });

  const busy = move.isPending || modules.isPending;

  return (
    <Card
      title="Workspaces"
      aside={
        <span className="text-xs text-ink-muted">Orders per day appear once orders exist</span>
      }
    >
      {list.isError ? (
        <ConsoleFailure error={list.error} retry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          body="Workspaces are created by invitation. The first one appears here."
        />
      ) : (
        <>
          {error && (
            <p role="alert" className="px-5 pt-3 text-13 text-danger">
              {error}
            </p>
          )}
          <SimpleTable
            label="Workspaces"
            head={[
              { label: 'Workspace' },
              { label: 'Status' },
              { label: 'Users', align: 'right' },
              { label: 'Channel accounts', align: 'right' },
              { label: 'Orders per day', align: 'right' },
              { label: 'Website connector' },
              { label: 'Actions', align: 'right' },
            ]}
          >
            {list.data.map((ws) => {
              const moves = allowedMoves(ws.status);
              return (
                <Tr key={ws.id}>
                  <Td className="max-w-[260px] font-medium">
                    <Stack value={ws.name} sub={`Created ${formatDate(ws.created_at)}`} />
                  </Td>
                  <Td>
                    <Stack
                      value={
                        <StatusLabel tone={STATUS[ws.status].tone}>
                          {STATUS[ws.status].label}
                        </StatusLabel>
                      }
                      sub={
                        ws.status_changed_at
                          ? `Since ${formatDate(ws.status_changed_at)}`
                          : undefined
                      }
                    />
                  </Td>
                  <Td align="right">{formatInt(ws.counts.users)}</Td>
                  <Td align="right">{formatInt(ws.counts.channel_accounts)}</Td>
                  <Td align="right">
                    {ws.counts.orders_per_day === null ? (
                      <span className="text-ink-muted">Not yet</span>
                    ) : (
                      formatInt(ws.counts.orders_per_day)
                    )}
                  </Td>
                  <Td>
                    <label className="flex items-center gap-2 text-13">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={ws.modules.website_connector}
                        disabled={ws.status === 'archived' || busy}
                        onChange={(e) => {
                          modules.mutate({ ws, on: e.target.checked });
                        }}
                      />
                      <span>
                        <span className="sr-only">Website connector for {ws.name}: </span>
                        {ws.modules.website_connector ? 'On' : 'Off'}
                      </span>
                    </label>
                  </Td>
                  <Td align="right">
                    <span className="inline-flex gap-2">
                      {moves.length === 0 ? (
                        <span className="text-xs text-ink-muted">Final</span>
                      ) : (
                        moves.map((m) => (
                          <Button
                            key={m}
                            size="sm"
                            variant={m === 'archive' ? 'danger' : 'secondary'}
                            disabled={busy}
                            aria-label={`${MOVE_LABEL[m]} ${ws.name}`}
                            onClick={() => {
                              setAsk({ ws, move: m });
                            }}
                          >
                            {MOVE_LABEL[m]}
                          </Button>
                        ))
                      )}
                    </span>
                  </Td>
                </Tr>
              );
            })}
          </SimpleTable>
        </>
      )}
      {ask && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setAsk(undefined);
          }}
          title={confirmText(ask.move, ask.ws.name).title}
          description={confirmText(ask.move, ask.ws.name).body}
          confirmLabel={`${MOVE_LABEL[ask.move]} ${ask.ws.name}`}
          destructive={ask.move !== 'reactivate'}
          onConfirm={() => {
            move.mutate(ask);
          }}
        />
      )}
    </Card>
  );
}
