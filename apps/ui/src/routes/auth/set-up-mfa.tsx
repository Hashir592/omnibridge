import { useQuery } from '@tanstack/react-query';
import { Copy, Download } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '../../kit/Button.tsx';
import { Skeleton } from '../../kit/Skeleton.tsx';
import { authApi } from '../../mocks/api.ts';
import type { MfaConfirmResult, MfaEnrolment } from '../../auth/shapes.ts';
import { AuthFrame, Notice } from './layout.tsx';
import { CodeField, useEnterApp } from './parts.tsx';

/** Draws the QR module matrix as one SVG path, with the 4-module quiet zone the spec asks for. */
function QrCode({ rows }: { rows: string[] }) {
  const size = rows.length + 8;
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++)
      if (row[x] === '1') d += `M${String(x + 4)} ${String(y + 4)}h1v1h-1z`;
  });
  return (
    <svg
      role="img"
      aria-label="QR code to scan with your authenticator app"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className="size-44 shrink-0 rounded-ctl border border-border bg-white"
      shapeRendering="crispEdges"
    >
      <path d={d} fill="#000" />
    </svg>
  );
}

/**
 * MFA enrolment (USR-4): scan the QR or type the key, confirm with a code, then save the 10
 * single-use recovery codes. Shown on first sign in and after accepting an invite; there is no
 * way past it, because sign in is impossible without MFA.
 */
export function SetUpMfaPage() {
  const [codes, setCodes] = useState<string[]>();
  return codes ? <RecoveryCodes codes={codes} /> : <Enrol onDone={setCodes} />;
}

function Enrol({ onDone }: { onDone: (codes: string[]) => void }) {
  const { data, isError, refetch } = useQuery({
    queryKey: ['mfa-enrolment'],
    queryFn: async () => {
      const r = await authApi.startEnrolment();
      if (!r.ok) throw new Error(String(r.status));
      return r.body as MfaEnrolment;
    },
    // Starting enrolment issues a new secret, so it must not run again on a remount or a return
    // visit while the user is scanning: keep the first answer for the life of the page.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<'invalid' | 'error'>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const r = await authApi.confirmEnrolment(code);
      if (r.ok) {
        onDone((r.body as MfaConfirmResult).recoveryCodes);
        return;
      }
      setCode('');
      setFailure(r.status === 401 ? 'invalid' : 'error');
    } catch {
      setFailure('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      width="wide"
      title="Set up two-step sign in"
      intro="Every OmniBridge account needs an authenticator app, such as Google Authenticator, Microsoft Authenticator or 1Password."
    >
      <ol className="flex flex-col gap-6">
        <li>
          <h2 className="text-sm font-semibold">1. Scan this QR code with the app</h2>
          <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start">
            {data ? <QrCode rows={data.qr} /> : <Skeleton className="size-44 rounded-ctl" />}
            <div className="min-w-0 text-13">
              <p className="text-ink-muted">Cannot scan it? Enter this key in the app instead.</p>
              {data ? (
                <>
                  <p className="num mt-2 font-medium break-words tracking-wide">{data.secret}</p>
                  <p className="mt-1 text-xs text-ink-muted">Account: {data.label}</p>
                </>
              ) : (
                <Skeleton className="mt-2 h-5 w-48" />
              )}
              {isError && (
                <Notice tone="danger" title="Could not load your QR code" className="mt-3">
                  <button
                    className="font-medium text-brand-600 hover:underline"
                    onClick={() => void refetch()}
                  >
                    Try again
                  </button>
                </Notice>
              )}
            </div>
          </div>
        </li>
        <li>
          <h2 className="text-sm font-semibold">2. Enter the 6-digit code the app shows</h2>
          <form noValidate onSubmit={(e) => void submit(e)} className="mt-3 flex flex-col gap-4">
            <div className="max-w-60">
              <CodeField value={code} onChange={setCode} autoFocus={false} />
            </div>
            {failure === 'invalid' && (
              <Notice
                tone="danger"
                title="That code did not work. Check the app and use the current code."
              />
            )}
            {failure === 'error' && (
              <Notice tone="danger" title="Something went wrong on our side. Try again." />
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={busy || code.length !== 6 || !data}
              className="w-full sm:w-auto sm:self-start"
            >
              {busy ? 'Checking…' : 'Turn on two-step sign in'}
            </Button>
          </form>
        </li>
      </ol>
    </AuthFrame>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const enter = useEnterApp();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed'>();
  const text = `OmniBridge recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'omnibridge-recovery-codes.txt';
    a.click();
    // Revoked later: some browsers start the download after click() returns.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 10_000);
  };

  return (
    <AuthFrame
      width="wide"
      title="Save your recovery codes"
      intro="If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe, such as a password manager. You will not see them again."
    >
      <ul
        aria-label="Recovery codes"
        className="num grid grid-cols-2 gap-x-6 gap-y-2 rounded-ctl border border-border bg-rail px-5 py-4 text-sm font-medium tracking-wide"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          icon={<Copy />}
          onClick={() => {
            // navigator.clipboard is missing outside secure contexts, and can be refused.
            const write =
              typeof navigator.clipboard === 'undefined'
                ? Promise.reject(new Error('no clipboard'))
                : navigator.clipboard.writeText(text);
            write.then(
              () => {
                setCopied('yes');
              },
              () => {
                setCopied('failed');
              },
            );
          }}
        >
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" icon={<Download />} onClick={download}>
          Download
        </Button>
      </div>
      {copied === 'failed' && (
        <Notice
          tone="warning"
          title="Could not copy. Use Download, or write the codes down."
          className="mt-3"
        />
      )}
      <label className="mt-6 flex items-start gap-2.5 text-13">
        <input
          type="checkbox"
          className="mt-0.5 size-4"
          checked={saved}
          onChange={(e) => {
            setSaved(e.target.checked);
          }}
        />
        I have saved these codes somewhere safe
      </label>
      <Button
        variant="primary"
        size="lg"
        disabled={!saved}
        className="mt-4 w-full"
        onClick={() => void enter('/')}
      >
        Continue to OmniBridge
      </Button>
    </AuthFrame>
  );
}
