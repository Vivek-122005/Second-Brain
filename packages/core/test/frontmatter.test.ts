import { describe, expect, it } from 'vitest';
import { noteTitle, parseNote, serializeNote } from '../src/frontmatter';

describe('parseNote', () => {
  it('splits YAML frontmatter from the body', () => {
    const r = parseNote('---\ntype: project\ntitle: Billing\nnext: [a, b]\n---\n\n# Billing\nText');
    expect(r.frontmatter).toEqual({ type: 'project', title: 'Billing', next: ['a', 'b'] });
    expect(r.body).toBe('\n# Billing\nText');
    expect(r.hasFrontmatter).toBe(true);
  });

  it('returns the whole text as body when there is no frontmatter', () => {
    expect(parseNote('# Hello')).toEqual({
      frontmatter: {},
      body: '# Hello',
      hasFrontmatter: false,
    });
  });

  it('handles an empty frontmatter block and a BOM', () => {
    const r = parseNote('﻿---\n---\nbody');
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe('body');
  });

  it('keeps invalid YAML in the body and reports an error instead of throwing', () => {
    const r = parseNote('---\ntitle: [unclosed\n---\nbody');
    expect(r.error).toBeTruthy();
    expect(r.body).toContain('title: [unclosed');
  });

  it('rejects a frontmatter block that is not a map', () => {
    expect(parseNote('---\n- a\n- b\n---\nx').error).toMatch(/not a map/);
  });
});

describe('serializeNote', () => {
  it('round-trips through parseNote and drops undefined values', () => {
    const raw = serializeNote(
      { type: 'topic', title: 'Rate limiting', gone: undefined },
      '# Rate limiting\n',
    );
    expect(raw).toBe('---\ntype: topic\ntitle: Rate limiting\n---\n\n# Rate limiting\n');
    expect(parseNote(raw).frontmatter).toEqual({ type: 'topic', title: 'Rate limiting' });
  });

  it('omits the block entirely when there is no frontmatter', () => {
    expect(serializeNote({}, 'body')).toBe('body\n');
  });
});

describe('noteTitle', () => {
  it('prefers frontmatter title, then H1, then file name', () => {
    expect(noteTitle('a/b.md', { title: 'FM' }, '# H1')).toBe('FM');
    expect(noteTitle('a/b.md', {}, 'intro\n# H1 #\n')).toBe('H1');
    expect(noteTitle('a/b.md', {}, 'no heading')).toBe('b');
  });
});
