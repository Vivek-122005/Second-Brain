import { describe, expect, it } from 'vitest';
import { ContextInput, Decision, ProjectFrontmatter, SaveInput, SearchInput } from '../src';

describe('frontmatter schemas', () => {
  it('fills defaults and keeps unknown keys', () => {
    const p = ProjectFrontmatter.parse({ type: 'project', title: 'Billing', custom: 1 });
    expect(p).toEqual({
      type: 'project',
      title: 'Billing',
      status: 'active',
      next: [],
      tags: [],
      custom: 1,
    });
  });

  it('normalises YAML dates to ISO strings', () => {
    const p = ProjectFrontmatter.parse({
      type: 'project',
      title: 'X',
      updated: new Date('2026-10-21T00:00:00Z'),
    });
    expect(p.updated).toBe('2026-10-21T00:00:00.000Z');
  });

  it('rejects an unknown project status', () => {
    expect(() =>
      ProjectFrontmatter.parse({ type: 'project', title: 'X', status: 'nope' }),
    ).toThrow();
  });

  it('validates decision ids', () => {
    expect(() => Decision.parse({ id: 'D-1', title: 't', date: 'd' })).toThrow();
    expect(Decision.parse({ id: 'DEC-0001', title: 't', date: 'd' }).status).toBe('active');
  });
});

describe('tool inputs', () => {
  it('applies defaults', () => {
    expect(ContextInput.parse({})).toEqual({ budget_tokens: 4000, include_shared: true });
    expect(SearchInput.parse({ query: 'x' })).toMatchObject({
      limit: 8,
      mode: 'keyword',
      include_sessions: false,
    });
  });

  it('requires project slugs to be lowercase slugs', () => {
    expect(() => ContextInput.parse({ project: 'Billing Refactor' })).toThrow(/lowercase slug/);
  });

  it('bounds save payloads', () => {
    const ok = SaveInput.parse({ session_id: 'ses_1', summary: 'Did things' });
    expect(ok).toMatchObject({ work_done: [], next_steps: [], decisions: [], topic_updates: [] });
    expect(() => SaveInput.parse({ session_id: 'ses_1', summary: '' })).toThrow();
    expect(() =>
      SaveInput.parse({
        session_id: 's',
        summary: 'x',
        decisions: [{ title: 't', rationale: 'r', supersedes: 'bad' }],
      }),
    ).toThrow();
  });
});
