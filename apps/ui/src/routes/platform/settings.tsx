import { Field as BaseField } from '@base-ui/react/field';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { platformApi, type ApiProblem, type IncidentInput } from '../../auth/api.ts';
import type { Incident } from '../../auth/shapes.ts';
import { Card, DetailRow } from '../../components/Card.tsx';
import { IncidentLine } from '../../components/IncidentLine.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog } from '../../kit/Dialog.tsx';
import { Field } from '../../kit/Field.tsx';
import { Select } from '../../kit/Select.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { formatDateTime } from '../../lib/format.ts';
import { CONSOLE, ConsoleFailure, Loading, refusal } from './parts.tsx';
import { incidentProblem, INCIDENT_MAX } from './rules.ts';

const INCIDENT_KEY = [CONSOLE, 'incident'] as const;

const SEVERITIES: Array<{ value: Incident['severity']; label: string }> = [
  { value: 'info', label: 'Notice' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Incident' },
];

/**
 * PLAT-2: the incident banner every signed-in user sees as a line across the app. Plain text,
 * 1 to 200 characters, no email address (PS-032). Setting and clearing are audited.
 */
export function IncidentSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const current = useQuery({ queryKey: INCIDENT_KEY, queryFn: platformApi.incident });
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<Incident['severity']>('warning');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [askClear, setAskClear] = useState(false);

  const after = async () => {
    await qc.invalidateQueries({ queryKey: INCIDENT_KEY });
    // The console's own line comes from GET /auth/session.
    await qc.invalidateQueries({ queryKey: ['auth-session'] });
  };

  const set = useMutation({
    mutationFn: (input: IncidentInput) => platformApi.setIncident(input),
    onSuccess: (r) => {
      if (r.ok) {
        setError(undefined);
        setMessage('');
        setTouched(false);
        toast({ title: 'Banner shown to everyone', tone: 'success' });
        return;
      }
      setError(
        r.status === 422
          ? ((r.body as ApiProblem | undefined)?.errors?.[0]?.message ??
              'The message is not allowed.')
          : (refusal(r.status) ?? 'The banner could not be saved. Try again.'),
      );
    },
    onError: () => {
      setError('The banner could not be saved. Try again.');
    },
    onSettled: after,
  });

  const clear = useMutation({
    mutationFn: () => platformApi.clearIncident(),
    onSuccess: (r) => {
      if (r.ok) {
        setError(undefined);
        toast({ title: 'Banner cleared', tone: 'success' });
      } else setError(refusal(r.status) ?? 'The banner could not be cleared. Try again.');
    },
    onError: () => {
      setError('The banner could not be cleared. Try again.');
    },
    onSettled: after,
  });

  const problem = incidentProblem(message);
  const shown = touched ? problem : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Card title="Showing now">
        {current.isError ? (
          <ConsoleFailure error={current.error} retry={() => void current.refetch()} />
        ) : current.isPending ? (
          <Loading />
        ) : current.data === null ? (
          <p className="px-5 py-4 text-13 text-ink-muted">No banner. Nobody sees one.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3 py-2 pr-5">
            <div className="min-w-0 flex-1">
              <IncidentLine incident={current.data} />
            </div>
            <span className="text-xs text-ink-muted">
              Set {formatDateTime(current.data.set_at)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={clear.isPending}
              onClick={() => {
                setAskClear(true);
              }}
            >
              Clear banner
            </Button>
          </div>
        )}
      </Card>

      <Card title={current.data ? 'Replace the banner' : 'Show a banner'}>
        <form
          className="flex max-w-xl flex-col gap-4 px-5 py-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (problem) return;
            set.mutate({ message: message.trim(), severity });
          }}
        >
          <Field
            label="Message"
            hint={`Plain text everyone signed in sees, up to ${String(INCIDENT_MAX)} characters. No email addresses.`}
            error={shown}
          >
            <BaseField.Control
              render={<textarea rows={3} maxLength={INCIDENT_MAX + 50} />}
              value={message}
              onValueChange={(v) => {
                setMessage(v);
              }}
              onBlur={() => {
                if (message !== '') setTouched(true);
              }}
              className="h-auto w-full rounded-ctl border border-border bg-card px-3 py-2 text-13 text-ink shadow-card outline-none placeholder:text-ink-muted focus:border-brand-600 data-[invalid]:border-danger"
              placeholder="For example: eBay orders are arriving late. We are on it."
            />
          </Field>
          <p className="-mt-2 text-xs text-ink-muted num" aria-live="polite">
            {message.trim().length} of {INCIDENT_MAX}
          </p>
          <Field label="Severity">
            <Select
              label="Severity"
              className="w-48"
              options={SEVERITIES}
              value={severity}
              onChange={(v) => {
                if (v) setSeverity(v as Incident['severity']);
              }}
            />
          </Field>
          {error && (
            <p role="alert" className="text-13 text-danger">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={set.isPending}>
              {set.isPending ? 'Saving…' : 'Show banner'}
            </Button>
          </div>
        </form>
      </Card>
      <ConfirmDialog
        open={askClear}
        onOpenChange={setAskClear}
        title="Clear the banner?"
        description="It disappears for everyone within a minute."
        confirmLabel="Clear banner"
        onConfirm={() => {
          clear.mutate();
        }}
      />
    </div>
  );
}

const FLAGS_KEY = [CONSOLE, 'flags'] as const;

/** PLAT-2: platform flags. Open self sign-up (TEN-8) is off at launch; every change is audited. */
export function FlagsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const flags = useQuery({ queryKey: FLAGS_KEY, queryFn: platformApi.flags });
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (on: boolean) => platformApi.setFlags({ public_signup: on }),
    onSuccess: (r, on) => {
      if (r.ok) {
        setError(undefined);
        toast({ title: on ? 'Self sign-up on' : 'Self sign-up off', tone: 'success' });
      } else setError(refusal(r.status) ?? 'The flag could not be saved. Try again.');
    },
    onError: () => {
      setError('The flag could not be saved. Try again.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: FLAGS_KEY }),
  });

  return (
    <Card title="Flags">
      {flags.isError ? (
        <ConsoleFailure error={flags.error} retry={() => void flags.refetch()} />
      ) : flags.isPending ? (
        <Loading />
      ) : (
        <div className="max-w-xl px-5 py-2">
          <dl>
            <DetailRow label="Open self sign-up">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={flags.data.public_signup}
                  disabled={save.isPending}
                  onChange={(e) => {
                    save.mutate(e.target.checked);
                  }}
                />
                <span>
                  <span className="sr-only">Open self sign-up: </span>
                  {flags.data.public_signup ? 'On' : 'Off'}
                </span>
              </label>
            </DetailRow>
            <DetailRow label="Last changed">
              {flags.data.updated_at ? formatDateTime(flags.data.updated_at) : 'Never'}
            </DetailRow>
          </dl>
          {error && (
            <p role="alert" className="py-2 text-13 text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
