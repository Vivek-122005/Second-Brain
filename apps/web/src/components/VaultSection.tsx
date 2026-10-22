import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Cloud, FolderGit2, ShieldAlert, Webhook } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useApi } from '../api/context';
import type {
  ConnectGitHubVaultInput,
  ConnectGitHubVaultResponse,
  SpaceSummary,
  VaultStatus,
  VaultSyncDirection,
} from '../api/contract';
import { qk } from '../api/queries';
import { errorMessage } from '../lib/errors';
import { formatRelative } from '../lib/format';
import { useUi } from '../lib/ui-context';
import { Button } from './ui/Button';
import { CodeBlock } from './ui/CodeBlock';
import { Pill, Skeleton } from './ui/Feedback';
import { TextField } from './ui/Field';
import { GroupedSection, Row, RowText } from './ui/GroupedList';
import { SegmentedControl } from './ui/SegmentedControl';
import { ConfirmDialog, Sheet } from './ui/Sheet';

/** How to create the fine-grained token (docs/runbooks/github-vault.md). */
export const GITHUB_VAULT_RUNBOOK =
  'https://github.com/Vivek-122005/Second-Brain/blob/main/docs/runbooks/github-vault.md';

const DIRECTIONS: Record<VaultSyncDirection, string> = {
  push_managed:
    "Exports this space's notes to the repository as one commit, then keeps them there. Best for an empty repository.",
  adopt_repo:
    "Imports the repository's Markdown notes and uses them from now on. Best when your notes are already on GitHub.",
};

/** What a 409 on connect asks the owner to confirm. */
interface Overwrite {
  count: number;
  side: 'repo' | 'space';
}

function overwriteFrom(err: unknown): Overwrite | null {
  if (!(err instanceof ApiError) || !err.isConflict) return null;
  const { repo_notes: repo, managed_notes: managed } = err.extensions;
  if (typeof repo === 'number') return { count: repo, side: 'repo' };
  if (typeof managed === 'number') return { count: managed, side: 'space' };
  return null;
}

