import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import {
  CalendarCheck,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  Clock,
  Mail,
  ShieldCheck,
  ShieldOff,
  UserPlus,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useAppState } from '../app/session.tsx';
import {
  usersApi,
  type AccessReview,
  type ApiProblem,
  type ApiReply,
  type UserAccess,
  type UserTab,
  type WorkspaceUser,
} from '../auth/api.ts';
import { USER_TABS } from '../auth/userTabs.ts';
import { CompanySwatch } from '../components/badges.tsx';
import { Card, PageHeader, SimpleTable, Stack, Td, Tr } from '../components/Card.tsx';
import { TabGate } from '../components/TabGate.tsx';
import { Badge, StatusLabel } from '../kit/Badge.tsx';
import { Button, buttonClass } from '../kit/Button.tsx';
import { ConfirmDialog, Dialog } from '../kit/Dialog.tsx';
import { Field, Input } from '../kit/Field.tsx';
import { EmptyState, ErrorState } from '../kit/states.tsx';
import { useToast } from '../kit/Toast.tsx';
import { cn } from '../lib/cn.ts';
import { formatDate, formatTime } from '../lib/format.ts';

const ADMIN_TABS = ['Connections', 'Users', 'Settings', 'Audit Log'];

/** PERM-7, as the server answers it with 409 `conflict`. */
const LAST_ADMIN =
  'Every workspace needs at least one admin. Make someone else an admin first, then try again.';

function lastSeen(iso: string | null): string {
  if (!iso) return 'Never signed in';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d === 0
    ? `Today, ${formatTime(iso)}`
    : d === 1
      ? `Yesterday, ${formatTime(iso)}`
      : formatDate(iso);
}

