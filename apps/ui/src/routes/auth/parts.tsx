import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, Circle, Clock } from 'lucide-react';
import { Field, Input } from '../../kit/Field.tsx';
import { cn } from '../../lib/cn.ts';
import { PASSWORD_RULES } from '../../auth/shapes.ts';

/** A 6-digit authenticator code. Keeps digits only; the phone keyboard shows numbers. */
export function CodeField({
  label = 'Authentication code',
  value,
  onChange,
  error,
  autoFocus = true,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  /** Off where instructions come before the field (MFA set-up). */
  autoFocus?: boolean;
}) {
  return (
    <Field label={label} error={error}>
      <Input
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        maxLength={6}
        autoFocus={autoFocus}
        value={value}
        onChange={(v) => {
          onChange(v.replace(/\D/g, '').slice(0, 6));
        }}
        className="num h-11 text-center text-lg tracking-[0.4em]"
      />
    </Field>
  );
}

type RuleState = 'met' | 'unmet' | 'server';

/** The USR-3 rules the browser can check; the rest are checked by the server on save. */
function localChecks(password: string, personal: string[]) {
  const lower = password.toLowerCase();
  const parts = personal.map((p) => p.trim().toLowerCase()).filter((p) => p.length >= 3);
  return {
    length: password.length >= 12,
    /** Undefined when nothing personal is known (reset page): the server checks it. */
    personal: parts.length === 0 ? undefined : !!password && !parts.some((p) => lower.includes(p)),
  };
}

/**
 * The USR-3 password rules as a live checklist. Length and the personal-details rule are checked
 * as the user types; leaked-password and history checks happen on the server when they save.
 */
export function PasswordRules({
  password,
  personal,
}: {
  password: string;
  /** Name and email local part that the password must not contain. Empty when unknown. */
  personal: string[];
}) {
  const checks = localChecks(password, personal);
  const state = (id: (typeof PASSWORD_RULES)[number]['id']): RuleState => {
    if (id === 'length') return checks.length ? 'met' : 'unmet';
    if (id === 'personal') {
      if (checks.personal === undefined) return 'server';
      return checks.personal ? 'met' : 'unmet';
    }
    return 'server';
  };
  return (
    <ul aria-label="Password rules" className="flex flex-col gap-1.5 text-13">
      {PASSWORD_RULES.map((r) => {
        const s = state(r.id);
        return (
          <li
            key={r.id}
            className={cn('flex items-start gap-2', s === 'met' ? 'text-ink' : 'text-ink-muted')}
          >
            <span className="mt-0.5 shrink-0">
              {s === 'met' && <Check className="size-3.5 text-success" aria-hidden />}
              {s === 'unmet' && <Circle className="size-3.5" aria-hidden />}
              {s === 'server' && <Clock className="size-3.5" aria-hidden />}
            </span>
            <span>
              {r.label}
              {s === 'server' && <span className="text-ink-muted">, checked when you save</span>}
              {s !== 'server' && (
                <span className="sr-only">{s === 'met' ? ' (done)' : ' (not yet)'}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** True when the locally checkable USR-3 rules pass. */
export function passwordLocallyValid(password: string, personal: string[]): boolean {
  const checks = localChecks(password, personal);
  return checks.length && checks.personal !== false;
}

/** Words of a name plus the email local part, for the USR-3 "personal details" rule. */
export function personalParts(name: string, email: string): string[] {
  return [...name.split(/\s+/), email.split('@')[0] ?? ''];
}

/**
 * Leaves the auth screens for the app (or the workspace picker). Drops every cached query first,
 * so the app never shows data or a session from before this sign in.
 */
export function useEnterApp() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async (to: '/' | '/workspaces' | '/sign-in/terms' | '/sign-in/password-change') => {
    qc.removeQueries();
    await navigate({ to });
  };
}
