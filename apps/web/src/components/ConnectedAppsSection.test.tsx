import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock';
import { renderWithProviders } from '../test/render';
import { ConnectedAppsSection } from './ConnectedAppsSection';

describe('ConnectedAppsSection', () => {
  it('shows where each app redirects and disconnects it', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi();
    renderWithProviders(<ConnectedAppsSection spaces={[]} />, { api, path: '/settings' });

    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('claude.ai')).toBeInTheDocument();
    expect(screen.getByText('Read & write')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Disconnect Claude' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('claude.ai');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByText('No apps connected.')).toBeInTheDocument());
  });
});
