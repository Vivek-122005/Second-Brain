import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SpaceSummary } from '../api/contract';
import { createMockApi } from '../api/mock';
import { renderWithProviders } from '../test/render';
import { VaultSection } from './VaultSection';

const personal: SpaceSummary = {
  id: 'spc_personal',
  name: 'Personal',
  kind: 'personal',
  role: 'owner',
  vault: { provider: 'managed', repo: null },
};

async function fillConnectForm(
  user: ReturnType<typeof userEvent.setup>,
  { repo, token }: { repo: string; token: string },
) {
  await user.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
  const sheet = await screen.findByRole('dialog');
  await user.type(within(sheet).getByLabelText('Repository'), repo);
  await user.type(within(sheet).getByLabelText('Access token'), token);
  return sheet;
}

describe('VaultSection', () => {
  it('connects GitHub, asks before exporting over existing notes, and shows the webhook once', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    renderWithProviders(<VaultSection space={personal} />, { api, path: '/settings' });

    expect(await screen.findByText('Stored by Second Brain')).toBeInTheDocument();
    const sheet = await fillConnectForm(user, {
      repo: 'alex/existing-notes',
      token: 'github_pat_nohooks_123',
    });
    await user.click(within(sheet).getByRole('button', { name: 'Connect' }));

    // 409 repo_notes → confirm, then the same request is resent with confirm_overwrite.
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/already has 12 notes/);
    await user.click(within(confirm).getByRole('button', { name: 'Export anyway' }));

    expect(
      await screen.findByRole('heading', { name: 'Connected to alex/existing-notes' }),
    ).toBeInTheDocument();
    const done = screen.getByRole('dialog');
    expect(within(done).getByText(/add the webhook in github now/i)).toBeInTheDocument();
    expect(within(done).getByRole('button', { name: 'Copy webhook secret' })).toBeInTheDocument();
    expect(within(done).getByText(/\/webhooks\/github\/spc_personal$/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('alex/existing-notes')).toBeInTheDocument();
    expect(screen.getByText('Push webhook')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });

  it('shows GitHub and server errors in the sheet', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    renderWithProviders(<VaultSection space={personal} />, { api, path: '/settings' });

    const sheet = await fillConnectForm(user, {
      repo: 'alex/notes',
      token: 'github_pat_revoked_1',
    });
    await user.click(within(sheet).getByRole('button', { name: 'Connect' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(/github rejected the token/i);
  });

  it('explains when the server is not set up for GitHub vaults (503)', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi({ vaultKek: false });
    renderWithProviders(<VaultSection space={personal} />, { api, path: '/settings' });

    const sheet = await fillConnectForm(user, { repo: 'alex/notes', token: 'github_pat_ok_123' });
    await user.click(within(sheet).getByRole('button', { name: 'Connect' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent(/VAULT_KEK/);
  });

  it('confirms the webhook was created and disconnects back to managed storage', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    renderWithProviders(<VaultSection space={personal} />, { api, path: '/settings' });

    const sheet = await fillConnectForm(user, { repo: 'alex/notes', token: 'github_pat_ok_123' });
    await user.click(within(sheet).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/push webhook created/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy webhook secret' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await user.click(await screen.findByRole('button', { name: 'Disconnect GitHub' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }),
    );
    await waitFor(() => expect(screen.getByText('Stored by Second Brain')).toBeInTheDocument());
  });
});
