import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Copy, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../../app/session.tsx';
import { useCompanyNames } from '../../app/companies.ts';
import { connectionsApi, type Connection } from '../../auth/api.ts';
import { Card, PageHeader } from '../../components/Card.tsx';
import { useCertificateDownload } from '../../components/deletionCertificate.ts';
import { MaintenanceLine } from '../../components/PausedLine.tsx';
import { TabGate } from '../../components/TabGate.tsx';
import { StatusLabel } from '../../kit/Badge.tsx';
import { Button } from '../../kit/Button.tsx';
import { Sheet } from '../../kit/Dialog.tsx';
import { ErrorState } from '../../kit/states.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { formatTime } from '../../lib/format.ts';
import type { Connection as MockConnection } from '../../mocks/admin.ts';
import { mockApi } from '../../mocks/api.ts';
import { ConnectionCard, ConnectionDetailBody } from './parts.tsx';
import { kindOf, oauthReturn, type Kind } from './rules.ts';

export interface ConnectionsSearch {
  connected?: string;
  error?: string;
}

const GROUPS: Array<[Kind, string]> = [
  ['channel', 'Sales channels'],
  ['ads', 'Advertising'],
  ['carrier', 'Carriers'],
];

export function ConnectionsPage() {
  return (
    <TabGate tab="admin">
      <Connections />
    </TabGate>
  );
}

