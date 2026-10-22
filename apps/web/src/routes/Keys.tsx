import { KeyRound, Laptop, Plus, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ApiKey, CreateKeyResponse, KeyScope } from '../api/contract';
import { useConnectInfo, useCreateKey, useKeys, useProjects, useRevokeKey } from '../api/queries';
import { Page } from '../components/layout/Pane';
import { Button } from '../components/ui/Button';
import { CodeBlock } from '../components/ui/CodeBlock';
import { ErrorState, Pill, Skeleton } from '../components/ui/Feedback';
import { errorMessage } from '../lib/errors';
import { SelectField, TextField } from '../components/ui/Field';
import { GroupedSection, Row } from '../components/ui/GroupedList';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { ConfirmDialog, Sheet } from '../components/ui/Sheet';
import { buildSnippets, CLIENT_OPTIONS, clientLabel, type ClientId } from '../lib/connect';
import { formatDay, formatRelative } from '../lib/format';
import { useUi } from '../lib/ui-context';

function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: (k: ApiKey) => void }) {
  const revoked = Boolean(apiKey.revoked_at);
  const details = [clientLabel(apiKey.client), apiKey.machine].filter(Boolean).join(' · ');
  return (
    <Row
      leading={
        <span className="flex size-8 items-center justify-center rounded-[8px] bg-fill">
          <Laptop aria-hidden className="size-4 text-label-secondary" strokeWidth={1.75} />
        </span>
      }
      trailing={
        revoked ? (
          <Pill tone="gray">Revoked</Pill>
        ) : (
          <Button
            variant="destructive-plain"
            size="sm"
            aria-label={`Revoke ${apiKey.label}`}
            onClick={() => onRevoke(apiKey)}
          >
            Revoke
          </Button>
        )
      }
      className={revoked ? 'opacity-60' : undefined}
    >
      <span className="block min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[15px] text-label">{apiKey.label}</span>
          <Pill tone={apiKey.scopes.includes('write') ? 'blue' : 'gray'}>
            {apiKey.scopes.includes('write') ? 'Read & write' : 'Read only'}
          </Pill>
          {apiKey.project ? <Pill tone="gray">{apiKey.project}</Pill> : null}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-label-secondary">
          <code className="font-mono text-[12px]">{apiKey.prefix}…</code>
          {details ? ` · ${details}` : ''}
        </span>
        <span className="mt-0.5 block text-[12px] text-label-secondary">
          {revoked
            ? `Revoked ${formatDay(apiKey.revoked_at ?? '')}`
            : apiKey.last_used_at
              ? `Last used ${formatRelative(apiKey.last_used_at)}`
              : 'Never used'}
          {` · Created ${formatDay(apiKey.created_at)}`}
          {apiKey.expires_at && !revoked ? ` · Expires ${formatDay(apiKey.expires_at)}` : ''}
        </span>
      </span>
    </Row>
  );
}

function SnippetTabs({ mcpUrl, secret }: { mcpUrl: string; secret?: string }) {
  const snippets = buildSnippets(mcpUrl, secret);
  const [client, setClient] = useState<ClientId>('claude-code');
  const active = snippets.find((s) => s.id === client) ?? snippets[0];
  if (!active) return null;
  return (
    <div className="space-y-3">
      <SegmentedControl<ClientId>
        label="Client"
        size="sm"
        className="flex w-full overflow-x-auto"
        value={client}
        onChange={setClient}
        segments={snippets.map((s) => ({ value: s.id, label: s.label }))}
      />
      <p className="text-[13px] text-label-secondary">{active.where}</p>
      <CodeBlock code={active.code} label={`Copy ${active.label} setup`} />
    </div>
  );
}

type Expiry = 'never' | '30' | '90' | '365';

function CreateKeySheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateKey();
  const projects = useProjects('active');
  const connect = useConnectInfo();
  const [label, setLabel] = useState('');
  const [client, setClient] = useState('claude-code');
  const [machine, setMachine] = useState('');
  const [scope, setScope] = useState<'rw' | 'r'>('rw');
  const [project, setProject] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('never');
  // The secret lives only in this component's state, and only until the sheet closes.
  const [created, setCreated] = useState<CreateKeyResponse | null>(null);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setCreated(null);
    setLabel('');
    setMachine('');
    setProject('');
    setError(undefined);
    create.reset();
    onOpenChange(false);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError('Give the key a name so you can recognise it later.');
      return;
    }
    const scopes: KeyScope[] = scope === 'rw' ? ['read', 'write'] : ['read'];
    create.mutate(
      {
        label: label.trim(),
        scopes,
        ...(client !== 'other' ? { client } : {}),
        ...(machine.trim() ? { machine: machine.trim() } : {}),
        ...(project ? { project } : {}),
        ...(expiry !== 'never' ? { expires_in_days: Number(expiry) } : {}),
      },
      {
        onSuccess: (res) => setCreated(res),
        onError: (err) => setError(errorMessage(err).detail || errorMessage(err).title),
      },
    );
  };

  if (created) {
    return (
      <Sheet
        open={open}
        onOpenChange={(o) => (o ? onOpenChange(true) : close())}
        title="Your new API key"
        description={`“${created.key.label}” is ready.`}
        size="lg"
        dismissible={false}
        footer={
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <div className="space-y-5">
          <div
            role="note"
            className="flex gap-3 rounded-card bg-orange-tint p-3.5 text-[13px] leading-snug text-label"
          >
            <ShieldAlert
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-orange"
              strokeWidth={2}
            />
            <span>
              <strong className="font-semibold">Copy this key now.</strong> It is shown only once
              and cannot be recovered. Treat it like a password: anyone with it can{' '}
              {created.key.scopes.includes('write') ? 'read and change' : 'read'} your notes.
            </span>
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-label">Secret</p>
            <CodeBlock code={created.secret} label="Copy API key" />
          </div>
          {connect.data ? (
            <div>
              <p className="mb-2 text-[13px] font-medium text-label">
                Connect a client with this key
              </p>
              <SnippetTabs mcpUrl={connect.data.mcp_url} secret={created.secret} />
            </div>
          ) : null}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title="Create API key"
      description="Use one key per machine and assistant, so you can revoke them independently."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="create-key-form"
            disabled={create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
        </>
      }
    >
      <form id="create-key-form" onSubmit={onSubmit} className="space-y-4 pt-1">
        <TextField
          label="Name"
          value={label}
          autoFocus
          maxLength={80}
          onChange={(e) => {
            setLabel(e.target.value);
            setError(undefined);
          }}
          placeholder="e.g. MacBook Pro · Claude Code"
          error={error}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            {CLIENT_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Machine"
            value={machine}
            maxLength={80}
            onChange={(e) => setMachine(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium text-label">Access</span>
          <SegmentedControl<'rw' | 'r'>
            label="Access"
            className="w-full"
            value={scope}
            onChange={setScope}
            segments={[
              { value: 'rw', label: 'Read & write' },
              { value: 'r', label: 'Read only' },
            ]}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            hint="Limit the key to one project."
          >
            <option value="">All projects</option>
            {(projects.data?.items ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Expires"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as Expiry)}
          >
            <option value="never">Never</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
          </SelectField>
        </div>
      </form>
    </Sheet>
  );
}

export function KeysPage() {
  const keys = useKeys();
  const revoke = useRevokeKey();
  const connect = useConnectInfo();
  const { toast } = useUi();
  const [creating, setCreating] = useState(false);
  const [toRevoke, setToRevoke] = useState<ApiKey | null>(null);

  const items = keys.data?.items ?? [];
  const active = items.filter((k) => !k.revoked_at);
  const revoked = items.filter((k) => k.revoked_at);

  return (
    <Page
      title="Keys & Devices"
      subtitle="API keys let assistants and the brain CLI read and write your notes."
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          Create key
        </Button>
      }
    >
      {keys.isPending ? (
        <Skeleton lines={4} />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : (
        <>
          <GroupedSection
            title="Active keys"
            footer="Signed in with brain login? That machine’s key appears here too."
          >
            {active.length === 0 ? (
              <Row
                leading={
                  <KeyRound
                    aria-hidden
                    className="size-[18px] text-label-secondary"
                    strokeWidth={1.75}
                  />
                }
              >
                <span className="text-[14px] text-label-secondary">No active keys yet.</span>
              </Row>
            ) : (
              active.map((k) => <KeyRow key={k.id} apiKey={k} onRevoke={setToRevoke} />)
            )}
          </GroupedSection>
          {revoked.length > 0 ? (
            <GroupedSection title="Revoked">
              {revoked.map((k) => (
                <KeyRow key={k.id} apiKey={k} onRevoke={setToRevoke} />
              ))}
            </GroupedSection>
          ) : null}
        </>
      )}

      <GroupedSection
        title="Connect a client"
        footer={
          <>
            Replace <code className="font-mono">&lt;YOUR_API_KEY&gt;</code> with a key. Create a new
            key to get these snippets with the key filled in.
          </>
        }
      >
        <li className="px-4 py-4">
          {connect.isPending ? (
            <Skeleton lines={3} />
          ) : connect.isError ? (
            <p role="alert" className="text-[14px] text-red">
              {errorMessage(connect.error).detail}
            </p>
          ) : (
            <>
              <p className="mb-3 text-[13px] text-label-secondary">
                MCP endpoint{' '}
                <code className="font-mono text-[12px] text-label">{connect.data.mcp_url}</code>
              </p>
              <SnippetTabs mcpUrl={connect.data.mcp_url} />
            </>
          )}
        </li>
      </GroupedSection>

      <CreateKeySheet open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(o) => {
          if (!o) setToRevoke(null);
        }}
        title={`Revoke “${toRevoke?.label ?? ''}”?`}
        description="Assistants using this key lose access immediately. This cannot be undone."
        confirmLabel="Revoke"
        destructive
        busy={revoke.isPending}
        onConfirm={() => {
          if (!toRevoke) return;
          revoke.mutate(toRevoke.id, {
            onSuccess: () => {
              toast('Key revoked');
              setToRevoke(null);
            },
            onError: (err) => {
              toast(errorMessage(err).title);
              setToRevoke(null);
            },
          });
        }}
      />
    </Page>
  );
}
