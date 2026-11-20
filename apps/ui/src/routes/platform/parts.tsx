import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ConsoleError } from '../../auth/api.ts';
import { ErrorState } from '../../kit/states.tsx';

/** Every console query key starts with this, so leaving or entering the console drops them all. */
export const CONSOLE = 'platform-console';

/**
 * What a console section shows when its read failed. 401: the session ended, so sign in again.
 * 403: the server no longer lets this session in (flag removed, MFA reset, or off the allowlist).
 */
export function ConsoleFailure({ error, retry }: { error: unknown; retry: () => void }) {
  const navigate = useNavigate();
  const status = error instanceof ConsoleError ? error.status : 0;
  useEffect(() => {
    if (status === 401) void navigate({ to: '/sign-in' });
  }, [status, navigate]);
  if (status === 403) {
    return (
      <ErrorState
        title="The console is not open to this session"
        body="It needs a platform operator with two-step verification, on the office network or VPN."
      />
    );
  }
  return (
    <ErrorState
      title="This could not be loaded"
      body="The server did not answer. Try again in a moment."
      action={{ label: 'Try again', onClick: retry }}
    />
  );
}

/**
 * Why a console change was refused, for 401 and 403; undefined for anything else, so the caller
 * keeps its own message. Retrying cannot fix either, so the text says what will.
 */
export function refusal(status: number): string | undefined {
  if (status === 401) return 'Your session has ended. Sign in again to make changes.';
  if (status === 403) {
    return 'The console refused this. It needs a platform operator with two-step verification, on the office network or VPN.';
  }
  return undefined;
}

/** Loading line inside a console card. */
export function Loading() {
  return (
    <p className="px-5 py-8 text-13 text-ink-muted" aria-busy>
      Loading…
    </p>
  );
}