function Connections() {
  const { session, persona } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const companyName = useCompanyNames();
  const certificate = useCertificateDownload();
  const key = ['connections', persona];
  const list = useQuery({ queryKey: key, queryFn: connectionsApi.list, enabled: !!session });
  // C6 (CS-6) buyer messages relay setup: a PROPOSED SHAPE, still mock only (not in M07's contract).
  const extras = useQuery({
    queryKey: ['connections-extras', persona],
    queryFn: mockApi.connections,
    // Dev only: no server answers /api/mock/*, so production builds skip the call.
    enabled: !!session && import.meta.env.DEV,
  });
  const [open, setOpen] = useState<string | null>(null);

  useOAuthReturn(list.data?.items, list.isError);

  const kill = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) =>
      connectionsApi.setKillSwitch(id, paused),
    onSuccess: (r, { paused }) => {
      if (!r.ok) {
        toast({
          title: 'The kill switch could not be changed',
          description: 'Try again.',
          tone: 'error',
        });
        return;
      }
      const c = r.body as Connection;
      qc.setQueryData<typeof list.data>(key, (old) =>
        old ? { ...old, items: old.items.map((x) => (x.id === c.id ? c : x)) } : old,
      );
      void qc.invalidateQueries({ queryKey: ['connection', c.id] });
      toast({
        title: paused ? 'Writes paused' : 'Writes resumed',
        description: paused ? c.display_name : `${c.display_name}: waiting writes are being sent.`,
        tone: paused ? 'info' : 'success',
      });
    },
    onError: () => {
      toast({
        title: 'The kill switch could not be changed',
        description: 'Try again.',
        tone: 'error',
      });
    },
  });

  const authorise = useMutation({
    mutationFn: (id: string) => connectionsApi.authorise(id),
    onSuccess: (r) => {
      if (r.ok) {
        window.location.assign((r.body as { redirect_url: string }).redirect_url);
      } else {
        toast({
          title: 'Re-authorisation could not start',
          description:
            r.status === 409 ? 'This account uses an API key, not a sign-in.' : 'Try again.',
          tone: 'error',
        });
      }
    },
    onError: () => {
      toast({
        title: 'Re-authorisation could not start',
        description: 'Try again.',
        tone: 'error',
      });
    },
  });

  const items = list.data?.items ?? [];
  const problems = items.filter((c) => c.status === 'needs_reauth' || c.status === 'error').length;
  const extra = (id: string) => extras.data?.find((x) => x.id === id);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Connections"
          sub={
            list.data &&
            (problems > 0
              ? `${String(problems)} connection${problems === 1 ? '' : 's'} need${problems === 1 ? 's' : ''} attention`
              : 'Every connection is working')
          }
        />
        {list.data && (
          <div className="mt-3">
            <MaintenanceLine state={list.data.maintenance} />
          </div>
        )}
        {list.isError ? (
          <Card className="mt-5">
            <ErrorState
              title="Connections could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: () => void list.refetch() }}
            />
          </Card>
        ) : !list.data ? (
          <div aria-busy className="mt-5 h-96" />
        ) : items.length === 0 ? (
          <Card className="mt-5">
            <p className="px-5 py-8 text-13 text-ink-muted">
              No accounts are connected for your companies yet.
            </p>
          </Card>
        ) : (
          GROUPS.map(([kind, title]) => {
            const group = items.filter((c) => kindOf(c.provider) === kind);
            return group.length === 0 ? null : (
              <section key={kind} className="mt-6" aria-label={title}>
                <h2 className="mb-3 text-sm font-semibold">{title}</h2>
                <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
                  {group.map((c) => {
                    const more = extra(c.id);
                    return (
                      <ConnectionCard
                        key={c.id}
                        c={c}
                        company={companyName(c.company_id)}
                        busy={
                          (kill.isPending && kill.variables.id === c.id) ||
                          (authorise.isPending && authorise.variables === c.id)
                        }
                        onKill={(paused) => {
                          kill.mutate({ id: c.id, paused });
                        }}
                        onAuthorise={() => {
                          authorise.mutate(c.id);
                        }}
                        onDetails={() => {
                          setOpen(c.id);
                        }}
                        actions={
                          kind === 'channel' && (
                            <Button
                              size="sm"
                              icon={<FileText />}
                              onClick={() => void certificate({ id: c.id, name: c.display_name })}
                            >
                              Deletion certificate
                            </Button>
                          )
                        }
                      >
                        {more?.buyerMessages && (
                          <BuyerMessages id={c.id} setup={more.buyerMessages} />
                        )}
                      </ConnectionCard>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>
      <DetailSheet
        id={open}
        name={items.find((c) => c.id === open)?.display_name ?? ''}
        onClose={() => {
          setOpen(null);
        }}
      />
    </div>
  );
}

function DetailSheet({
  id,
  name,
  onClose,
}: {
  id: string | null;
  name: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['connection', id],
    queryFn: () => connectionsApi.get(id ?? ''),
    enabled: id !== null,
  });
  return (
    <Sheet
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={name || 'Connection'}
      description="Sync streams, stored tokens and the last error. Token values are never shown."
    >
      {detail.isError ? (
        <ErrorState
          title="The details could not load"
          body="Try again in a moment."
          action={{ label: 'Try again', onClick: () => void detail.refetch() }}
        />
      ) : detail.data ? (
        <ConnectionDetailBody d={detail.data} />
      ) : (
        <p className="py-8 text-ink-muted" aria-busy>
          Loading…
        </p>
      )}
    </Sheet>
  );
}

/**
 * The provider sends the browser back to /connections?connected=<id> or ?error=<code>. Say what
 * happened once, then drop the query so a reload does not say it again.
 */
function useOAuthReturn(items: Connection[] | undefined, failed: boolean) {
  const search: ConnectionsSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const toast = useToast();
  const told = useRef(false);
  const { connected, error } = search;
  useEffect(() => {
    const result = oauthReturn({ connected, error });
    if (!result || told.current || (result.ok && !items && !failed)) return;
    told.current = true;
    if (result.ok) {
      const name = items?.find((c) => c.id === result.accountId)?.display_name;
      toast({ title: 'Account connected', description: name ?? '', tone: 'success' });
    } else {
      toast({ title: 'The account was not connected', description: result.text, tone: 'error' });
    }
    void navigate({ to: '/connections', search: {}, replace: true });
  }, [connected, error, items, failed, toast, navigate]);
}

/**
 * C6 (CS-6): Amazon copies buyer messages to the account's own inbound address, and replies go
 * from the approved sender. The seller sets both up in Seller Central; "Send test" checks it.
 */
function BuyerMessages({
  id,
  setup,
}: {
  id: string;
  setup: NonNullable<MockConnection['buyerMessages']>;
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    setup.lastTest === 'passed'
      ? { ok: true, text: 'Last test passed: buyer messages are arriving.' }
      : setup.lastTest === 'failed'
        ? { ok: false, text: 'Last test failed: no test message arrived. Check step 1.' }
        : null,
  );
  const [busy, setBusy] = useState(false);
  return (
    <section
      aria-label="Buyer messages setup"
      className="border-t border-divider px-5 py-4 text-13"
    >
      <h3 className="text-sm font-semibold">Buyer messages</h3>
      <p className="mt-1 text-ink-muted">
        Read and answer Amazon buyer messages in Customer Service.
      </p>
      <ol className="mt-3 flex list-decimal flex-col gap-2.5 pl-5">
        <li>
          In Seller Central, open Settings, Notification preferences, Messaging. Under Buyer
          Messages, add this address:
          <span className="mt-1 flex items-center gap-1.5">
            <code className="ref min-w-0 truncate rounded-[6px] bg-rail px-2 py-1 text-xs">
              {setup.inbound}
            </code>
            <CopyText value={setup.inbound} label="Copy inbound address" />
          </span>
        </li>
        <li>
          On the Messaging Permissions page, add an approved sender:
          <span className="mt-1 flex items-center gap-1.5">
            <code className="ref rounded-[6px] bg-rail px-2 py-1 text-xs">{setup.sender}</code>
            <CopyText value={setup.sender} label="Copy approved sender" />
          </span>
        </li>
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void mockApi.testBuyerMessages(id).then((r) => {
              setBusy(false);
              const body = r.body as
                { ok?: boolean; receivedAt?: string; detail?: string } | undefined;
              setResult(
                body?.ok
                  ? {
                      ok: true,
                      text: `Test received at ${formatTime(body.receivedAt ?? new Date().toISOString())}. Buyer messages are arriving.`,
                    }
                  : { ok: false, text: body?.detail ?? 'The test could not run. Try again.' },
              );
            });
          }}
        >
          {busy ? 'Sending test…' : 'Send test'}
        </Button>
        {result && (
          <span role="status">
            <StatusLabel tone={result.ok ? 'success' : 'danger'}>{result.text}</StatusLabel>
          </span>
        )}
      </div>
    </section>
  );
}

function CopyText({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => {
        if ('clipboard' in navigator) void navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => {
          setDone(false);
        }, 1500);
      }}
      className="grid size-7 shrink-0 place-items-center rounded-ctl text-ink-muted hover:bg-hover hover:text-ink"
    >
      {done ? (
        <Check className="size-4 text-success" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
    </button>
  );
}
