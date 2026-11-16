import { Link } from '@tanstack/react-router';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '../../kit/Button.tsx';
import { Field, Input } from '../../kit/Field.tsx';
import { authApi, type ApiReply } from '../../auth/api.ts';
import type { MfaResult } from '../../auth/shapes.ts';
import { AuthFrame, Notice, authLink } from './layout.tsx';
import { CodeField, useEnterApp } from './parts.tsx';

type Failure = 'invalid' | 'locked' | 'error';

/**
 * After MFA: a password over a year old must be changed first (USR-3); then the terms if they
 * changed (WWW-7); else the workspace picker or the app.
 */
function useAfterMfa() {
  const enter = useEnterApp();
  return (r: ApiReply<MfaResult>) => {
    const next = (r.body as MfaResult).next;
    return enter(
      next === 'password_change'
        ? '/sign-in/password-change'
        : next === 'terms'
          ? '/sign-in/terms'
          : next === 'workspace_picker'
            ? '/workspaces'
            : '/',
    );
  };
}

function failureOf(status: number): Failure {
  if (status === 401) return 'invalid';
  if (status === 429) return 'locked';
  return 'error';
}

function FailureNotice({ failure, invalid }: { failure: Failure | undefined; invalid: string }) {
  if (failure === 'invalid') return <Notice tone="danger" title={invalid} />;
  if (failure === 'locked')
    return (
      <Notice tone="danger" title="Too many failed attempts">
        Sign in is paused for 15 minutes.
      </Notice>
    );
  if (failure === 'error')
    return <Notice tone="danger" title="Something went wrong on our side. Try again." />;
  return null;
}

/** Second step of sign in: the 6-digit code from the authenticator app (USR-4). */
export function CodePage() {
  const afterMfa = useAfterMfa();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<Failure>();
  const [busy, setBusy] = useState(false);

  const verify = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const r = await authApi.verifyCode(value);
      if (r.ok) {
        await afterMfa(r);
        return;
      }
      setCode('');
      setFailure(failureOf(r.status));
    } catch {
      setFailure('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Enter your code"
      intro="Open your authenticator app and enter the 6-digit code for OmniBridge."
      below={
        <Link to="/sign-in" className={authLink}>
          Back to sign in
        </Link>
      }
    >
      <form
        noValidate
        onSubmit={(e: SyntheticEvent) => {
          e.preventDefault();
          void verify(code);
        }}
        className="flex flex-col gap-4"
      >
        <CodeField
          value={code}
          onChange={(v) => {
            setCode(v);
            // Submits by itself once all six digits are in, as most authenticator flows do.
            if (v.length === 6) void verify(v);
          }}
        />
        <FailureNotice
          failure={failure}
          invalid="That code did not work. Codes change every 30 seconds, so use the current one."
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={busy || code.length !== 6}
          className="w-full"
        >
          {busy ? 'Checking…' : 'Continue'}
        </Button>
        <p className="text-13 text-ink-muted">
          Lost your phone?{' '}
          <Link to="/sign-in/recovery" className={authLink}>
            Use a recovery code
          </Link>
        </p>
      </form>
    </AuthFrame>
  );
}

/** Sign in with one of the 10 single-use recovery codes (USR-4). */
export function RecoveryPage() {
  const afterMfa = useAfterMfa();
  const [code, setCode] = useState('');
  const [missing, setMissing] = useState<string>();
  const [failure, setFailure] = useState<Failure>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setMissing('Enter a recovery code');
      return;
    }
    setMissing(undefined);
    setBusy(true);
    setFailure(undefined);
    try {
      const r = await authApi.recovery(code.trim());
      if (r.ok) {
        await afterMfa(r);
        return;
      }
      setFailure(failureOf(r.status));
    } catch {
      setFailure('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      title="Use a recovery code"
      intro="Enter one of the recovery codes you saved when you set up two-step sign in. Each code works once."
      below={
        <Link to="/sign-in/code" className={authLink}>
          Use your authenticator app instead
        </Link>
      }
    >
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        <Field label="Recovery code" hint="For example: abcde-12345" error={missing}>
          <Input
            name="recovery-code"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            value={code}
            onChange={setCode}
            className="num"
          />
        </Field>
        <FailureNotice
          failure={failure}
          invalid="That recovery code is not valid or was already used."
        />
        <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
          {busy ? 'Checking…' : 'Continue'}
        </Button>
        <p className="text-13 text-ink-muted">
          No codes left? Your workspace admin can reset two-step sign in for you.
        </p>
      </form>
    </AuthFrame>
  );
}
