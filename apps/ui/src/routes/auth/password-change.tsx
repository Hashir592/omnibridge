import { Link } from '@tanstack/react-router';
import { useState, type SyntheticEvent } from 'react';
import { Button, buttonClass } from '../../kit/Button.tsx';
import { Field, Input } from '../../kit/Field.tsx';
import { cn } from '../../lib/cn.ts';
import { AuthFrame, Notice, authLink } from './layout.tsx';
import { PasswordRules, passwordLocallyValid, personalParts } from './parts.tsx';

/** Synthetic demo user for the mock-up; the real screen gets the name and email from the session. */
const DEMO = { name: 'Sam Admin', email: 'sam.admin@example.com' };

/**
 * Change password (USR-3), shown when sign-in answers `next: password_change` because the
 * password is over 365 days old; that session can do nothing else. PROPOSED SHAPE:
 * POST /auth/password/change {current, password} → 204, 401 for a wrong current password,
 * 422 with the failed rule id (length, personal, breached, history, min_age).
 * Mock-up only: nothing is sent yet.
 */
export function PasswordChangePage() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; password?: string; confirm?: string }>(
    {},
  );
  const [done, setDone] = useState(false);
  const personal = personalParts(DEMO.name, DEMO.email);

  if (done) {
    return (
      <AuthFrame title="Password changed">
        <p className="text-13 text-ink-muted">
          Your new password works from now on. Other devices were signed out.
        </p>
        <Link to="/" className={cn(buttonClass('primary', 'lg'), 'mt-5 w-full')}>
          Continue to OmniBridge
        </Link>
      </AuthFrame>
    );
  }

  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const next = {
      ...(current === '' ? { current: 'Enter your current password' } : {}),
      ...(passwordLocallyValid(password, personal)
        ? password === current
          ? { password: 'Choose a password you have not used before' }
          : {}
        : { password: 'Your password does not meet the rules below' }),
      ...(confirm === password ? {} : { confirm: 'The passwords do not match' }),
    };
    setErrors(next);
    if (next.current || next.password || next.confirm) return;
    setDone(true);
  };

  return (
    <AuthFrame
      title="Choose a new password"
      intro={
        <>
          Your password for <span className="font-medium text-ink">s***@example.com</span> is over a
          year old. Change it to carry on.
        </>
      }
      below={
        <Link to="/sign-in" className={authLink}>
          Sign out
        </Link>
      }
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <Notice tone="info" title="Passwords expire after 365 days." />
        <Field label="Current password" error={errors.current}>
          <Input
            type="password"
            name="current-password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={setCurrent}
          />
        </Field>
        <Field label="New password" error={errors.password}>
          <Input
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
          />
        </Field>
        <PasswordRules password={password} personal={personal} />
        <Field label="Confirm new password" error={errors.confirm}>
          <Input
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full">
          Change password
        </Button>
      </form>
    </AuthFrame>
  );
}
