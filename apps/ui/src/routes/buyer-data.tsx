/**
 * Buyer data requests (T-0308): erasure (DEL-4), subject access export (DEL-5) and the deletion
 * certificate per channel account (DEL-3), on the T-0404 routes. Admins only. The buyer's details
 * live in this page's memory while it is open: never in the URL, never in browser storage, and
 * the screen shows only the masked values the server returns (ORD-5).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  FileText,
  LoaderCircle,
  Search,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { useAppState } from '../app/session.tsx';
import {
  privacyApi,
  saveFile,
  type ApiProblem,
  type ApiReply,
  type BuyerIdentifiers,
  type ErasureMatch,
  type ErasureRequest,
  type ErasureRequestCreated,
  type WithdrawReason,
} from '../auth/api.ts';
import { ChannelMark } from '../components/badges.tsx';
import { useCertificateDownload } from '../components/deletionCertificate.ts';
import { Card, PageHeader, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { StatusLabel } from '../kit/Badge.tsx';
import { Button } from '../kit/Button.tsx';
import { ConfirmDialog, Dialog } from '../kit/Dialog.tsx';
import { Field, Input } from '../kit/Field.tsx';
import { Select } from '../kit/Select.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { formatDate, formatDateTime, formatInt, formatTime, londonDayKey } from '../lib/format.ts';
import type { ChannelAccount } from '../mocks/types.ts';

export function BuyerDataPage() {
  return (
    <TabGate tab="admin">
      <BuyerData />
    </TabGate>
  );
}

/** Plain inline message: icon and text, no tinted box. */
function Inline({ tone, children }: { tone: 'danger' | 'warning'; children: ReactNode }) {
  const Icon = tone === 'danger' ? CircleAlert : TriangleAlert;
  return (
    <p
      className={`flex items-start gap-1.5 text-13 font-medium ${tone === 'danger' ? 'text-danger' : 'text-warning'}`}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <Icon className="mt-px size-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** What the server's refusal means to an admin. */
function problemText(r: ApiReply<unknown>, fallback: string): string {
  const p = r.body as ApiProblem | undefined;
  if (r.status === 503) return 'The buyer data store is not reachable. Try again in a few minutes.';
  if (r.status === 422 && p?.detail) return p.detail;
  if (r.status === 422) return 'Enter at least one detail of the buyer.';
  if (r.status === 409) return 'This request is no longer open: it was completed or withdrawn.';
  if (r.status === 404) return 'This request no longer exists. Refresh the page.';
  return fallback;
}

const FIELDS: Array<{ key: keyof BuyerIdentifiers; label: string; hint?: string; type?: string }> =
  [
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'tel' },
    { key: 'postcode', label: 'Postcode' },
    { key: 'buyer', label: 'Marketplace buyer ID or username' },
  ];

const KIND: Record<ErasureMatch['kind'], string> = {
  buyer_contact: 'Buyer contact',
  ebay_message: 'eBay message',
  ebay_feedback: 'eBay feedback',
};

const SUBJECT: Record<string, string> = {
  order: 'Order',
  message_thread: 'Message',
  feedback: 'Feedback',
};

/** Why an admin withdraws a request (ADR-067). A fixed list: no free text, so no buyer detail. */
const WITHDRAW_REASON: Record<WithdrawReason, string> = {
  wrong_identifiers: 'Wrong details entered',
  no_match: 'The records found are not this buyer',
  duplicate: 'Duplicate of another request',
  buyer_withdrew: 'The buyer withdrew the request',
  other: 'Other reason',
};

/** The masked values in a fixed order; fields with no masking rule (all stars) are left out. */
const MASKED_ORDER = ['name', 'email', 'phone', 'postcode', 'country'];

const plural = (n: number, one: string) => `${formatInt(n)} ${one}${n === 1 ? '' : 's'}`;

const useRequests = () => {
  const { session, persona } = useAppState();
  return useQuery({
    queryKey: ['erasure-requests', persona],
    queryFn: privacyApi.list,
    enabled: !!session,
  });
};

function BuyerData() {
  const toast = useToast();
  const qc = useQueryClient();
  const [ids, setIds] = useState<Record<keyof BuyerIdentifiers, string>>({
    name: '',
    email: '',
    phone: '',
    postcode: '',
    buyer: '',
  });
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ErasureRequestCreated>();
  const requests = useRequests();
  const overdue = (requests.data ?? []).filter((r) => r.overdue);

  const given = (): BuyerIdentifiers | undefined => {
    const out: BuyerIdentifiers = {};
    for (const f of FIELDS) {
      const v = ids[f.key].trim();
      if (v !== '') out[f.key] = v;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  };

  const start = useMutation({
    mutationFn: privacyApi.startErasure,
    onSuccess: async (r) => {
      if (r.ok) {
        setError(undefined);
        setResult(r.body as ErasureRequestCreated);
      } else setError(problemText(r, 'The search could not run. Try again.'));
      await qc.invalidateQueries({ queryKey: ['erasure-requests'] });
    },
    onError: () => {
      setError('The search could not run. Try again.');
    },
  });

  const exportAccess = useMutation({
    mutationFn: privacyApi.exportAccess,
    onSuccess: (r) => {
      if (!r.ok) {
        setError(problemText(r, 'The export could not be made. Try again.'));
        return;
      }
      setError(undefined);
      saveFile(r.body as Blob, `buyer-data-export-${londonDayKey()}.json`);
      toast({
        title: 'Export downloaded',
        description:
          'It holds the buyer’s details in full. Send it to the buyer securely, then delete your copy.',
        tone: 'success',
      });
    },
    onError: () => {
      setError('The export could not be made. Try again.');
    },
  });

  const busy = start.isPending || exportAccess.isPending;

  const onFind = (e: SyntheticEvent) => {
    e.preventDefault();
    const q = given();
    if (!q) {
      setError('Enter at least one detail of the buyer.');
      return;
    }
    setResult(undefined);
    start.mutate(q);
  };

  const onExport = () => {
    const q = given();
    if (!q) {
      setError('Enter at least one detail of the buyer.');
      return;
    }
    exportAccess.mutate(q);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-4 pt-3 pb-12 lg:px-6">
        <Link
          to="/users"
          className="-ml-1 inline-flex h-8 items-center gap-1 rounded-ctl px-1 text-13 text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden /> Back to users
        </Link>
        <div className="mt-2">
          <PageHeader
            title="Buyer data requests"
            sub="When a buyer asks for a copy of what you hold about them, or asks you to delete it. Each request must be completed within one month."
          />
        </div>
        {overdue.length > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-13 font-medium text-danger">
            <Clock className="size-4 shrink-0" aria-hidden />
            {overdue.length === 1
              ? '1 erasure request is past its due date.'
              : `${String(overdue.length)} erasure requests are past their due date.`}
          </p>
        )}

        <Card title="Find a buyer" className="mt-5">
          <form onSubmit={onFind} className="px-5 py-4" noValidate>
            <p className="mb-4 text-13 text-ink-muted">
              Enter what the buyer gave you. A record must match every detail you enter, so start
              with one or two.
            </p>
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  <Input
                    name={`buyer-${f.key}`}
                    type={f.type ?? 'text'}
                    value={ids[f.key]}
                    // The buyer's details must not land in the browser's autofill store.
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(v) => {
                      setIds((s) => ({ ...s, [f.key]: v }));
                    }}
                  />
                </Field>
              ))}
            </div>
            {error && (
              <div className="mt-4">
                <Inline tone="danger">{error}</Inline>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="submit" variant="primary" icon={<Search />} disabled={busy}>
                Find records to delete
              </Button>
              <Button type="button" icon={<Download />} disabled={busy} onClick={onExport}>
                Download a copy for the buyer
              </Button>
            </div>
          </form>
        </Card>

        {result && (
          <MatchResult
            key={result.id}
            result={result}
            listed={requests.data?.find((r) => r.id === result.id)}
          />
        )}

        <RequestList requests={requests} />
        <Certificates />
      </div>
    </div>
  );
}

