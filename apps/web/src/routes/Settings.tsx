import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Cloud, FolderGit2, LogOut, UserRound } from 'lucide-react';
import { useApi } from '../api/context';
import type { SpaceSummary } from '../api/contract';
import { useMe } from '../api/queries';
import { Page } from '../components/layout/Pane';
import { SecuritySection } from '../components/SecuritySection';
import { VaultSection } from '../components/VaultSection';
import { Button } from '../components/ui/Button';
import { ErrorState, Pill, Skeleton } from '../components/ui/Feedback';
import { errorMessage } from '../lib/errors';
import { GroupedSection, Row, RowText } from '../components/ui/GroupedList';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { useThemePreference, type ThemePreference } from '../lib/theme';

function vaultLabel(space: SpaceSummary): string {
  if (space.vault.provider === 'github') {
    return space.vault.repo ? `GitHub: ${space.vault.repo}` : 'GitHub';
  }
  return 'Stored by Second Brain';
}

export function SettingsPage() {
  const api = useApi();
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const [theme, setTheme] = useThemePreference();
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: async () => {
      qc.clear();
      await router.navigate({ href: '/sign-in' });
    },
  });

  return (
    <Page title="Settings">
      {me.isPending ? (
        <Skeleton lines={3} className="mb-8" />
      ) : me.isError ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : (
        <>
          <GroupedSection title="Account">
            <Row
              leading={
                <span className="flex size-10 items-center justify-center rounded-full bg-fill">
                  <UserRound
                    aria-hidden
                    className="size-5 text-label-secondary"
                    strokeWidth={1.5}
                  />
                </span>
              }
            >
              <RowText
                title={me.data.user.name ?? me.data.user.email}
                subtitle={me.data.user.email}
              />
            </Row>
          </GroupedSection>

          <GroupedSection title="Spaces" footer="Each space is its own vault with its own members.">
            {me.data.spaces.map((s) => {
              const Icon = s.vault.provider === 'github' ? FolderGit2 : Cloud;
              return (
                <Row
                  key={s.id}
                  leading={
                    <Icon
                      aria-hidden
                      className="size-[18px] text-label-secondary"
                      strokeWidth={1.75}
                    />
                  }
                  trailing={
                    <>
                      {s.id === me.data.default_space_id ? <Pill tone="blue">Default</Pill> : null}
                      <Pill tone="gray">{s.role.charAt(0).toUpperCase() + s.role.slice(1)}</Pill>
                    </>
                  }
                >
                  <RowText
                    title={s.name}
                    subtitle={`${s.kind === 'personal' ? 'Personal' : 'Team'} · ${vaultLabel(s)}`}
                  />
                </Row>
              );
            })}
          </GroupedSection>
        </>
      )}

      {/* Only the owner can see or change where a space's notes live. */}
      {me.isSuccess
        ? me.data.spaces
            .filter((s) => s.role === 'owner')
            .map((s, _i, owned) => (
              <VaultSection
                key={s.id}
                space={s}
                title={owned.length > 1 ? `Vault · ${s.name}` : 'Vault'}
              />
            ))
        : null}

      {me.isSuccess ? <SecuritySection /> : null}

      <GroupedSection
        title="Appearance"
        footer="System follows your device’s light or dark setting."
      >
        <Row trailing={null}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span id="appearance-label" className="text-[15px] text-label">
              Theme
            </span>
            <SegmentedControl<ThemePreference>
              label="Theme"
              value={theme}
              onChange={setTheme}
              segments={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </div>
        </Row>
      </GroupedSection>

      <GroupedSection>
        <li className="px-4 py-3">
          <Button
            variant="destructive-plain"
            className="w-full"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOut aria-hidden className="size-4" strokeWidth={1.75} />
            {logout.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
          {logout.isError ? (
            <p role="alert" className="mt-2 text-center text-[13px] text-red">
              {errorMessage(logout.error).detail}
            </p>
          ) : null}
        </li>
      </GroupedSection>
    </Page>
  );
}
