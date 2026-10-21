import { describe, expect, it } from 'vitest';
import { sanitizeFtsQuery } from '../src/fts';

describe('sanitizeFtsQuery', () => {
  it('quotes every term and prefixes the last', () => {
    expect(sanitizeFtsQuery('rate limit')).toBe('"rate" "limit"*');
  });

  it('neutralises FTS operators and syntax', () => {
    expect(sanitizeFtsQuery('title:secret OR (a NEAR b) NOT c* ^d')).toBe(
      '"title" "secret" "OR" "a" "NEAR" "b" "NOT" "c" "d"',
    );
    expect(sanitizeFtsQuery('"); DROP TABLE notes; --')).toBe('"DROP" "TABLE" "notes"*');
  });

  it('returns null when nothing is searchable', () => {
    expect(sanitizeFtsQuery('  *** () ')).toBeNull();
  });

  it('keeps unicode words and caps the number of terms', () => {
    expect(sanitizeFtsQuery('café naïve', { prefixLast: false })).toBe('"café" "naïve"');
    expect(sanitizeFtsQuery('a b c d e', { maxTerms: 2, prefixLast: false })).toBe('"a" "b"');
  });

  it('does not prefix a single-character last term', () => {
    expect(sanitizeFtsQuery('plan b')).toBe('"plan" "b"');
  });
});
