import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkWikilinks } from '../lib/wikilinks';
import { RouterAnchor } from './ui/RouterAnchor';

interface MarkdownProps {
  source: string;
  /** Maps a wikilink target to an in-app href, or null when it does not resolve. */
  resolveLink: (target: string) => string | null;
  className?: string;
}

const components: Components = {
  a: ({ href, children, node: _node, ...props }) => {
    if (!href) return <span>{children}</span>;
    return (
      <RouterAnchor href={href} {...props}>
        {children}
      </RouterAnchor>
    );
  },
  // Task list checkboxes are display-only in the preview.
  input: ({ node: _node, ...props }) => <input {...props} disabled aria-readonly />,
};

/**
 * Renders note Markdown (GFM + wikilinks). Raw HTML in notes is not rendered: react-markdown
 * escapes it by default, and its URL filter drops `javascript:` and similar links. Notes are
 * untrusted memory, so this matters.
 */
export function Markdown({ source, resolveLink, className }: MarkdownProps) {
  const remarkPlugins = useMemo(
    () => [remarkGfm, [remarkWikilinks, { resolve: resolveLink }] as const],
    [resolveLink],
  );
  return (
    <div className={className ?? 'prose-note'}>
      <ReactMarkdown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unified's plugin tuple types do not narrow well
        remarkPlugins={remarkPlugins as any}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
