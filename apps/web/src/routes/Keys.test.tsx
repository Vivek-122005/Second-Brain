import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render';
import { KeysPage } from './Keys';

describe('KeysPage', () => {
  it('shows a new key secret once, then only its prefix', async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeysPage />);

    await screen.findByRole('button', { name: /revoke macbook pro/i });
    await user.click(screen.getByRole('button', { name: /create key/i }));

    const form = await screen.findByRole('dialog', { name: 'Create API key' });
    await user.type(within(form).getByLabelText('Name'), 'Test laptop');
    await user.click(within(form).getByRole('button', { name: 'Create key' }));

    const sheet = await screen.findByRole('dialog', { name: 'Your new API key' });
    expect(within(sheet).getByText(/shown only once/i)).toBeInTheDocument();
    const secretEl = within(sheet).getAllByText(/^sb_live_[A-Za-z0-9]{40}$/)[0];
    const secret = secretEl?.textContent ?? '';
    expect(secret).toMatch(/^sb_live_/);
    // The connect snippets in the sheet embed the new secret.
    expect(within(sheet).getByText(new RegExp(`Bearer ${secret}`))).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The secret is gone from the page; the list shows the new key by prefix only.
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.getByText('Test laptop')).toBeInTheDocument();
    expect(screen.getByText(`${secret.slice(0, 12)}…`)).toBeInTheDocument();
  });

  it('asks for confirmation before revoking', async () => {
    const user = userEvent.setup();
    renderWithProviders(<KeysPage />);

    await user.click(await screen.findByRole('button', { name: /revoke work laptop/i }));
    const alert = await screen.findByRole('alertdialog');
    expect(within(alert).getByText(/lose access immediately/i)).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByRole('heading', { name: /revoked/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke work laptop/i })).not.toBeInTheDocument();
  });
});
