import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../components/Markdown';
import { renderWithProviders } from '../test/render';
import { noteHref } from './notes';
import { resolverFromLinks } from './wikilinks';

const resolve = resolverFromLinks(
  [
    { target: 'topics/idempotency', path: 'topics/idempotency.md' },
    { target: 'rate-limiting', path: 'topics/rate-limiting.md' },
    { target: 'typography-scale', path: null },
  ],
  (p) => noteHref(p),
);

// RouterProvider renders asynchronously, so assertions below use findBy* first.
async function renderMarkdown(source: string) {
  renderWithProviders(<Markdown source={source} resolveLink={resolve} />);
}

describe('wikilinks in Markdown', () => {
  it('renders resolved links as in-app links, using the alias as text', async () => {
    await renderMarkdown(
      'Pair retries with [[topics/idempotency|idempotency keys]] and [[rate-limiting]].',
    );
    const alias = await screen.findByRole('link', { name: 'idempotency keys' });
    expect(alias).toHaveAttribute('href', '/topics?path=topics%2Fidempotency.md');
    expect(alias).toHaveClass('wikilink');
    expect(screen.getByRole('link', { name: 'rate-limiting' })).toHaveAttribute(
      'href',
      '/topics?path=topics%2Frate-limiting.md',
    );
  });

  it('marks unresolved links and points them at search', async () => {
    await renderMarkdown('Sizes live in [[typography-scale]].');
    const link = await screen.findByRole('link', { name: 'typography-scale' });
    expect(link).toHaveClass('wikilink-unresolved');
    expect(link).toHaveAttribute('href', '/search?q=typography-scale');
  });

  it('leaves wikilinks inside code alone', async () => {
    await renderMarkdown('Use `[[not-a-link]]` literally.\n\n```\n[[also-not]]\n```');
    expect(await screen.findByText('[[not-a-link]]')).toBeInTheDocument();
    expect(screen.getByText('[[also-not]]')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not render raw HTML from notes', async () => {
    await renderMarkdown('Hello <img src=x onerror="alert(1)"> [[rate-limiting]]');
    await screen.findByRole('link', { name: 'rate-limiting' });
    expect(document.querySelector('img')).toBeNull();
  });
});
