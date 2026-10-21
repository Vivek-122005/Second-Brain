import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock';
import { renderWithProviders } from '../test/render';
import { SignInPage } from './SignIn';

describe('SignInPage', () => {
  it('offers the methods the server supports and shows the dev link after emailing', async () => {
    const user = userEvent.setup();
    const { api } = createMockApi({ signedIn: false });
    renderWithProviders(<SignInPage />, { api, path: '/sign-in' });

    // jsdom has no WebAuthn, so the passkey button is hidden; Google and email remain.
    expect(
      await screen.findByRole('button', { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /passkey/i })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'alex@example.com');
    await user.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open sign-in link' })).toBeInTheDocument();
  });
});
