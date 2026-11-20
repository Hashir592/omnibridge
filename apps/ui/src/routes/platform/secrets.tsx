import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  platformApi,
  type AppSecretName,
  type AppSecretStatus,
  type SecretSlot,
} from '../../auth/api.ts';
import { Card, SimpleTable, Stack, Td, Tr } from '../../components/Card.tsx';
import { Button } from '../../kit/Button.tsx';
import { ConfirmDialog, Dialog } from '../../kit/Dialog.tsx';
import { Field, Input } from '../../kit/Field.tsx';
import { useToast } from '../../kit/Toast.tsx';
import { formatDateTime } from '../../lib/format.ts';
import { CONSOLE, ConsoleFailure, Loading } from './parts.tsx';
import { SECRET_LABEL } from './rules.ts';

const SECRETS_KEY = [CONSOLE, 'app-secrets'] as const;
const SLOT_LABEL: Record<SecretSlot, string> = { current: 'current', next: 'next' };

/**
 * PLAT-4: the platform's own app secrets (LWA, Ads, eBay keyset). Write-only: the list shows the
 * name and when each slot was set, never a value; the form is never prefilled and is cleared after
 * a save. `next` holds a new value during Amazon's 7-day overlap (AMZ-10) until it is promoted.
 */
export function SecretsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: SECRETS_KEY, queryFn: platformApi.appSecrets });
  const [editing, setEditing] = useState<{ name: AppSecretName; slot: SecretSlot }>();
  const [promoting, setPromoting] = useState<AppSecretName>();
  const [error, setError] = useState<string>();

  const promote = useMutation({
    mutationFn: (name: AppSecretName) => platformApi.promoteAppSecret(name),
    onSuccess: (r, name) => {
      if (r.ok) {
        setError(undefined);
        toast({ title: 'Next value is now current', description: label(name), tone: 'success' });
      } else {
        setError(
          r.status === 409
            ? `${label(name)} has no next value to promote. Set one first.`
            : 'The value could not be promoted. Try again.',
        );
      }
    },
    onError: () => {
      setError('The value could not be promoted. Try again.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SECRETS_KEY }),
  });

  const save = async (value: string): Promise<boolean> => {
    if (!editing) return false;
    const r = await platformApi.setAppSecret(editing.name, editing.slot, value);
    await qc.invalidateQueries({ queryKey: SECRETS_KEY });
    // Expiry dates follow the set-on date (Amazon's LWA secret: 180 days, PS-033).
    await qc.invalidateQueries({ queryKey: [CONSOLE, 'credential-expiry'] });
    if (r.ok) {
      toast({
        title: `Saved the ${SLOT_LABEL[editing.slot]} value`,
        description: label(editing.name),
        tone: 'success',
      });
      setEditing(undefined);
    }
    return r.ok;
  };

  return (
    <Card
      title="App secrets"
      aside={<span className="text-xs text-ink-muted">Values are never shown once saved</span>}
    >
      {list.isError ? (
        <ConsoleFailure error={list.error} retry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Loading />
      ) : (
        <>
          {error && (
            <p role="alert" className="px-5 pt-3 text-13 text-danger">
              {error}
            </p>
          )}
          <SimpleTable
            label="App secrets"
            head={[
              { label: 'Secret' },
              { label: 'Current' },
              { label: 'Next' },
              { label: 'Actions', align: 'right' },
            ]}
          >
            {list.data.map((s) => (
              <Tr key={s.name}>
                <Td className="max-w-[280px]">
                  <Stack
                    value={<span className="font-medium">{label(s.name)}</span>}
                    sub={<span className="font-mono">{s.name}</span>}
                  />
                </Td>
                <Td>
                  <SlotDate slot={s.current} />
                </Td>
                <Td>
                  <SlotDate slot={s.next} />
                </Td>
                <Td align="right">
                  <span className="inline-flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      aria-label={`Set the current value of ${label(s.name)}`}
                      onClick={() => {
                        setEditing({ name: s.name, slot: 'current' });
                      }}
                    >
                      Set current
                    </Button>
                    <Button
                      size="sm"
                      aria-label={`Set the next value of ${label(s.name)}`}
                      onClick={() => {
                        setEditing({ name: s.name, slot: 'next' });
                      }}
                    >
                      Set next
                    </Button>
                    {s.next && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={promote.isPending}
                        aria-label={`Promote the next value of ${label(s.name)}`}
                        onClick={() => {
                          setPromoting(s.name);
                        }}
                      >
                        Promote next
                      </Button>
                    )}
                  </span>
                </Td>
              </Tr>
            ))}
          </SimpleTable>
        </>
      )}
      {editing && (
        <Dialog
          open
          size="sm"
          onOpenChange={(o) => {
            if (!o) setEditing(undefined);
          }}
          title={`Set the ${SLOT_LABEL[editing.slot]} value`}
          description={label(editing.name)}
        >
          <SecretValueForm
            slot={editing.slot}
            onSave={save}
            onCancel={() => {
              setEditing(undefined);
            }}
          />
        </Dialog>
      )}
      {promoting && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPromoting(undefined);
          }}
          title={`Promote the next value of ${label(promoting)}?`}
          description="The next value becomes current and the old current value is deleted. Do it once the provider has stopped accepting the old one."
          confirmLabel="Promote next value"
          destructive
          onConfirm={() => {
            promote.mutate(promoting);
          }}
        />
      )}
    </Card>
  );
}

const label = (name: AppSecretName) => SECRET_LABEL[name] ?? name;

function SlotDate({ slot }: { slot: AppSecretStatus['current'] }) {
  return slot ? (
    <Stack value={`Set ${formatDateTime(slot.set_at)}`} />
  ) : (
    <span className="text-ink-muted">Not set</span>
  );
}

/**
 * The write-only value field (PLAT-4). It starts empty, is masked, is never saved by the browser
 * and is cleared once the value is saved; a failed save keeps it so the operator can try again.
 */
export function SecretValueForm({
  slot,
  onSave,
  onCancel,
}: {
  slot: SecretSlot;
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  return (
    <form
      className="flex flex-col gap-4"
      autoComplete="off"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (value.length === 0) {
          setError('Paste the value to save.');
          return;
        }
        if (value.length > 4096) {
          setError('That is longer than 4,096 characters.');
          return;
        }
        setBusy(true);
        setError(undefined);
        void onSave(value)
          .then((ok) => {
            if (ok) setValue('');
            else setError('The value could not be saved. Try again.');
          })
          .catch(() => {
            setError('The value could not be saved. Try again.');
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <Field
        label="Value"
        hint={
          slot === 'next'
            ? 'Held beside the current value until you promote it.'
            : 'Replaces the current value at once.'
        }
        error={error}
      >
        <Input
          type="password"
          name="app-secret-value"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={setValue}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save value'}
        </Button>
      </div>
    </form>
  );
}
