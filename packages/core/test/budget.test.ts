import type { ContextOutput } from '@second-brain/schema';
import { describe, expect, it } from 'vitest';
import { budgetContext } from '../src/budget';
import { estimateTokens } from '../src/tokens';

function fixture(): ContextOutput {
  const long = 'lorem ipsum dolor sit amet '.repeat(60);
  return {
    project: {
      slug: 'billing',
      title: 'Billing',
      status: 'active',
      goal: 'Ship it',
      next: ['a'],
      body: long.repeat(4),
    },
    decisions: Array.from({ length: 5 }, (_, i) => ({
      id: `DEC-000${i}`,
      title: `Decision ${i}`,
      date: '2026-10-21',
      rationale: long,
    })),
    sessions: Array.from({ length: 3 }, (_, i) => ({
      id: `ses_${i}`,
      date: '2026-10-21',
      summary: long,
      next: [],
      path: `sessions/${i}.md`,
    })),
    active_projects: [{ slug: 'other', title: 'Other' }],
    session_id: 'ses_new',
  };
}

describe('budgetContext', () => {
  it('returns the input unchanged when it fits', () => {
    const input = fixture();
    const r = budgetContext(input, 100_000);
    expect(r.truncated).toBe(false);
    expect(r.data).toEqual(input);
    expect(r.data.note).toBeUndefined();
  });

  it('drops oldest sessions first, then oldest decisions, then the project tail', () => {
    const input = fixture();
    const full = estimateTokens(JSON.stringify(input));
    const r1 = budgetContext(input, full - 100);
    expect(r1.truncated).toBe(true);
    expect(r1.data.sessions.map((s) => s.id)).toEqual(['ses_0', 'ses_1']);
    expect(r1.data.decisions).toHaveLength(5);

    const r2 = budgetContext(input, 1200);
    expect(r2.tokens).toBeLessThanOrEqual(1200);
    expect(r2.data.sessions.length).toBeLessThanOrEqual(1);
    expect(r2.data.project?.title).toBe('Billing');
    expect(r2.data.note).toMatch(/Trimmed/);
  });

  it('never drops the project header or the session id', () => {
    const r = budgetContext(fixture(), 50);
    expect(r.data.project).toMatchObject({ slug: 'billing', title: 'Billing', status: 'active' });
    expect(r.data.project?.body).toBeUndefined();
    expect(r.data.session_id).toBe('ses_new');
    expect(r.data.sessions).toEqual([]);
    expect(r.data.decisions).toEqual([]);
  });

  it('keeps a caller-provided note, adding the trim notice when it trims', () => {
    const input = { ...fixture(), note: 'No project note yet.' };
    expect(budgetContext(input, 100_000).data.note).toBe('No project note yet.');
    expect(budgetContext(input, 1200).data.note).toMatch(/^No project note yet\. Trimmed/);
  });

  it('does not mutate the input', () => {
    const input = fixture();
    const copy = structuredClone(input);
    budgetContext(input, 100);
    expect(input).toEqual(copy);
  });
});