/** Plain inline error: icon and text, no tinted box. */
function InlineError({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-13 font-medium text-danger" role="alert">
      <CircleAlert className="mt-px size-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

const isConflict = (r: ApiReply<unknown>) =>
  r.status === 409 && (r.body as ApiProblem | undefined)?.code === 'conflict';

function UserState({ u }: { u: WorkspaceUser }) {
  if (u.state === 'invited')
    return (
      <StatusLabel tone="info" icon={Mail}>
        Invited until {u.inviteExpiresAt ? formatDate(u.inviteExpiresAt) : ''}
      </StatusLabel>
    );
  return <StatusLabel tone="success">Active</StatusLabel>;
}

const useUsers = () => {
  const { session, persona } = useAppState();
  return useQuery({ queryKey: ['users', persona], queryFn: usersApi.list, enabled: !!session });
};

const useReviews = () => {
  const { session, persona } = useAppState();
  return useQuery({
    queryKey: ['access-reviews', persona],
    queryFn: usersApi.accessReviews,
    enabled: !!session,
  });
};

const openReview = (reviews: AccessReview[] | undefined) =>
  reviews?.filter((r) => r.completedAt === null).sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];

export function UsersPage() {
  return (
    <TabGate tab="admin">
      <UsersList />
    </TabGate>
  );
}

function UsersList() {
  const { session, company } = useAppState();
  const qc = useQueryClient();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<WorkspaceUser>();
  const [error, setError] = useState<string>();
  const q = useUsers();
  const due = openReview(useReviews().data);
  const total = session?.companies.length ?? 0;

  const revoke = useMutation({
    mutationFn: (u: WorkspaceUser) => usersApi.revokeInvite(u.id),
    onSuccess: async (r, u) => {
      if (r.ok) {
        setError(undefined);
        toast({ title: 'Invite revoked', description: `The link for ${u.email} no longer works.` });
      } else {
        setError(
          r.status === 404
            ? 'That invite was already used or revoked.'
            : 'The invite could not be revoked. Try again.',
        );
      }
      await qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1280px] px-4 pt-3 pb-12 lg:px-6">
        <PageHeader
          title="Users"
          sub="Admins see everything. Each child user sees only the tabs and companies ticked for them."
          actions={
            <>
              <Link to="/users/access-reviews" className={buttonClass('secondary')}>
                <CalendarCheck className="size-4" aria-hidden />
                Access reviews
              </Link>
              <Button
                variant="primary"
                icon={<UserPlus />}
                onClick={() => {
                  setInviting(true);
                }}
              >
                Invite user
              </Button>
            </>
          }
        />
        {due && (
          <p className="mt-3 flex items-center gap-1.5 text-13 text-ink-muted">
            <Clock className="size-4 shrink-0" aria-hidden />
            The quarterly access review is due {formatDate(due.dueAt)}.
            <Link to="/users/access-reviews" className="font-medium text-brand-600 hover:underline">
              Review access
            </Link>
          </p>
        )}
        {error && (
          <div className="mt-3">
            <InlineError>{error}</InlineError>
          </div>
        )}
        <Card className="mt-5">
          {q.isError ? (
            <ErrorState
              title="Users could not load"
              body="The server did not answer. Try again; if it keeps failing, check Status."
              action={{ label: 'Try again', onClick: () => void q.refetch() }}
            />
          ) : !q.data ? (
            <div aria-busy className="h-64" />
          ) : q.data.length === 0 ? (
            <EmptyState title="No users yet" body="Invite the people who work in this workspace." />
          ) : (
            <SimpleTable
              label="Users"
              head={[
                { label: 'Name' },
                { label: 'Role' },
                { label: 'Tabs' },
                { label: 'Companies' },
                { label: 'Two-step sign-in' },
                { label: 'Last sign-in' },
                { label: 'Status' },
              ]}
            >
              {q.data.map((u) => {
                const admin = u.role === 'admin';
                const invited = u.state === 'invited';
                return (
                  <Tr key={u.id} className="hover:bg-hover">
                    <Td>
                      <Stack
                        value={
                          <Link
                            to="/users/$userId"
                            params={{ userId: u.id }}
                            className="font-medium text-ink hover:text-brand-600 hover:underline"
                          >
                            {u.name || u.email}
                          </Link>
                        }
                        sub={u.name ? u.email : 'Has not joined yet'}
                      />
                    </Td>
                    <Td>{admin ? 'Admin' : 'Child'}</Td>
                    <Td className="max-w-[240px]">
                      <Stack
                        value={
                          admin
                            ? 'All tabs'
                            : `${String(u.tabs.length)} of ${String(USER_TABS.length)}`
                        }
                        sub={
                          admin
                            ? 'Including admin pages'
                            : u.tabs.length === 0
                              ? 'None yet'
                              : USER_TABS.filter((t) => u.tabs.includes(t.key))
                                  .map((t) => t.label)
                                  .join(', ')
                        }
                      />
                    </Td>
                    <Td className="whitespace-nowrap">
                      {admin ? (
                        'All companies'
                      ) : u.companyIds.length === 0 ? (
                        <span className="text-ink-muted">None yet</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span className="flex gap-1">
                            {u.companyIds.map((id) => {
                              const c = company(id);
                              return c ? <CompanySwatch key={id} company={c} /> : null;
                            })}
                          </span>
                          <span className="num">
                            {u.companyIds.length} of {total}
                          </span>
                        </span>
                      )}
                    </Td>
                    <Td>
                      {u.mfa ? (
                        <StatusLabel tone="success" icon={ShieldCheck}>
                          On
                        </StatusLabel>
                      ) : (
                        <StatusLabel tone="neutral" icon={ShieldOff}>
                          Not set up yet
                        </StatusLabel>
                      )}
                    </Td>
                    <Td className="num whitespace-nowrap text-ink-muted">
                      {lastSeen(u.lastSignInAt)}
                    </Td>
                    <Td>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <UserState u={u} />
                        {invited && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setRevoking(u);
                            }}
                          >
                            Revoke invite
                            <span className="sr-only"> for {u.email}</span>
                          </Button>
                        )}
                      </span>
                    </Td>
                  </Tr>
                );
              })}
            </SimpleTable>
          )}
        </Card>
        <p className="mt-3 text-xs text-ink-muted">
          Admin-only pages ({ADMIN_TABS.join(', ')}) cannot be ticked for a child user.
        </p>
      </div>
      {inviting && <InviteDialog open onOpenChange={setInviting} />}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => {
          if (!o) setRevoking(undefined);
        }}
        destructive
        title={`Revoke the invite for ${revoking?.email ?? ''}?`}
        description="The invite link stops working at once. You can invite them again later."
        confirmLabel="Revoke invite"
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
      />
    </div>
  );
}

