export interface Wikilink {
  /** Raw target as written, without heading or alias: `projects/billing`. */
  target: string;
  heading?: string;
  alias?: string;
  /** Embeds are written `![[...]]`. */
  embed: boolean;
}

const WIKILINK = /(!?)\[\[([^\]\n|#]*)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]/g;

/** Removes fenced and inline code so links inside code are not treated as links. */
export function stripCode(markdown: string): string {
  return markdown
    .replace(/^(\s*)(```|~~~)[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/** Extracts `[[target#heading|alias]]` links from Markdown, ignoring code (FR-VLT-03). */
export function extractWikilinks(markdown: string): Wikilink[] {
  const out: Wikilink[] = [];
  for (const m of stripCode(markdown).matchAll(WIKILINK)) {
    const target = (m[2] ?? '').trim();
    if (!target) continue;
    const link: Wikilink = { target, embed: m[1] === '!' };
    const heading = m[3]?.trim();
    const alias = m[4]?.trim();
    if (heading) link.heading = heading;
    if (alias) link.alias = alias;
    out.push(link);
  }
  return out;
}

/** Normalises a link target to a vault path: `projects/billing` → `projects/billing.md`. */
export function linkTargetToPath(target: string): string {
  const t = target.trim().replace(/^\/+/, '');
  return /\.md$/i.test(t) ? t : `${t}.md`;
}

/**
 * Resolves a link target against the set of known paths. Exact paths win; otherwise a bare
 * name (`billing`) matches a unique file with that basename anywhere in the vault.
 */
export function resolveLink(target: string, knownPaths: Iterable<string>): string | null {
  const wanted = linkTargetToPath(target).toLowerCase();
  const byBase = new Map<string, string[]>();
  for (const p of knownPaths) {
    if (p.toLowerCase() === wanted) return p;
    const base = (p.split('/').pop() ?? p).toLowerCase();
    const list = byBase.get(base) ?? [];
    list.push(p);
    byBase.set(base, list);
  }
  if (wanted.includes('/')) return null;
  const candidates = byBase.get(wanted);
  return candidates && candidates.length === 1 ? (candidates[0] ?? null) : null;
}
