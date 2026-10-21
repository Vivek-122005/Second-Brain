import { describe, expect, it } from 'vitest';
import { extractWikilinks, linkTargetToPath, resolveLink } from '../src/wikilinks';

describe('extractWikilinks', () => {
  it('parses targets, headings, aliases and embeds', () => {
    const links = extractWikilinks(
      'See [[projects/billing]], [[topics/rate-limits#Retries|retries]] and ![[img.png]].',
    );
    expect(links).toEqual([
      { target: 'projects/billing', embed: false },
      { target: 'topics/rate-limits', heading: 'Retries', alias: 'retries', embed: false },
      { target: 'img.png', embed: true },
    ]);
  });

  it('ignores links inside fenced and inline code', () => {
    const md = 'real [[a]]\n```\n[[not-a-link]]\n```\nand `[[nope]]` too';
    expect(extractWikilinks(md).map((l) => l.target)).toEqual(['a']);
  });

  it('skips empty targets', () => {
    expect(extractWikilinks('[[]] [[#heading]]')).toEqual([]);
  });
});

describe('resolveLink', () => {
  const paths = ['projects/billing.md', 'topics/rate-limits.md', 'topics/a/dup.md', 'notes/dup.md'];

  it('matches exact paths case-insensitively', () => {
    expect(resolveLink('Projects/Billing', paths)).toBe('projects/billing.md');
  });

  it('matches a unique bare name anywhere in the vault', () => {
    expect(resolveLink('rate-limits', paths)).toBe('topics/rate-limits.md');
  });

  it('returns null for ambiguous or missing targets', () => {
    expect(resolveLink('dup', paths)).toBeNull();
    expect(resolveLink('missing', paths)).toBeNull();
    expect(resolveLink('topics/missing', paths)).toBeNull();
  });

  it('adds .md when needed', () => {
    expect(linkTargetToPath('/topics/x')).toBe('topics/x.md');
    expect(linkTargetToPath('topics/x.md')).toBe('topics/x.md');
  });
});
