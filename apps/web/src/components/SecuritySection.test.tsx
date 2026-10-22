import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock';
import { renderWithProviders } from '../test/render';
import { SecuritySection } from './SecuritySection';

describe('SecuritySection', () => {
  it('lists, renames and removes passkeys', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    renderWithProviders(<SecuritySection />, { api, path: '/settings' });

    expect(await screen.findByText('MacBook Pro')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename MacBook Pro' }));
    const field = screen.getByLabelText('Passkey name');
    await user.clear(field);
    await user.type(field, 'Work laptop');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Work laptop')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Work laptop' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Work laptop')).not.toBeInTheDocument());
  });

  it('explains why the last sign-in method cannot be removed', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi({ magicLink: false });
    renderWithProviders(<SecuritySection />, { api, path: '/settings' });

    await user.click(await screen.findByRole('button', { name: 'Remove MacBook Pro' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/add another passkey/i);
    expect(screen.getByText('MacBook Pro')).toBeInTheDocument();
  });
});
