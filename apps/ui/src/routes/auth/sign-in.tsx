import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '../../kit/Button.tsx';
import { Field, Input } from '../../kit/Field.tsx';
import { authApi } from '../../mocks/api.ts';
import type { SignInResult } from '../../mocks/auth.ts';
import { AuthFrame, Notice, authLink } from './layout.tsx';

type Failure = { kind: 'invalid' } | { kind: 'locked'; minutes: number } | { kind: 'error' };

/**
 * Sign in (USR-4, USR-5). Unknown email and wrong password get the same message, and the lockout
 * message never says whether the email has an account (no account enumeration).
 */
export function SignInPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [missing, setMissing] = useState<{ email?: string; password?: string }>({});
  const [failure, setFailure] = useState<Failure>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const m = {
      ...(email.trim() ? {} : { email: 'Enter your email' }),
      ...(password ? {} : { password: 'Enter your password' }),
    };
    setMissing(m);
    if (m.email || m.password) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const r = await authApi.signIn(email.trim(), password);
      if (r.ok) {
        const { next } = r.body as SignInResult;
        await navigate({ to: next === 'mfa_setup' ? '/sign-in/set-up-mfa' : '/sign-in/code' });
        return;
      }
      setPassword('');
      if (r.status === 429) {
        setFailure({ kind: 'locked', minutes: Math.max(1, Math.ceil((r.retryAfter ?? 900) / 60)) });
      } else if (r.status === 401) {
        setFailure({ kind: 'invalid' });
      } else {
        setFailure({ kind: 'error' });
      }
    } catch {
      setFailure({ kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Sign in"
      intro="Use the email your workspace admin invited."
      below={
        <>OmniBridge is invite-only. If you do not have an account, ask your workspace admin.</>
      }
    >
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Email" error={missing.email}>
          <Input
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoFocus
            value={email}
            onChange={setEmail}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <Field label="Password" error={missing.password}>
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
            />
          </Field>
          <Link to="/forgot-password" className={`self-end text-13 ${authLink}`}>
            Forgot password?
          </Link>
        </div>
        {failure?.kind === 'invalid' && (
          <Notice tone="danger" title="Email or password is incorrect." />
        )}
        {failure?.kind === 'locked' && (
          <Notice tone="danger" title="Too many failed attempts">
            Sign in for this email is paused. Try again in {failure.minutes}{' '}
            {failure.minutes === 1 ? 'minute' : 'minutes'}. If the email has an account, its owner
            and the workspace admins have been told.
          </Notice>
        )}
        {failure?.kind === 'error' && (
          <Notice tone="danger" title="Could not sign in">
            Something went wrong on our side. Try again in a moment.
          </Notice>
        )}
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthFrame>
  );
}
