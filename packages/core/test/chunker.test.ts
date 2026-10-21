import { describe, expect, it } from 'vitest';
import { chunkNote } from '../src/chunker';

describe('chunkNote', () => {
  it('emits one chunk per heading section with the heading trail', () => {
    const body =
      'Intro text.\n\n# Billing\nTop.\n\n## Webhooks\nHooks.\n\n### Retries\nBackoff.\n\n## Invoices\nInv.';
    const chunks = chunkNote('Billing', body);
    expect(chunks.map((c) => [c.headingPath.join(' > '), c.body])).toEqual([
      ['', 'Intro text.'],
      ['Billing', 'Top.'],
      ['Billing > Webhooks', 'Hooks.'],
      ['Billing > Webhooks > Retries', 'Backoff.'],
      ['Billing > Invoices', 'Inv.'],
    ]);
    expect(chunks.map((c) => c.ord)).toEqual([0, 1, 2, 3, 4]);
  });

  it('prefixes embedding text with title and heading path', () => {
    const [c] = chunkNote('Rate limiting', '## Buckets\nToken buckets.');
    expect(c?.text).toBe('Rate limiting\nBuckets\nToken buckets.');
    expect(c?.tokenCount).toBeGreaterThan(0);
  });

  it('does not treat # lines inside code fences as headings', () => {
    const body = '## Script\n```bash\n# not a heading\necho hi\n```';
    const chunks = chunkNote('T', body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.body).toContain('# not a heading');
  });

  it('splits long sections at paragraph breaks', () => {
    const para = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
    const body = `## Long\n${[para, para, para, para].join('\n\n')}`;
    const chunks = chunkNote('T', body, { maxWords: 400, maxChars: 10_000 });
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.headingPath[0] === 'Long')).toBe(true);
  });

  it('keeps chunks under the character cap', () => {
    const para = 'x'.repeat(600);
    const chunks = chunkNote('T', [para, para, para].join('\n\n'), { maxChars: 1500 });
    expect(chunks.map((c) => c.body.length)).toEqual([1202, 600]);
  });

  it('hard-splits a giant block such as a pasted log', () => {
    const sentence = 'The service restarted after the deploy. ';
    const block = sentence.repeat(100); // ~4000 chars, one paragraph
    const chunks = chunkNote('Log', block, { maxChars: 1500, maxWords: 10_000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.body.length <= 1500)).toBe(true);
    expect(
      chunks
        .map((c) => c.body)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(block.trim());
  });

  it('skips empty sections and empty notes', () => {
    expect(chunkNote('T', '')).toEqual([]);
    expect(chunkNote('T', '# A\n\n# B\ntext').map((c) => c.headingPath)).toEqual([['B']]);
  });
});
