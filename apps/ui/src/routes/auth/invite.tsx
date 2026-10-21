import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '../../kit/Button.tsx';
import { Field, Input } from '../../kit/Field.tsx';
import { Skeleton } from '../../kit/Skeleton.tsx';
import { authApi, type ApiProblem } from '../../auth/api.ts';
import { inviteApi } from '../../mocks/api.ts';
import type { InviteInfo, WorkspaceChoice } from '../../auth/shapes.ts';
import { AuthFrame, Notice } from './layout.tsx';
import { LinkUnusable } from './password.tsx';
import { PasswordRules, passwordLocallyValid, personalParts, useEnterApp } from './parts.tsx';

/**
 * Accept an invite (TEN-7: invite-only, link valid 72 hours). The new user sets their name and a
 * password (USR-3), then goes straight to MFA set-up (USR-4).
 */
export function AcceptInvitePage() {
  const { token } = useParams({ from: '/invite/$token' });
  const navigate = useNavigate();
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: async () => {
      const r = await inviteApi.invite(token);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      return r.body as InviteInfo;
    },
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ name?: string; password?: string; confirm?: string }>({});
  const [result, setResult] = useState<'breached' | 'gone' | 'error'>();
  const [busy, setBusy] = useState(false);

  if (invite.data === null || result === 'gone') {
    return (
      <LinkUnusable
        what="invite"
        next={<p className="text-ink-muted">Ask your workspace admin to send you a new invite.</p>}
      />
    );
  }

  const personal = personalParts(name, invite.data?.email ?? '');

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const next = {
      ...(name.trim() ? {} : { name: 'Enter your full name' }),
      ...(passwordLocallyValid(password, personal)
        ? {}
        : { password: 'Your password does not meet the rules below' }),
      ...(confirm === password ? {} : { confirm: 'The passwords do not match' }),
    };
    setErrors(next);
    if (next.name || next.password || next.confirm) return;
    setBusy(true);
    setResult(undefined);
    try {
      const r = await inviteApi.acceptInvite(token, name.trim(), password);
      if (r.ok) {
        await navigate({ to: '/sign-in/set-up-mfa' });
        return;
      }
      if (r.status === 404) setResult('gone');
      else if (r.status === 422 && (r.body as ApiProblem).errors?.[0]?.message === 'breached')
        setResult('breached');
      else setResult('error');
    } catch {
      setResult('error');
    } finally {
      setBusy(false);
    }
  };

  const d = invite.data;
  return (
    <AuthFrame
      title={d ? `Join ${d.workspaceName}` : 'Join your workspace'}
      intro={
        d ? (
          <>
            {d.invitedBy} invited <span className="font-medium text-ink">{d.email}</span>. Set up
            your account to continue.
          </>
        ) : (
          <Skeleton className="h-4 w-64" />
        )
      }
    >
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Full name" error={errors.name}>
          <Input name="name" autoComplete="name" autoFocus value={name} onChange={setName} />
        </Field>
        <Field label="Password" error={errors.password}>
          <Input
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
          />
        </Field>
        <PasswordRules password={password} personal={personal} />
        <Field label="Confirm password" error={errors.confirm}>
          <Input
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
          />
        </Field>
        {result === 'breached' && (
          <Notice tone="danger" title="This password appears in a list of leaked passwords.">
            Choose a different one.
          </Notice>
        )}
        {result === 'error' && (
          <Notice tone="danger" title="Something went wrong on our side. Try again." />
        )}
        {invite.isError && (
          <Notice tone="danger" title="Could not check this invite. Reload the page." />
        )}
        <Button type="submit" variant="primary" size="lg" disabled={busy || !d} className="w-full">
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
        <p className="text-13 text-ink-muted">
          Next, you will set up two-step sign in with an authenticator app.
        </p>
      </form>
    </AuthFrame>
  );
}

/** Pick a workspace after sign in, for users who belong to more than one. */
export function WorkspacesPage() {
  const enter = useEnterApp();
  const list = useQuery({
    queryKey: ['auth-workspaces'],
    queryFn: async () => {
      const r = await authApi.workspaces();
      if (!r.ok) throw new Error(String(r.status));
      return r.body as WorkspaceChoice[];
    },
  });
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState(false);

  const choose = async (id: string) => {
    setBusy(id);
    setFailed(false);
    try {
      const r = await authApi.chooseWorkspace(id);
      if (r.ok) {
        await enter('/');
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <AuthFrame
      title="Choose a workspace"
      intro="You belong to more than one. You can switch later."
    >
      {list.isError ? (
        <Notice tone="danger" title="Could not load your workspaces">
          <button
            className="font-medium text-brand-600 hover:underline"
            onClick={() => void list.refetch()}
          >
            Try again
          </button>
        </Notice>
      ) : (
        <ul aria-label="Workspaces" className="-mx-2 flex flex-col">
          {(list.data ?? []).map((w) => (
            <li key={w.id}>
              <button
                disabled={!!busy}
                onClick={() => void choose(w.id)}
                className="flex w-full items-center gap-3 rounded-ctl px-2 py-2.5 text-left hover:bg-hover disabled:opacity-60"
              >
                <span
                  aria-hidden
                  className="grid size-9 shrink-0 place-items-center rounded-ctl bg-surface text-13 font-semibold text-ink-muted"
                >
                  {w.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{w.name}</span>
                  <span className="block text-xs text-ink-muted">
                    {w.role === 'admin' ? 'Admin' : 'Member'} · {w.companies}{' '}
                    {w.companies === 1 ? 'company' : 'companies'}
                  </span>
                </span>
                <ChevronRight className="size-4 text-ink-muted" aria-hidden />
              </button>
            </li>
          ))}
          {!list.data &&
            [0, 1].map((i) => (
              <li key={i} className="flex items-center gap-3 px-2 py-2.5">
                <Skeleton className="size-9 rounded-ctl" />
                <Skeleton className="h-4 w-40" />
              </li>
            ))}
        </ul>
      )}
      {failed && (
        <Notice tone="danger" title="Could not open that workspace. Try again." className="mt-3" />
      )}
    </AuthFrame>
  );
}
