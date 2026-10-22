import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** Quiet Markdown highlighting that reads our CSS variables, so it follows light/dark. */
export const markdownHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading1, fontWeight: '700', fontSize: '1.15em' },
    { tag: [t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600' },
    { tag: t.strong, fontWeight: '600' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: [t.link, t.url], color: 'var(--sb-accent-text)' },
    { tag: t.monospace, color: 'var(--sb-orange)' },
    { tag: t.quote, color: 'var(--sb-label-secondary)' },
    {
      tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName],
      color: 'var(--sb-label-secondary)',
    },
  ]),
);