/* ---------- step 2: the masked matches and the confirmation ---------- */

/** The channel's logo and the account's name (which already says the channel). */
function AccountName({ account }: { account: ChannelAccount }) {
  return (
    <span className="flex items-center gap-2">
      <span className="inline-grid shrink-0 grid-cols-[18px] [&>span:last-child]:sr-only">
        <ChannelMark channel={account.channel} />
      </span>
      {account.name}
    </span>
  );
}

function MaskedValues({ masked }: { masked: Record<string, string> }) {
  const shown = MASKED_ORDER.flatMap((k) => (masked[k] ? [masked[k]] : []));
  return <span className="num">{shown.length ? shown.join(' · ') : '—'}</span>;
}

function MatchResult({
  result,
  listed,
}: {
  result: ErasureRequestCreated;
  /** The same request in the list: confirmed or withdrawn there, the card follows. */
  listed: ErasureRequest | undefined;
}) {
  const { session } = useAppState();
  const [justClosed, setClosed] = useState<ErasureRequest>();
  const closed = justClosed ?? (listed && listed.state !== 'open' ? listed : undefined);
  const confirmed = closed?.state === 'confirmed' ? closed : undefined;
  const withdrawn = closed?.state === 'withdrawn' ? closed : undefined;
  const n = result.matches.length;
  const account = (id: string | null) => session?.channelAccounts.find((a) => a.id === id);

  return (
    <Card
      className="mt-5"
      title={
        withdrawn
          ? 'Request withdrawn'
          : confirmed
            ? n === 0
              ? 'Request completed'
              : `${plural(n, 'record')} deleted`
            : n === 0
              ? 'No records match'
              : `${plural(n, 'record')} found`
      }
      aside={
        <span className="text-ink-muted">
          Requested {formatDate(result.requestedAt)} · due {formatDate(result.dueAt)}
        </span>
      }
    >
      {withdrawn ? (
        <div className="px-5 py-4" role="status">
          <RequestState r={withdrawn} />
          <p className="mt-1.5 text-13 text-ink-muted">
            Nothing was deleted. The request is closed and recorded in the audit log.
          </p>
        </div>
      ) : confirmed ? (
        <Confirmed request={confirmed} />
      ) : (
        <>
          {n === 0 ? (
            <EmptyState
              title="Nothing is held for these details"
              body="Try other details the buyer gave you, such as an older email or their marketplace username. If nothing is held, mark the request complete so it is recorded."
            />
          ) : (
            <>
              <p className="px-5 pt-4 text-13 text-ink-muted">
                Check these are the right buyer. Details are masked.
              </p>
              {result.truncated && (
                <div className="px-5 pt-3">
                  <Inline tone="warning">
                    More records match than are shown. Add more details to narrow the search, or
                    delete these and search again.
                  </Inline>
                </div>
              )}
              <SimpleTable
                className="mt-3"
                label="Matching records"
                head={[{ label: 'Record' }, { label: 'Account' }, { label: 'Details' }]}
              >
                {result.matches.map((m) => {
                  const a = account(m.channelAccountId);
                  return (
                    <Tr key={m.piiRef}>
                      <Td>
                        <Stack
                          value={KIND[m.kind]}
                          sub={`${SUBJECT[m.subjectType] ?? m.subjectType} ${m.subjectId}`}
                        />
                      </Td>
                      <Td className="whitespace-nowrap">
                        {a ? (
                          <AccountName account={a} />
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </Td>
                      <Td>
                        <MaskedValues masked={m.masked} />
                      </Td>
                    </Tr>
                  );
                })}
              </SimpleTable>
            </>
          )}
          <ConfirmBar
            request={result}
            onConfirmed={setClosed}
            secondary={<WithdrawButton request={result} onWithdrawn={setClosed} />}
          />
        </>
      )}
    </Card>
  );
}

/** The confirm button and its dialog, for a new request or an open one in the list. */
function ConfirmBar({
  request,
  onConfirmed,
  secondary,
  compact,
}: {
  request: ErasureRequest;
  onConfirmed: (r: ErasureRequest) => void;
  secondary?: ReactNode;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  const n = request.matchCount;
  const label = n === 0 ? 'Mark complete' : `Delete ${plural(n, 'record')}`;

  const confirm = useMutation({
    mutationFn: () => privacyApi.confirmErasure(request.id),
    onSuccess: async (r) => {
      if (r.ok) {
        setError(undefined);
        onConfirmed(r.body as ErasureRequest);
        toast({
          title: n === 0 ? 'Request marked complete' : 'Deletion started',
          description: 'Your confirmation is in the audit log.',
          tone: 'success',
        });
      } else setError(problemText(r, 'The request could not be confirmed. Try again.'));
      await qc.invalidateQueries({ queryKey: ['erasure-requests'] });
    },
    onError: () => {
      setError('The request could not be confirmed. Try again.');
    },
  });

  const button = (
    <Button
      size={compact ? 'sm' : 'md'}
      variant={n === 0 ? 'secondary' : 'danger'}
      disabled={confirm.isPending}
      onClick={() => {
        setAsking(true);
      }}
    >
      {label}
      {compact && (
        <span className="sr-only"> for the request of {formatDateTime(request.requestedAt)}</span>
      )}
    </Button>
  );

  return (
    <>
      {compact ? (
        <span className="flex flex-col items-end gap-1">
          <span className="flex gap-2">
            {secondary}
            {button}
          </span>
          {error && <Inline tone="danger">{error}</Inline>}
        </span>
      ) : (
        <div className="border-t border-divider px-5 py-3">
          {error && (
            <div className="mb-3">
              <Inline tone="danger">{error}</Inline>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {secondary}
            {button}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        destructive={n > 0}
        title={
          n === 0 ? 'Mark this request complete?' : `Delete ${plural(n, 'record')} of this buyer?`
        }
        description={
          n === 0
            ? 'Nothing is held for these details. The request is closed and recorded in the audit log.'
            : 'They are deleted for good and cannot be recovered, not even from backups. Finance records with no buyer details are kept, as the law requires.'
        }
        confirmLabel={label}
        onConfirm={() => {
          confirm.mutate();
        }}
      />
    </>
  );
}

/**
 * Closes an open request without deleting anything (ADR-067): wrong details, not this buyer, a
 * duplicate, or the buyer changed their mind. The reason comes from a fixed list.
 */
function WithdrawButton({
  request,
  onWithdrawn,
  compact,
}: {
  request: ErasureRequest;
  onWithdrawn: (r: ErasureRequest) => void;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<WithdrawReason | null>(null);
  const [error, setError] = useState<string>();

  const withdraw = useMutation({
    mutationFn: (r: WithdrawReason) => privacyApi.withdrawErasure(request.id, r),
    onSuccess: async (r) => {
      if (r.ok) {
        setOpen(false);
        onWithdrawn(r.body as ErasureRequest);
        toast({
          title: 'Request withdrawn',
          description: 'Nothing was deleted. The reason is in the audit log.',
          tone: 'success',
        });
      } else if (r.status === 409) {
        // The list refresh below closes this request's row, so say it outside the dialog.
        setOpen(false);
        toast({ title: 'Not withdrawn', description: problemText(r, ''), tone: 'error' });
      } else setError(problemText(r, 'The request could not be withdrawn. Try again.'));
      await qc.invalidateQueries({ queryKey: ['erasure-requests'] });
    },
    onError: () => {
      setError('The request could not be withdrawn. Try again.');
    },
  });

  return (
    <>
      <Button
        size={compact ? 'sm' : 'md'}
        variant="ghost"
        icon={<Undo2 />}
        onClick={() => {
          setReason(null);
          setError(undefined);
          setOpen(true);
        }}
      >
        Withdraw
        <span className="sr-only"> the request of {formatDateTime(request.requestedAt)}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Withdraw this request?"
        description="Nothing is deleted. The request is closed, never turns overdue, and the reason is recorded in the audit log."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={withdraw.isPending}
              onClick={() => {
                if (!reason) {
                  setError('Choose a reason.');
                  return;
                }
                withdraw.mutate(reason);
              }}
            >
              Withdraw request
            </Button>
          </>
        }
      >
        <Field label="Reason">
          <Select
            label="Reason"
            options={(Object.keys(WITHDRAW_REASON) as WithdrawReason[]).map((k) => ({
              value: k,
              label: WITHDRAW_REASON[k],
            }))}
            value={reason}
            onChange={(v) => {
              setReason(v as WithdrawReason | null);
              setError(undefined);
            }}
          />
        </Field>
        {error && (
          <div className="mt-3">
            <Inline tone="danger">{error}</Inline>
          </div>
        )}
      </Dialog>
    </>
  );
}

/** After the confirmation: the deletion job's progress, then the admin's confirmation. */
function Confirmed({ request }: { request: ErasureRequest }) {
  const job = useQuery({
    queryKey: ['job', request.jobId],
    queryFn: () => privacyApi.job(request.jobId ?? ''),
    enabled: request.jobId !== null,
    // Stops when the job ends, and on an error (the line below says so; no endless polling).
    refetchInterval: (q) =>
      q.state.status === 'error' ||
      q.state.data?.state === 'completed' ||
      q.state.data?.state === 'failed'
        ? false
        : 1000,
  });
  const at = request.confirmedAt ?? new Date().toISOString();
  const when = `${formatDate(at)} at ${formatTime(at)}`;

  let line: ReactNode;
  if (request.jobId === null) {
    line = (
      <StatusLabel tone="success" icon={CircleCheck}>
        Request completed on {when}. Nothing was held for these details.
      </StatusLabel>
    );
  } else if (job.data?.state === 'completed') {
    line = (
      <StatusLabel tone="success" icon={CircleCheck}>
        {plural(request.matchCount, 'record')} deleted on {when}. This is your confirmation; it is
        in the audit log.
      </StatusLabel>
    );
  } else if (job.data?.state === 'failed' || job.isError) {
    line = (
      <StatusLabel tone="danger" icon={CircleAlert}>
        The deletion did not finish. It is retried automatically; if this stays, check Status.
      </StatusLabel>
    );
  } else {
    line = (
      <StatusLabel tone="info" icon={LoaderCircle}>
        Deleting {plural(request.matchCount, 'record')}…{' '}
        {job.data ? `${String(job.data.percent)}%` : ''}
      </StatusLabel>
    );
  }
  return (
    <div className="px-5 py-4" role="status">
      {line}
    </div>
  );
}

/* ---------- the list of erasure requests ---------- */

function RequestState({ r }: { r: ErasureRequest }) {
  if (r.state === 'withdrawn')
    return (
      <StatusLabel tone="neutral" icon={Undo2}>
        Withdrawn {r.withdrawnAt ? formatDate(r.withdrawnAt) : ''}
        {r.withdrawReason ? ` · ${WITHDRAW_REASON[r.withdrawReason]}` : ''}
      </StatusLabel>
    );
  if (r.state === 'confirmed')
    return (
      <StatusLabel tone="success" icon={CircleCheck}>
        Completed {r.confirmedAt ? formatDate(r.confirmedAt) : ''}
      </StatusLabel>
    );
  if (r.overdue)
    return (
      <StatusLabel tone="danger" icon={CircleAlert}>
        Overdue
      </StatusLabel>
    );
  return (
    <StatusLabel tone="info" icon={Clock}>
      Open
    </StatusLabel>
  );
}

function RequestList({ requests }: { requests: ReturnType<typeof useRequests> }) {
  return (
    <Card title="Erasure requests" className="mt-5">
      {requests.isError ? (
        <ErrorState
          title="Erasure requests could not load"
          body="The server did not answer. Try again."
          action={{ label: 'Try again', onClick: () => void requests.refetch() }}
        />
      ) : !requests.data ? (
        <div aria-busy className="h-40" />
      ) : requests.data.length === 0 ? (
        <EmptyState
          title="No erasure requests yet"
          body="When a buyer asks you to delete their details, find them above."
        />
      ) : (
        <SimpleTable
          label="Erasure requests"
          head={[
            { label: 'Requested' },
            { label: 'Due' },
            { label: 'Records', align: 'right' },
            { label: 'Status' },
            { label: 'Action', className: 'sr-only' },
          ]}
        >
          {requests.data.map((r) => (
            <Tr key={r.id}>
              <Td className="num whitespace-nowrap">{formatDate(r.requestedAt)}</Td>
              <Td className={`num whitespace-nowrap ${r.overdue ? 'font-medium text-danger' : ''}`}>
                {formatDate(r.dueAt)}
              </Td>
              <Td className="num text-right">{formatInt(r.matchCount)}</Td>
              <Td>
                <RequestState r={r} />
              </Td>
              <Td className="text-right">
                {r.state === 'open' && (
                  <ConfirmBar
                    request={r}
                    onConfirmed={() => undefined}
                    secondary={<WithdrawButton request={r} onWithdrawn={() => undefined} compact />}
                    compact
                  />
                )}
              </Td>
            </Tr>
          ))}
        </SimpleTable>
      )}
    </Card>
  );
}

/* ---------- deletion certificates (DEL-3) ---------- */

function Certificates() {
  const { session } = useAppState();
  const download = useCertificateDownload();
  const accounts = session?.channelAccounts ?? [];
  return (
    <Card title="Deletion certificates" className="mt-5">
      <p className="px-5 pt-4 text-13 text-ink-muted">
        For each channel account: how many buyer records were deleted, and every deletion run.
        Counts and IDs only, never a deleted value.
      </p>
      {accounts.length === 0 ? (
        <EmptyState title="No channel accounts yet" body="Connect an account on Connections." />
      ) : (
        <SimpleTable
          className="mt-3"
          label="Deletion certificates"
          head={[{ label: 'Channel account' }, { label: 'Certificate', className: 'sr-only' }]}
        >
          {accounts.map((a) => (
            <Tr key={a.id}>
              <Td>
                <AccountName account={a} />
              </Td>
              <Td className="text-right">
                <Button size="sm" icon={<FileText />} onClick={() => void download(a)}>
                  Download certificate
                  <span className="sr-only"> for {a.name}</span>
                </Button>
              </Td>
            </Tr>
          ))}
        </SimpleTable>
      )}
    </Card>
  );
}