/* ---------- ticks, shared by the invite dialog and the user page ---------- */

function Tick({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex h-10 items-center gap-2.5 rounded-ctl border px-3 text-13',
        checked ? 'border-[#c3c8d0] bg-selected' : 'border-border bg-card hover:bg-hover',
        disabled && 'pointer-events-none opacity-60',
      )}
    >
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      {children}
    </label>
  );
}

const toggle = <T,>(set: Set<T>, v: T, on: boolean) => {
  const n = new Set(set);
  if (on) n.add(v);
  else n.delete(v);
  return n;
};

function RoleChoice({
  role,
  onChange,
  name,
}: {
  role: UserAccess['role'];
  onChange: (r: UserAccess['role']) => void;
  name: string;
}) {
  return (
    <>
      {(
        [
          [
            'admin',
            'Admin',
            'Every tab and company, settings, users, connections, finance edits and deletes.',
          ],
          [
            'child',
            'Child',
            'Only the tabs and companies ticked below, including in Combined view, search, exports and notifications.',
          ],
        ] as const
      ).map(([value, label, sub]) => (
        <label key={value} className="flex items-start gap-3 text-13">
          <input
            type="radio"
            name={name}
            value={value}
            checked={role === value}
            onChange={() => {
              onChange(value);
            }}
            className="mt-0.5 size-4 accent-[var(--color-side)]"
          />
          <span>
            <span className="font-medium">{label}</span>
            <span className="block text-ink-muted">{sub}</span>
          </span>
        </label>
      ))}
    </>
  );
}

function TabTicks({
  tabs,
  admin,
  disabled,
  onChange,
}: {
  tabs: Set<UserTab>;
  admin: boolean;
  disabled?: boolean;
  onChange: (t: Set<UserTab>) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {USER_TABS.map((t) => (
        <Tick
          key={t.key}
          checked={admin || tabs.has(t.key)}
          disabled={admin || disabled === true}
          onChange={(on) => {
            onChange(toggle(tabs, t.key, on));
          }}
        >
          {t.label}
        </Tick>
      ))}
    </div>
  );
}

function CompanyTicks({
  companies,
  admin,
  disabled,
  onChange,
}: {
  companies: Set<string>;
  admin: boolean;
  disabled?: boolean;
  onChange: (c: Set<string>) => void;
}) {
  const { session } = useAppState();
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {(session?.companies ?? []).map((c) => (
        <Tick
          key={c.id}
          checked={admin || companies.has(c.id)}
          disabled={admin || disabled === true}
          onChange={(on) => {
            onChange(toggle(companies, c.id, on));
          }}
        >
          <CompanySwatch company={c} />
          {c.tradingName}
        </Tick>
      ))}
    </div>
  );
}

const accessOf = (
  role: UserAccess['role'],
  tabs: Set<UserTab>,
  companies: Set<string>,
): UserAccess =>
  role === 'admin'
    ? { role, tabs: [], companyIds: [] }
    : {
        role,
        tabs: USER_TABS.map((t) => t.key).filter((k) => tabs.has(k)),
        companyIds: [...companies],
      };

