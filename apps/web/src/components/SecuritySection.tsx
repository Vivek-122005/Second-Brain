import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { Passkey } from '../api/auth-contract';
import { ApiError } from '../api/client';
import { useApi } from '../api/context';
import { qk } from '../api/queries';
import { errorMessage } from '../lib/errors';
import { formatDay, formatRelative } from '../lib/format';
import { passkeyErrorMessage, passkeysSupported, registerPasskey } from '../lib/passkeys';
import { useUi } from '../lib/ui-context';
import { Button } from './ui/Button';
import { Skeleton } from './ui/Feedback';
import { TextField } from './ui/Field';
import { GroupedSection, Row, RowText } from './ui/GroupedList';
import { ConfirmDialog } from './ui/Sheet';

function defaultPasskeyName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

function usedLabel(k: Passkey): string {
  const added = `Added ${formatDay(k.created_at)}`;
  return k.last_used_at
    ? `${added} · Used ${formatRelative(k.last_used_at)}`
    : `${added} · Never used`;
}

function PasskeyRow({ passkey, onRemove }: { passkey: Passkey; onRemove: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.name);
  const rename = useMutation({
    mutationFn: (n: string) => api.renamePasskey(passkey.id, { name: n }),
    onSuccess: async () => {
      setEditing(false);
      await qc.invalidateQueries({ queryKey: qk.passkeys });
    },
  });
  const cancel = () => {
    setName(passkey.name);
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="px-4 py-3">
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) rename.mutate(name.trim());
          }}
        >
          <div className="flex-1">
            <TextField
              label="Passkey name"
              value={name}
              maxLength={60}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancel();
              }}
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="h-10" onClick={cancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="h-10"
              disabled={rename.isPending || !name.trim()}
            >
              Save
            </Button>
          </div>
        </form>
        {rename.isError ? (
          <p role="alert" className="mt-2 text-[13px] text-red">
            {errorMessage(rename.error).detail ?? errorMessage(rename.error).title}
          </p>
        ) : null}
      </li>
    );
  }

  return (
    <Row
      leading={
        <KeyRound aria-hidden className="size-[18px] text-label-secondary" strokeWidth={1.75} />
      }
      trailing={
        <div className="flex gap-1">
          <Button
            variant="plain"
            onClick={() => setEditing(true)}
            aria-label={`Rename ${passkey.name}`}
          >
            Rename
          </Button>
          <Button
            variant="plain"
            className="text-red"
            onClick={onRemove}
            aria-label={`Remove ${passkey.name}`}
          >
            Remove
          </Button>
        </div>
      }
    >
      <RowText title={passkey.name} subtitle={usedLabel(passkey)} />
    </Row>
  );
}

/** Settings › Security: list, rename, remove and add passkeys (ADR-0007, passkeys first). */
export function SecuritySection() {
  const api = useApi();
  const qc = useQueryClient();
  const { toast } = useUi();
  const supported = passkeysSupported();
  const [name, setName] = useState(defaultPasskeyName);
  const [error, setError] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<Passkey | null>(null);

  const passkeys = useQuery({ queryKey: qk.passkeys, queryFn: () => api.listPasskeys() });
  const add = useMutation({
    mutationFn: (n: string) => registerPasskey(api, n),
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast('Passkey added');
      await qc.invalidateQueries({ queryKey: qk.passkeys });
    },
    onError: (err) => setError(passkeyErrorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deletePasskey(id),
    onMutate: () => setError(null),
    onSuccess: async () => {
      toast('Passkey removed');
      await qc.invalidateQueries({ queryKey: qk.passkeys });
    },
    onError: (err) => {
      // 409: removing it would leave the account with no way to sign in.
      if (err instanceof ApiError && err.isConflict) setError(err.detail ?? err.title);
      else setError(errorMessage(err).title);
    },
    onSettled: () => setToRemove(null),
  });

  const list = passkeys.data ?? [];

  return (
    <>
      <GroupedSection
        title="Security"
        footer="Passkeys let you sign in with Touch ID, Face ID, Windows Hello or a security key. No password to steal."
      >
        {passkeys.isPending ? (
          <li className="px-4 py-3">
            <Skeleton lines={2} />
          </li>
        ) : null}
        {list.map((k) => (
          <PasskeyRow key={k.id} passkey={k} onRemove={() => setToRemove(k)} />
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
                  label="New passkey name"
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <Button type="submit" variant="primary" disabled={add.isPending} className="h-10">
                <KeyRound aria-hidden className="size-4" strokeWidth={1.75} />
                {add.isPending ? 'Waiting…' : list.length ? 'Add another passkey' : 'Add a passkey'}
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

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(o) => {
          if (!o) setToRemove(null);
        }}
        title={`Remove “${toRemove?.name ?? ''}”?`}
        description="You won't be able to sign in with this passkey any more. Other passkeys and sign-in methods keep working."
        confirmLabel="Remove"
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (toRemove) remove.mutate(toRemove.id);
        }}
      />
    </>
  );
}
