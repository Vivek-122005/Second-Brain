import { describe, expect, it } from 'vitest';
import {
  activeDecisions,
  appendDecisions,
  decisionNumber,
  formatDecisionId,
  markSuperseded,
  parseDecisionLog,
  renderDecision,
} from '../src/decisions';

const LOG = `---
type: decision-log
---

# Decisions: billing

## DEC-0031 · Use Redis for job dedupe
- date: 2026-09-01
- status: active
- rationale: Fast and simple.

## DEC-0042 · Use Postgres advisory locks for job dedupe
- date: 2026-10-21
- status: active
- supersedes: DEC-0031
- rationale: Already on Postgres;
  Redis adds an ops dependency.
- alternatives: Redis SETNX, DB unique constraint
`;

describe('parseDecisionLog', () => {
  it('parses every decision block including multi-line values', () => {
    const ds = parseDecisionLog(LOG);
    expect(ds).toHaveLength(2);
    expect(ds[1]).toEqual({
      id: 'DEC-0042',
      title: 'Use Postgres advisory locks for job dedupe',
      date: '2026-10-21',
      status: 'active',
      supersedes: 'DEC-0031',
      rationale: 'Already on Postgres;\nRedis adds an ops dependency.',
      alternatives: 'Redis SETNX, DB unique constraint',
    });
  });

  it('ignores text that is not a decision block', () => {
    expect(parseDecisionLog('# Title\n\nSome notes\n- date: nope')).toEqual([]);
  });
});

describe('ids', () => {
  it('formats and parses decision numbers', () => {
    expect(formatDecisionId(7)).toBe('DEC-0007');
    expect(formatDecisionId(12345)).toBe('DEC-12345');
    expect(decisionNumber('DEC-0042')).toBe(42);
    expect(decisionNumber('nope')).toBe(0);
  });
});

describe('render / append / supersede', () => {
  it('renders a decision that parses back to the same value', () => {
    const d = {
      id: 'DEC-0050',
      title: 'Move to Workers',
      date: '2026-10-22',
      status: 'active' as const,
      rationale: 'Cheaper.\nFaster cold starts.',
      alternatives: 'Fly.io',
    };
    expect(parseDecisionLog(renderDecision(d))).toEqual([d]);
  });

  it('appends decisions to an existing log', () => {
    const next = appendDecisions(LOG, [
      { id: 'DEC-0043', title: 'X', date: '2026-10-22', status: 'active', rationale: 'Y' },
    ]);
    expect(parseDecisionLog(next).map((d) => d.id)).toEqual(['DEC-0031', 'DEC-0042', 'DEC-0043']);
    expect(appendDecisions('', [])).toBe('');
  });

  it('marks a decision as superseded in place and hides it from active decisions', () => {
    const next = markSuperseded(LOG, 'DEC-0031', 'DEC-0042');
    expect(next).not.toBeNull();
    const ds = parseDecisionLog(next ?? '');
    expect(ds[0]).toMatchObject({ id: 'DEC-0031', status: 'superseded', supersededBy: 'DEC-0042' });
    expect(activeDecisions(ds).map((d) => d.id)).toEqual(['DEC-0042']);
    // Idempotent
    expect(markSuperseded(next ?? '', 'DEC-0031', 'DEC-0042')).toBe(next);
  });

  it('adds status lines when a block lacks them, and returns null for unknown ids', () => {
    const bare = '## DEC-0001 · A\n- rationale: r\n';
    expect(parseDecisionLog(markSuperseded(bare, 'DEC-0001', 'DEC-0002') ?? '')[0]).toMatchObject({
      status: 'superseded',
      supersededBy: 'DEC-0002',
    });
    expect(markSuperseded(bare, 'DEC-9999', 'DEC-0002')).toBeNull();
  });
});