function ErrorNote({ error }: { error: unknown }) {
  const { title, detail } = errorMessage(error);
  return (
    <p role="alert" className="rounded-card bg-red-tint p-3 text-[13px] leading-snug text-label">
      <strong className="font-semibold text-red">{title}.</strong> {detail}
    </p>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Shown once after connecting: the webhook secret cannot be read again. */
function ConnectedView({ result }: { result: ConnectGitHubVaultResponse }) {
  const { webhook } = result;
  const summary =
    result.direction === 'push_managed'
      ? `Exported ${plural(result.exported, 'note')} and indexed ${plural(result.indexed, 'note')}.`
      : `Imported and indexed ${plural(result.indexed, 'note')} from the repository.`;
  return (
    <div className="space-y-5">
      <p className="text-[14px] text-label">{summary}</p>
      {webhook.created ? (
        <div
          role="note"
          className="flex gap-3 rounded-card bg-green-tint p-3.5 text-[13px] leading-snug text-label"
        >
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-green" strokeWidth={2} />
          <span>
            <strong className="font-semibold">Push webhook created.</strong> Changes you push to
            GitHub reach your assistants within seconds.
          </span>
        </div>
      ) : (
        <>
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
              <strong className="font-semibold">Add the webhook in GitHub now.</strong> The secret
              is shown only once. In the repository, open Settings → Webhooks → Add webhook and
              enter these values.{webhook.detail ? ` ${webhook.detail}` : ''}
            </span>
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-label">Payload URL</p>
            <CodeBlock code={webhook.payload_url} label="Copy payload URL" />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-label">Secret</p>
            <CodeBlock code={webhook.secret} label="Copy webhook secret" />
          </div>
          <p className="text-[13px] text-label-secondary">
            Content type: <code className="font-mono text-[12px]">{webhook.content_type}</code> ·
            Events: just the push event.
          </p>
        </>
      )}
    </div>
  );
}

function ConnectGitHubSheet({
  spaceId,
  open,
  onOpenChange,
}: {
  spaceId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  // The token lives only in this component's state, and only until the sheet closes.
  const [token, setToken] = useState('');
  const [direction, setDirection] = useState<VaultSyncDirection>('push_managed');
  const [createWebhook, setCreateWebhook] = useState(true);
  const [overwrite, setOverwrite] = useState<Overwrite | null>(null);
  const [result, setResult] = useState<ConnectGitHubVaultResponse | null>(null);

  const connect = useMutation({
    mutationFn: (req: ConnectGitHubVaultInput) => api.connectGitHubVault(spaceId, req),
    onSuccess: async (res) => {
      setToken('');
      setOverwrite(null);
      setResult(res);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.vault(spaceId) }),
        qc.invalidateQueries({ queryKey: qk.me }),
      ]);
    },
    onError: (err) => setOverwrite(overwriteFrom(err)),
  });

  const close = () => {
    setRepo('');
    setBranch('');
    setToken('');
    setDirection('push_managed');
    setCreateWebhook(true);
    setOverwrite(null);
    setResult(null);
    connect.reset();
    onOpenChange(false);
  };

  const send = (confirmOverwrite: boolean) =>
    connect.mutate({
      repo: repo.trim(),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      token: token.trim(),
      direction,
      confirm_overwrite: confirmOverwrite,
      create_webhook: createWebhook,
    });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(false);
  };

  if (result) {
    return (
      <Sheet
        open={open}
        onOpenChange={(o) => (o ? onOpenChange(true) : close())}
        title={`Connected to ${result.vault.repo ?? 'GitHub'}`}
        description={result.vault.branch ? `Branch ${result.vault.branch}` : undefined}
        size="lg"
        dismissible={result.webhook.created}
        footer={
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <ConnectedView result={result} />
      </Sheet>
    );
  }

  const fieldError = (path: string) =>
    connect.error instanceof ApiError
      ? connect.error.errors.find((x) => x.path === path)?.message
      : undefined;
  // Field-level problems show next to their field; a pending overwrite has its own dialog.
  const showBanner =
    connect.isError &&
    !overwrite &&
    !(connect.error instanceof ApiError && connect.error.errors.length);

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(o) => (o ? onOpenChange(true) : close())}
        title="Connect GitHub"
        description="Keep this space's notes in a repository you own. Edit them in Obsidian or VS Code, push, and your assistants see the change."
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="connect-github-form"
              disabled={connect.isPending || !repo.trim() || !token.trim()}
            >
              {connect.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </>
        }
      >
        <form id="connect-github-form" onSubmit={onSubmit} className="space-y-4 pt-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Repository"
              value={repo}
              autoFocus
              maxLength={200}
              placeholder="you/notes"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setRepo(e.target.value)}
              error={fieldError('repo')}
            />
            <TextField
              label="Branch"
              value={branch}
              maxLength={200}
              placeholder="Default branch"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setBranch(e.target.value)}
              error={fieldError('branch')}
            />
          </div>
          <TextField
            label="Access token"
            type="password"
            value={token}
            maxLength={500}
            placeholder="github_pat_…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
            error={fieldError('token')}
            hint={
              <>
                A fine-grained token for this one repository with Contents: Read and write.{' '}
                <a
                  href={GITHUB_VAULT_RUNBOOK}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-text hover:underline"
                >
                  How to create one
                </a>
              </>
            }
          />
          <div className="space-y-1.5">
            <span className="block text-[13px] font-medium text-label">Start from</span>
            <SegmentedControl<VaultSyncDirection>
              label="Start from"
              className="w-full"
              value={direction}
              onChange={setDirection}
              segments={[
                { value: 'push_managed', label: 'This space' },
                { value: 'adopt_repo', label: 'The repository' },
              ]}
            />
            <p className="text-[12px] leading-snug text-label-secondary">{DIRECTIONS[direction]}</p>
          </div>
          <label className="flex items-start gap-2.5 text-[14px] text-label">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
              checked={createWebhook}
              onChange={(e) => setCreateWebhook(e.target.checked)}
            />
            <span>
              Create the push webhook for me
              <span className="block text-[12px] leading-snug text-label-secondary">
                Needs Webhooks: Read and write on the token. Otherwise you add it in GitHub
                yourself.
              </span>
            </span>
          </label>
          {showBanner ? <ErrorNote error={connect.error} /> : null}
        </form>
      </Sheet>

      <ConfirmDialog
        open={overwrite !== null}
        onOpenChange={(o) => {
          if (!o) setOverwrite(null);
        }}
        title={
          overwrite?.side === 'repo'
            ? 'The repository already has notes'
            : 'Replace this space’s notes?'
        }
        description={
          overwrite?.side === 'repo'
            ? `${repo.trim()} already has ${plural(overwrite.count, 'note')}. Exporting writes this space's notes on top of them, replacing any with the same path.`
            : `This space has ${plural(overwrite?.count ?? 0, 'note')}. The repository's notes will replace them, and notes that only exist here will be removed from search.`
        }
        confirmLabel={overwrite?.side === 'repo' ? 'Export anyway' : 'Replace'}
        destructive
        busy={connect.isPending}
        onConfirm={() => send(true)}
      />
    </>
  );
}

