import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast';
import { SKIP, visit } from 'unist-util-visit';

/** Same syntax as `@second-brain/core` extractWikilinks: `[[target#heading|alias]]`. */
const WIKILINK = /(!?)\[\[([^\]\n|#]*)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]/g;

export interface WikilinkOptions {
  /**
   * Returns the in-app href for a link target, or null when the target does not resolve to a note.
   * Unresolved links still render (as a search link) but are styled as missing.
   */
  resolve: (target: string) => string | null;
  /** Href used for unresolved targets. Defaults to the search page. */
  unresolvedHref?: (target: string) => string;
}

function defaultUnresolved(target: string): string {
  return `/search?q=${encodeURIComponent(target)}`;
}

/**
 * Remark plugin that turns `[[wikilinks]]` in text into link nodes. Code spans and fenced code
 * are separate node types (`inlineCode`, `code`), so links inside code stay literal.
 */
export function remarkWikilinks(options: WikilinkOptions) {
  const unresolvedHref = options.unresolvedHref ?? defaultUnresolved;
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      // Do not nest links inside existing links.
      if (parent.type === 'link' || parent.type === 'linkReference') return;
      const value = node.value;
      WIKILINK.lastIndex = 0;
      if (!WIKILINK.test(value)) return;
      WIKILINK.lastIndex = 0;

      const out: PhrasingContent[] = [];
      let last = 0;
      for (const m of value.matchAll(WIKILINK)) {
        const start = m.index;
        const target = (m[2] ?? '').trim();
        if (!target) continue;
        if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
        const heading = m[3]?.trim();
        const alias = m[4]?.trim();
        const resolved = options.resolve(target);
        const href = resolved
          ? heading
            ? `${resolved}#${encodeURIComponent(heading)}`
            : resolved
          : unresolvedHref(target);
        const label = alias || (heading ? `${target} › ${heading}` : target);
        const link: Link = {
          type: 'link',
          url: href,
          title: resolved ? null : `No note named “${target}” yet`,
          children: [{ type: 'text', value: label }],
          data: {
            hProperties: {
              className: resolved ? ['wikilink'] : ['wikilink', 'wikilink-unresolved'],
              'data-wikilink': target,
            },
          },
        };
        out.push(link);
        last = start + m[0].length;
      }
      if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
      parent.children.splice(index, 1, ...(out as typeof parent.children));
      return [SKIP, index + out.length];
    });
  };
}

/** Builds a resolver from the `links` array the API returns with a note. */
export function resolverFromLinks(
  links: { target: string; path: string | null }[],
  toHref: (path: string) => string,
): (target: string) => string | null {
  const map = new Map<string, string | null>();
  for (const l of links) map.set(l.target.toLowerCase(), l.path);
  return (target) => {
    const path = map.get(target.toLowerCase());
    return path ? toHref(path) : null;
  };
}