/* ---------- invite (USR-1, PERM-6, TEN-7) ---------- */

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserAccess['role']>('child');
  const [tabs, setTabs] = useState<Set<UserTab>>(new Set());
  const [companies, setCompanies] = useState<Set<string>>(new Set());
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<{ email?: string; other?: string }>({});
  const [busy, setBusy] = useState(false);
  const localError = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
    ? 'Enter an email address, for example name@example.com'
    : undefined;
  const admin = role === 'admin';

  const send = async () => {
    setTried(true);
    setServerError({});
    if (localError) return;
    setBusy(true);
    const r = await usersApi.invite(email.trim(), accessOf(role, tabs, companies));
    setBusy(false);
    if (r.ok) {
      await qc.invalidateQueries({ queryKey: ['users'] });
      onOpenChange(false);
      toast({
        title: 'Invite sent',
        description: `${email.trim()} has 72 hours to accept.`,
        tone: 'success',
      });
      return;
    }
    if (isConflict(r))
      setServerError({ email: 'This person is already a member of this workspace' });
    else if (r.status === 422) setServerError({ email: 'Enter a valid email address' });
    else setServerError({ other: 'The invite could not be sent. Try again.' });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Invite a user"
      description="The invite link works once and expires after 72 hours. Give a child user the tabs and companies they need now; you can change them after they join."
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void send()}>
            Send invite
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Email" required error={serverError.email ?? (tried ? localError : undefined)}>
          <Input value={email} onChange={setEmail} type="email" autoComplete="off" autoFocus />
        </Field>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-13 font-medium">Role</legend>
          <RoleChoice role={role} onChange={setRole} name="invite-role" />
        </fieldset>
        {!admin && (
          <>
            <fieldset>
              <legend className="mb-2 text-13 font-medium">Tabs</legend>
              <TabTicks tabs={tabs} admin={false} onChange={setTabs} />
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-13 font-medium">Companies</legend>
              <CompanyTicks companies={companies} admin={false} onChange={setCompanies} />
            </fieldset>
          </>
        )}
        {serverError.other && <InlineError>{serverError.other}</InlineError>}
      </div>
    </Dialog>
  );
}

/* ---------- one user: role, tab ticks and company ticks (PERM-1..7) ---------- */

const userRoute = getRouteApi('/users/$userId');

export function UserDetailPage() {
  return (
    <TabGate tab="admin">
      <UserDetail />
    </TabGate>
  );
}

function BackToUsers() {
  return (
    <Link
      to="/users"
      className="-ml-1 inline-flex h-8 items-center gap-1 rounded-ctl px-1 text-13 text-ink-muted hover:text-ink"
    >
      <ChevronLeft className="size-4" aria-hidden /> Back to users
    </Link>
  );
}

function UserDetail() {
  const { userId } = userRoute.useParams();
  const q = useUsers();
  const u = q.data?.find((x) => x.id === userId);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 pt-3 pb-12 lg:px-6">
        <BackToUsers />
        {q.isError ? (
          <Card className="mt-4">
            <ErrorState
              title="This user could not load"
              body="The server did not answer. Try again."
              action={{ label: 'Try again', onClick: () => void q.refetch() }}
            />
          </Card>
        ) : q.data && !u ? (
          <Card className="mt-4">
            <EmptyState
              title="This user is not in the workspace"
              body="They may have been removed, or their invite revoked. Go back to the list."
            />
          </Card>
        ) : u && q.data ? (
          <UserForm
            u={u}
            admins={q.data.filter((x) => x.state === 'active' && x.role === 'admin').length}
          />
        ) : (
          <div aria-busy className="mt-4 h-64" />
        )}
      </div>
    </div>
  );
}

