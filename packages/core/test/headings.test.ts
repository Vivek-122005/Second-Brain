import { describe, expect, it } from 'vitest';
import { isHeadingAtMost, parseHeading } from '../src/headings';

describe('parseHeading', () => {
  it.each([
    ['# Title', { level: 1, text: 'Title' }],
    ['###   Spaced   ', { level: 3, text: 'Spaced' }],
    ['## Closed ##', { level: 2, text: 'Closed' }],
    ['## C# notes', { level: 2, text: 'C# notes' }],
    ['#\tTabbed', { level: 1, text: 'Tabbed' }],
  ])('parses %j', (line, expected) => {
    expect(parseHeading(line)).toEqual(expected);
  });

  it.each(['#NoSpace', '####### seven', 'plain', '#', '## ##', ''])('rejects %j', (line) => {
    expect(parseHeading(line)).toBeNull();
  });

  it('runs in linear time on adversarial input', () => {
    const evil = `#${'\t'.repeat(200_000)}x${'\t'.repeat(200_000)}`;
    const start = performance.now();
    expect(parseHeading(evil)).toEqual({ level: 1, text: 'x' });
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('compares heading levels', () => {
    expect(isHeadingAtMost('## A', 2)).toBe(true);
    expect(isHeadingAtMost('### A', 2)).toBe(false);
  });
});
