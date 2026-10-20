import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button, buttonClass } from '../../kit/Button.tsx';
import { cn } from '../../lib/cn.ts';
import { Field, Input } from '../../kit/Field.tsx';
import { authApi, type MockProblem } from '../../mocks/api.ts';
import type { ResetTokenInfo } from '../../auth/shapes.ts';
import { AuthFrame, Notice, authLink } from './layout.tsx';
import { PasswordRules, passwordLocallyValid } from './parts.tsx';

const backToSignIn = (
  <Link to="/sign-in" className={authLink}>
    Back to sign in
  </Link>
);

/**
 * Forgot password (USR-7). The answer is the same whether or not the email has an account, so the
 * page cannot be used to find out who has one.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [missing, setMissing] = useState<string>();
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setMissing('Enter your email');
      return;
    }
    setMissing(undefined);
    setBusy(true);
    setFailed(false);
    try {
      const r = await authApi.forgot(email.trim());
      if (r.ok) setSent(true);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthFrame title="Check your email" below={backToSignIn}>
        <p className="text-13 text-ink-muted">
          If an account uses <span className="font-medium text-ink">{email.trim()}</span>, we have
          sent it a link to choose a new password. The link works for 30 minutes.
        </p>
        <p className="mt-3 text-13 text-ink-muted">
          Nothing there? Check your spam folder, or{' '}
          <button
            className={authLink}
            onClick={() => {
              setSent(false);
            }}
          >
            try a different email
          </button>
          .
        </p>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Reset your password"
      intro="Enter your work email and we will send you a link to choose a new password."
      below={backToSignIn}
    >
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Email" error={missing}>
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
        {failed && <Notice tone="danger" title="Something went wrong on our side. Try again." />}
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthFrame>
  );
}

/** Shown for an unknown, used or expired reset or invite link (one message for all three). */
export function LinkUnusable({ what, next }: { what: 'reset' | 'invite'; next: ReactNode }) {
  return (
    <AuthFrame
      title="This link no longer works"
      intro={
        what === 'reset'
          ? 'Password reset links work once, for 30 minutes.'
          : 'Invite links work once, for 72 hours.'
      }
    >
      <div className="text-13">{next}</div>
    </AuthFrame>
  );
}

/** Choose a new password from the emailed link (USR-3, USR-7). MFA still applies afterwards. */
export function ResetPasswordPage() {
  const { token = '' } = useSearch({ from: '/reset-password' });
  const info = useQuery({
    queryKey: ['reset-token', token],
    queryFn: async () => {
      const r = await authApi.resetInfo(token);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      return r.body as ResetTokenInfo;
    },
    enabled: token !== '',
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [result, setResult] = useState<'done' | 'breached' | 'gone' | 'error'>();
  const [busy, setBusy] = useState(false);

  if (token === '' || info.data === null || result === 'gone') {
    return (
      <LinkUnusable
        what="reset"
        next={
          <Link to="/forgot-password" className={authLink}>
            Send a new reset link
          </Link>
        }
      />
    );
  }

  if (result === 'done') {
    return (
      <AuthFrame title="Password changed">
        <p className="text-13 text-ink-muted">
          Sign in with your new password. You will still need the code from your authenticator app.
        </p>
        <Link to="/sign-in" className={cn(buttonClass('primary', 'lg'), 'mt-5 w-full')}>
          Go to sign in
        </Link>
      </AuthFrame>
    );
  }

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const next = {
      ...(passwordLocallyValid(password, [])
        ? {}
        : { password: 'Your password does not meet the rules below' }),
      ...(confirm === password ? {} : { confirm: 'The passwords do not match' }),
    };
    setErrors(next);
    if (next.password || next.confirm) return;
    setBusy(true);
    setResult(undefined);
    try {
      const r = await authApi.reset(token, password);
      if (r.ok) setResult('done');
      else if (r.status === 404) setResult('gone');
      else if (r.status === 422) {
        const rule = (r.body as MockProblem).errors?.[0]?.message;
        setResult(rule === 'breached' ? 'breached' : 'error');
      } else setResult('error');
    } catch {
      setResult('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Choose a new password"
      intro={
        info.data ? (
          <>
            For <span className="font-medium text-ink">{info.data.emailMasked}</span>
          </>
        ) : (
          ' '
        )
      }
      below={backToSignIn}
    >
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="New password" error={errors.password}>
          <Input
            type="password"
            name="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={setPassword}
          />
        </Field>
        <PasswordRules password={password} personal={[]} />
        <Field label="Confirm new password" error={errors.confirm}>
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
        {info.isError && (
          <Notice tone="danger" title="Could not check this link. Reload the page." />
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={busy || !info.data}
          className="w-full"
        >
          {busy ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </AuthFrame>
  );
}
