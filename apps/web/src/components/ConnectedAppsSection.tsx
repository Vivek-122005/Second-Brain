import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../api/context';
import type { OAuthGrant, SpaceSummary } from '../api/contract';
import { qk } from '../api/queries';
import { errorMessage } from '../lib/errors';
import { formatDay, formatRelative } from '../lib/format';
import { useUi } from '../lib/ui-context';
import { Button } from './ui/Button';
import { Pill, Skeleton } from './ui/Feedback';
import { GroupedSection, Row } from './ui/GroupedList';
import { ConfirmDialog } from './ui/Sheet';

function AppRow({
  grant,
  spaceName,
  onDisconnect,
}: {
  grant: OAuthGrant;
  spaceName: string | undefined;
  onDisconnect: () => void;
}) {
  const write = grant.scopes.includes('write');
  return (
    <Row
      leading={
        <span className="flex size-8 items-center justify-center rounded-[8px] bg-fill">
          <AppWindow aria-hidden className="size-4 text-label-secondary" strokeWidth={1.75} />
        </span>
      }
      trailing={
        <Button
          variant="destructive-plain"
          size="sm"
          aria-label={`Disconnect ${grant.client_name}`}
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      }
    >
      <span className="block min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[15px] text-label">{grant.client_name}</span>
          <Pill tone={write ? 'blue' : 'gray'}>{write ? 'Read & write' : 'Read only'}</Pill>
          {spaceName ? <Pill tone="gray">{spaceName}</Pill> : null}
        </span>
        {/* The name is self-declared by the client; where it redirects is what identifies it. */}
        <span className="mt-0.5 block truncate text-[13px] text-label-secondary">
          Redirects to{' '}
          <span className="font-medium text-label">
            {grant.redirect_hosts.length ? grant.redirect_hosts.join(', ') : 'unknown host'}
          </span>
        </span>
        <span className="mt-0.5 block text-[12px] text-label-secondary">
          {grant.last_used_at ? `Last used ${formatRelative(grant.last_used_at)}` : 'Never used'}
          {` · Connected ${formatDay(grant.created_at)}`}
        </span>
      </span>
    </Row>
  );
}

/** Settings › Connected apps: MCP clients approved through OAuth, and disconnecting them. */
export function ConnectedAppsSection({ spaces }: { spaces: SpaceSummary[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const { toast } = useUi();
  const [toRemove, setToRemove] = useState<OAuthGrant | null>(null);

  const grants = useQuery({ queryKey: qk.oauthGrants, queryFn: () => api.listOAuthGrants() });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeOAuthGrant(id),
    onSuccess: async () => {
      toast('App disconnected');
      await qc.invalidateQueries({ queryKey: qk.oauthGrants });
    },
    onSettled: () => setToRemove(null),
  });

  const items = grants.data?.items ?? [];
  const spaceName = (id: string) =>
    spaces.length > 1 ? spaces.find((s) => s.id === id)?.name : undefined;

  return (
    <>
      <GroupedSection
        title="Connected apps"
        footer="Assistants you approved when they asked to connect, such as Claude on the web. Disconnecting one signs it out right away."
      >
        {grants.isPending ? (
          <li className="px-4 py-3">
            <Skeleton lines={2} />
          </li>
        ) : grants.isError ? (
          <li className="px-4 py-3">
            <p role="alert" className="text-[13px] text-red">
              {errorMessage(grants.error).detail}
            </p>
          </li>
        ) : items.length === 0 ? (
          <li className="px-4 py-3 text-[14px] text-label-secondary">No apps connected.</li>
        ) : (
          items.map((g) => (
            <AppRow
              key={g.id}
              grant={g}
              spaceName={spaceName(g.space_id)}
              onDisconnect={() => setToRemove(g)}
            />
          ))
        )}
        {revoke.isError ? (
          <li className="px-4 py-3">
            <p role="alert" className="text-[13px] text-red">
              {errorMessage(revoke.error).detail}
            </p>
          </li>
        ) : null}
      </GroupedSection>

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(o) => {
          if (!o) setToRemove(null);
        }}
        title={`Disconnect “${toRemove?.client_name ?? ''}”?`}
        description={`It loses access to your notes immediately${
          toRemove?.redirect_hosts.length ? ` (${toRemove.redirect_hosts.join(', ')})` : ''
        }. You can connect it again later by approving it once more.`}
        confirmLabel="Disconnect"
        destructive
        busy={revoke.isPending}
        onConfirm={() => {
          if (toRemove) revoke.mutate(toRemove.id);
        }}
      />
    </>
  );
}