function WebhookRow({ status }: { status: VaultStatus }) {
  const hook = status.webhook;
  if (!hook) return null;
  const subtitle = hook.configured
    ? hook.last_delivery_at
      ? `Last push received ${formatRelative(hook.last_delivery_at)}`
      : 'Waiting for the first push'
    : 'Not set up yet. Add it in GitHub so pushes sync right away.';
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <Webhook
          aria-hidden
          className="size-[18px] shrink-0 text-label-secondary"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <RowText title="Push webhook" subtitle={subtitle} />
        </div>
        <Pill tone={hook.configured ? 'green' : 'orange'}>
          {hook.configured ? 'Active' : 'Missing'}
        </Pill>
      </div>
      {hook.configured ? null : (
        <CodeBlock className="mt-3" code={hook.payload_url} label="Copy payload URL" />
      )}
    </li>
  );
}

/** Settings › Vault for one space the person owns: connect, inspect and disconnect GitHub. */
export function VaultSection({ space, title = 'Vault' }: { space: SpaceSummary; title?: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { toast } = useUi();
  const [connecting, setConnecting] = useState(false);
  const [confirm, setConfirm] = useState<'import' | 'skip' | null>(null);

  const status = useQuery({
    queryKey: qk.vault(space.id),
    queryFn: () => api.vaultStatus(space.id),
  });
  const disconnect = useMutation({
    mutationFn: (skipImport: boolean) => api.disconnectGitHubVault(space.id, { skipImport }),
    onSuccess: async (res) => {
      toast(
        res.imported
          ? `Disconnected. Copied ${plural(res.imported, 'note')} back into Second Brain.`
          : 'Disconnected from GitHub',
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.vault(space.id) }),
        qc.invalidateQueries({ queryKey: qk.me }),
      ]);
    },
    onSettled: () => setConfirm(null),
  });

  const footer = (
    <>
      Notes stay plain Markdown either way.{' '}
      <a
        href={GITHUB_VAULT_RUNBOOK}
        target="_blank"
        rel="noreferrer"
        className="text-accent-text hover:underline"
      >
        How GitHub sync works
      </a>
    </>
  );

  const s = status.data;
  // The import failed (token revoked, repo gone): offer switching back without it.
  const importFailed = disconnect.isError && disconnect.variables === false;

  return (
    <>
      <GroupedSection title={title} footer={footer}>
        {status.isPending ? (
          <li className="px-4 py-3">
            <Skeleton lines={2} />
          </li>
        ) : status.isError ? (
          <li className="px-4 py-3">
            <ErrorNote error={status.error} />
          </li>
        ) : s?.provider === 'github' ? (
          <>
            <Row
              leading={
                <FolderGit2
                  aria-hidden
                  className="size-[18px] text-label-secondary"
                  strokeWidth={1.75}
                />
              }
              trailing={<Pill tone="blue">GitHub</Pill>}
            >
              <RowText
                title={s.repo ?? 'GitHub'}
                subtitle={[
                  s.branch,
                  s.last_synced_at
                    ? `Synced ${formatRelative(s.last_synced_at)}`
                    : 'Not synced yet',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            </Row>
            {s.last_sync_error ? (
              <li className="px-4 py-3">
                <p role="alert" className="text-[13px] leading-snug text-red">
                  Last sync failed: {s.last_sync_error}
                </p>
              </li>
            ) : null}
            <WebhookRow status={s} />
            <li className="px-4 py-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="destructive-plain" onClick={() => setConfirm('import')}>
                  Disconnect GitHub
                </Button>
                {importFailed ? (
                  <Button variant="plain" onClick={() => setConfirm('skip')}>
                    Disconnect without copying notes
                  </Button>
                ) : null}
              </div>
              {disconnect.isError ? (
                <div className="mt-2">
                  <ErrorNote error={disconnect.error} />
                </div>
              ) : null}
            </li>
          </>
        ) : (
          <Row
            leading={
              <Cloud aria-hidden className="size-[18px] text-label-secondary" strokeWidth={1.75} />
            }
            trailing={
              <Button variant="primary" size="sm" onClick={() => setConnecting(true)}>
                Connect GitHub
              </Button>
            }
          >
            <RowText
              title="Stored by Second Brain"
              subtitle="Or keep this space's notes in a GitHub repository you own."
            />
          </Row>
        )}
      </GroupedSection>

      <ConnectGitHubSheet spaceId={space.id} open={connecting} onOpenChange={setConnecting} />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title={`Disconnect ${s?.repo ?? 'GitHub'}?`}
        description={
          confirm === 'skip'
            ? 'The space goes back to the notes Second Brain had before you connected. Anything only in the repository stays there but is no longer searchable.'
            : "Second Brain copies the repository's latest notes back into its own storage and stops syncing. The repository itself is not changed."
        }
        confirmLabel="Disconnect"
        destructive
        busy={disconnect.isPending}
        onConfirm={() => disconnect.mutate(confirm === 'skip')}
      />
    </>
  );
}