function UserForm({ u, admins }: { u: WorkspaceUser; admins: number }) {
  const { session } = useAppState();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [role, setRole] = useState(u.role);
  const [tabs, setTabs] = useState<Set<UserTab>>(new Set(u.tabs as UserTab[]));
  const [companies, setCompanies] = useState<Set<string>>(new Set(u.companyIds));
  const [confirming, setConfirming] = useState<'remove' | 'revoke'>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRole(u.role);
    setTabs(new Set(u.tabs as UserTab[]));
    setCompanies(new Set(u.companyIds));
  }, [u]);
  const invited = u.state === 'invited';
  const admin = role === 'admin';
  // PERM-7: the last admin cannot be demoted or removed. The server checks it too (409).
  const lastAdmin = u.role === 'admin' && admins <= 1;
  const demoteError =
    lastAdmin && role !== 'admin'
      ? 'This is the only admin. Make another user an admin first, then change this role.'
      : undefined;
  const allCompanies = session?.companies ?? [];
  const label = u.name || u.email;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const r = await usersApi.setAccess(u.id, accessOf(role, tabs, companies));
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ['users'] });
    if (r.ok) {
      toast({
        title: 'Access saved',
        description:
          'The change applies to the next page this user opens, and is in the audit log.',
        tone: 'success',
      });
      return;
    }
    setError(isConflict(r) ? LAST_ADMIN : 'The change could not be saved. Try again.');
  };

  const remove = async () => {
    setError(undefined);
    const r = invited ? await usersApi.revokeInvite(u.id) : await usersApi.remove(u.id);
    await qc.invalidateQueries({ queryKey: ['users'] });
    if (r.ok) {
      toast({ title: invited ? 'Invite revoked' : 'User removed', tone: 'success' });
      await navigate({ to: '/users' });
      return;
    }
    setError(
      isConflict(r)
        ? LAST_ADMIN
        : invited
          ? 'The invite could not be revoked. Try again.'
          : 'The user could not be removed. Try again.',
    );
  };

  return (
    <>
      <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">{label}</h1>
            <UserState u={u} />
          </div>
          <p className="mt-0.5 text-13 text-ink-muted">
            {invited
              ? 'Has not joined yet'
              : `${u.email} · Last sign-in ${lastSeen(u.lastSignInAt).toLowerCase()}`}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={lastAdmin}
            title={lastAdmin ? 'The only admin cannot be removed' : undefined}
            onClick={() => {
              setConfirming(invited ? 'revoke' : 'remove');
            }}
          >
            {invited ? 'Revoke invite' : 'Remove user'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <InlineError>{error}</InlineError>
        </div>
      )}

      {invited && (
        <p className="mt-4 flex items-center gap-1.5 text-13 text-ink-muted">
          <Mail className="size-4 shrink-0" aria-hidden />
          These ticks were set with the invite. You can change them once {u.email} has joined.
        </p>
      )}

      <Card title="Role" className="mt-5">
        <fieldset className="flex flex-col gap-3 px-5 py-4" disabled={invited}>
          <legend className="sr-only">Role</legend>
          <RoleChoice role={role} onChange={setRole} name="role" />
          {demoteError && <InlineError>{demoteError}</InlineError>}
        </fieldset>
      </Card>

      <Card
        title="Tabs this user can see"
        className="mt-5"
        aside={
          admin ? (
            <Badge>Admins see every tab</Badge>
          ) : (
            <span className="num text-ink-muted">
              {tabs.size} of {USER_TABS.length} ticked
            </span>
          )
        }
      >
        <fieldset className="px-5 py-4">
          <legend className="sr-only">Tabs</legend>
          <TabTicks tabs={tabs} admin={admin} disabled={invited} onChange={setTabs} />
          <p className="mt-3 text-xs text-ink-muted">
            {ADMIN_TABS.join(', ')} are admin-only and cannot be ticked.
          </p>
        </fieldset>
      </Card>

      <Card
        title="Companies this user can see"
        className="mt-5"
        aside={
          admin ? (
            <Badge>Admins see every company</Badge>
          ) : (
            <span className="num text-ink-muted">
              {companies.size} of {allCompanies.length} ticked
            </span>
          )
        }
      >
        <fieldset className="px-5 py-4">
          <legend className="sr-only">Companies</legend>
          <CompanyTicks
            companies={companies}
            admin={admin}
            disabled={invited}
            onChange={setCompanies}
          />
          {!admin && (tabs.size === 0 || companies.size === 0) && (
            <p className="mt-3 flex items-center gap-1.5 text-13 text-ink-muted">
              <CircleAlert className="size-4 shrink-0" aria-hidden />
              With no {tabs.size === 0 ? 'tabs' : 'companies'} ticked, this user sees nothing after
              signing in.
            </p>
          )}
        </fieldset>
      </Card>

      {!invited && (
        <div className="mt-5 flex justify-end gap-2">
          <Button
            onClick={() => {
              void navigate({ to: '/users' });
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={!!demoteError || busy} onClick={() => void save()}>
            Save access
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => {
          if (!o) setConfirming(undefined);
        }}
        destructive
        title={invited ? `Revoke the invite for ${u.email}?` : `Remove ${label}?`}
        description={
          invited
            ? 'The invite link stops working at once. You can invite them again later.'
            : 'They are signed out everywhere at once and can no longer sign in to this workspace. Their past actions stay in the audit log.'
        }
        confirmLabel={invited ? 'Revoke invite' : `Remove ${label}`}
        onConfirm={() => void remove()}
      />
    </>
  );
}

/* ---------- quarterly access review (USR-9) ---------- */

export function AccessReviewsPage() {
  return (
    <TabGate tab="admin">
      <AccessReviews />
    </TabGate>
  );
}

function AccessReviews() {
  const qc = useQueryClient();
  const toast = useToast();
  const reviews = useReviews();
  const usersQ = useUsers();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const due = openReview(reviews.data);
  const done = (reviews.data ?? [])
    .filter((r) => r.completedAt !== null)
    .sort((a, b) => b.dueAt.localeCompare(a.dueAt));
  const members = (usersQ.data ?? []).filter((u) => u.state === 'active');

  const complete = async (id: string) => {
    setBusy(true);
    setError(undefined);
    const r = await usersApi.completeReview(id);
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ['access-reviews'] });
    if (r.ok)
      toast({
        title: 'Access review complete',
        description: 'It is in the audit log.',
        tone: 'success',
      });
    else setError('The review could not be marked complete. Try again.');
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 pt-3 pb-12 lg:px-6">
        <BackToUsers />
        <div className="mt-2">
          <PageHeader
            title="Access reviews"
            sub="Every quarter, check that each person still needs the tabs and companies they have. Change anyone who does not on their user page, then mark the review complete."
          />
        </div>

        {reviews.isError ? (
          <Card className="mt-5">
            <ErrorState
              title="Access reviews could not load"
              body="The server did not answer. Try again."
              action={{ label: 'Try again', onClick: () => void reviews.refetch() }}
            />
          </Card>
        ) : !reviews.data ? (
          <div aria-busy className="mt-5 h-64" />
        ) : (
          <>
            <Card
              title={due ? `Review due ${formatDate(due.dueAt)}` : 'No review open'}
              className="mt-5"
              aside={
                due && (
                  <Button variant="primary" disabled={busy} onClick={() => void complete(due.id)}>
                    Mark review complete
                  </Button>
                )
              }
            >
              {due ? (
                <>
                  {error && (
                    <div className="px-5 pt-4">
                      <InlineError>{error}</InlineError>
                    </div>
                  )}
                  <SimpleTable
                    label="Current access"
                    head={[
                      { label: 'Name' },
                      { label: 'Role' },
                      { label: 'Tabs' },
                      { label: 'Companies' },
                    ]}
                  >
                    {members.map((m) => (
                      <Tr key={m.id}>
                        <Td>
                          <Stack
                            value={
                              <Link
                                to="/users/$userId"
                                params={{ userId: m.id }}
                                className="font-medium text-ink hover:text-brand-600 hover:underline"
                              >
                                {m.name}
                              </Link>
                            }
                            sub={m.email}
                          />
                        </Td>
                        <Td>{m.role === 'admin' ? 'Admin' : 'Child'}</Td>
                        <Td className="max-w-[320px] text-13">
                          {m.role === 'admin'
                            ? 'All tabs'
                            : USER_TABS.filter((t) => m.tabs.includes(t.key))
                                .map((t) => t.label)
                                .join(', ') || 'None'}
                        </Td>
                        <Td className="num whitespace-nowrap">
                          {m.role === 'admin' ? 'All' : String(m.companyIds.length)}
                        </Td>
                      </Tr>
                    ))}
                  </SimpleTable>
                </>
              ) : (
                <EmptyState
                  title="Nothing to review now"
                  body="The next review opens automatically at the start of the next quarter."
                />
              )}
            </Card>

            <Card title="Completed reviews" className="mt-5">
              {done.length === 0 ? (
                <EmptyState title="No reviews completed yet" body="Completed reviews show here." />
              ) : (
                <SimpleTable
                  label="Completed reviews"
                  head={[{ label: 'Due' }, { label: 'Completed' }]}
                >
                  {done.map((r) => (
                    <Tr key={r.id}>
                      <Td className="num">{formatDate(r.dueAt)}</Td>
                      <Td>
                        <StatusLabel tone="success" icon={CircleCheck}>
                          {r.completedAt ? formatDate(r.completedAt) : ''}
                        </StatusLabel>
                      </Td>
                    </Tr>
                  ))}
                </SimpleTable>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
