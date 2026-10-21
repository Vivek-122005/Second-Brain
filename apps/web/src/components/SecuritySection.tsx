import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../api/context';
import { passkeyErrorMessage, passkeysSupported, registerPasskey } from '../lib/passkeys';
import { Button } from './ui/Button';
import { TextField } from './ui/Field';
import { GroupedSection, Row, RowText } from './ui/GroupedList';

function defaultPasskeyName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

/** Settings › Security: add a passkey to the account (FR-AUTH, passkeys first). */
export function SecuritySection() {
  const api = useApi();
  const supported = passkeysSupported();
  const [name, setName] = useState(defaultPasskeyName);
  const [added, setAdded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (n: string) => registerPasskey(api, n),
    onMutate: () => setError(null),
    onSuccess: (_res, n) => setAdded((list) => [...list, n]),
    onError: (err) => setError(passkeyErrorMessage(err)),
  });

  return (
    <GroupedSection
      title="Security"
      footer="Passkeys let you sign in with Touch ID, Face ID, Windows Hello or a security key. No password to steal."
    >
      {added.map((n, i) => (
        <Row
          key={`${n}-${i}`}
          leading={
            <CheckCircle2 aria-hidden className="size-[18px] text-green" strokeWidth={1.75} />
          }
        >
          <RowText title={n} subtitle="Passkey added" />
        </Row>
      ))}
      <li className="px-4 py-4">
        {supported ? (
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(name.trim() || defaultPasskeyName());
            }}
          >
            <div className="flex-1">
              <TextField
                label="Passkey name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" variant="primary" disabled={add.isPending} className="h-10">
              <KeyRound aria-hidden className="size-4" strokeWidth={1.75} />
              {add.isPending ? 'Waiting…' : added.length ? 'Add another passkey' : 'Add a passkey'}
            </Button>
          </form>
        ) : (
          <p className="text-[14px] text-label-secondary">
            This browser does not support passkeys. You can still sign in with Google or an email
            link.
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-[13px] text-red">
            {error}
          </p>
        ) : null}
      </li>
    </GroupedSection>
  );
}
