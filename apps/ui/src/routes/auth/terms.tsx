import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { authApi, type ApiProblem } from '../../auth/api.ts';
import type { TermsAccepted, TermsInfo } from '../../auth/shapes.ts';
import { Button } from '../../kit/Button.tsx';
import { formatDate } from '../../lib/format.ts';
import { AuthFrame, Notice, authLink } from './layout.tsx';
import { useEnterApp } from './parts.tsx';

type Failure = 'stale' | 'error';

/**
 * Accept the terms (WWW-7, T-0603). Shown when MFA answers `next: 'terms'`: on the first sign-in
 * and after a material change. Nothing in the app opens until the current version is accepted;
 * the acceptance is logged with this version by the server.
 */
export function TermsPage() {
  const enter = useEnterApp();
  const qc = useQueryClient();
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const terms = useQuery({
    queryKey: ['auth', 'terms'],
    queryFn: async () => {
      const r = await authApi.terms();
      if (!r.ok) throw new Error(String(r.status));
      return r.body as TermsInfo;
    },
  });

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (!terms.data || !ticked) return;
    setBusy(true);
    setFailure(undefined);
    const r = await authApi.acceptTerms(terms.data.version);
    setBusy(false);
    if (r.ok) {
      await enter((r.body as TermsAccepted).next === 'workspace_picker' ? '/workspaces' : '/');
      return;
    }
    const stale =
      r.status === 422 && (r.body as ApiProblem | undefined)?.code === 'validation_failed';
    setFailure(stale ? 'stale' : 'error');
    if (stale) {
      setTicked(false);
      await qc.invalidateQueries({ queryKey: ['auth', 'terms'] });
    }
  };

  const below = (
    <Link to="/sign-in" className={authLink}>
      Sign out
    </Link>
  );

  if (terms.isError) {
    return (
      <AuthFrame title="Accept the terms" below={below}>
        <Notice tone="danger" title="The terms could not be loaded. Try again." />
        <Button
          variant="secondary"
          size="lg"
          className="mt-5 w-full"
          onClick={() => void terms.refetch()}
        >
          Try again
        </Button>
      </AuthFrame>
    );
  }

  const version = terms.data ? formatDate(`${terms.data.version}T12:00:00Z`) : undefined;

  return (
    <AuthFrame
      title="Accept the terms"
      intro="Before you continue, read and accept the OmniBridge terms of service and privacy policy."
      below={below}
    >
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-5">
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
          {(
            [
              ['Terms of service', terms.data?.termsUrl],
              ['Privacy policy', terms.data?.privacyUrl],
            ] as const
          ).map(([label, href]) => (
            <li key={label} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="font-medium">{label}</span>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className={`${authLink} inline-flex items-center gap-1 text-13`}
                >
                  Read
                  <ExternalLink className="size-3.5" aria-hidden />
                  <span className="sr-only">the {label.toLowerCase()} (opens in a new tab)</span>
                </a>
              ) : (
                <span className="h-4 w-12" aria-hidden />
              )}
            </li>
          ))}
        </ul>
        <p className="text-13 text-ink-muted tabular-nums">
          {version ? `Version of ${version}.` : ' '}
        </p>
        <label className="flex items-start gap-2.5 text-13">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={ticked}
            disabled={!terms.data}
            onChange={(e) => {
              setTicked(e.target.checked);
            }}
          />
          I have read and accept the terms of service and the privacy policy
        </label>
        {failure === 'stale' && (
          <Notice tone="warning" title="The terms changed while this page was open.">
            Read the new version above, then accept it.
          </Notice>
        )}
        {failure === 'error' && (
          <Notice tone="danger" title="Something went wrong on our side. Try again." />
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!ticked || !terms.data || busy}
        >
          Accept and continue
        </Button>
      </form>
    </AuthFrame>
  );
}
