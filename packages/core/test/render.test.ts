import { describe, expect, it } from 'vitest';
import { parseNote } from '../src/frontmatter';
import {
  applyProjectUpdate,
  applyTopicUpdate,
  patchSection,
  renderSessionNote,
} from '../src/render';

describe('renderSessionNote', () => {
  it('renders frontmatter and sections', () => {
    const raw = renderSessionNote({
      id: 'ses_1',
      projectSlug: 'billing',
      agent: 'claude-code',
      started: '2026-10-21T09:00:00Z',
      saved: '2026-10-21T11:00:00Z',
      summary: 'Migrated webhooks.',
      workDone: ['Moved handlers'],
      nextSteps: ['Backfill'],
      decisionIds: ['DEC-0001'],
      topicPaths: ['topics/webhooks.md'],
    });
    const { frontmatter, body } = parseNote(raw);
    expect(frontmatter).toMatchObject({
      type: 'session',
      id: 'ses_1',
      project: '[[projects/billing]]',
      next: ['Backfill'],
    });
    expect(body).toContain('## Work done\n\n- Moved handlers');
    expect(body).toContain('[[decisions/billing#DEC-0001]]');
    expect(body).toContain('[[topics/webhooks]]');
  });
});

describe('applyProjectUpdate', () => {
  it('creates a project note when missing', () => {
    const raw = applyProjectUpdate(
      null,
      'billing-refactor',
      { goal: 'Use Stripe', next: ['a'] },
      '2026-10-21',
    );
    expect(parseNote(raw).frontmatter).toMatchObject({
      type: 'project',
      title: 'Billing refactor',
      status: 'active',
      next: ['a'],
      updated: '2026-10-21',
    });
  });

  it('updates only the given fields and keeps the body', () => {
    const before = '---\ntype: project\ntitle: X\nstatus: active\ngoal: G\n---\n\nBody text\n';
    const after = applyProjectUpdate(before, 'x', { status: 'paused' }, '2026-10-22');
    const { frontmatter, body } = parseNote(after);
    expect(frontmatter).toMatchObject({ status: 'paused', goal: 'G', updated: '2026-10-22' });
    expect(body.trim()).toBe('Body text');
  });
});

describe('topic updates', () => {
  it('creates a topic, optionally with a section', () => {
    const raw = applyTopicUpdate(
      null,
      { path: 'topics/x.md', content: 'Hello', mode: 'append', section: 'Intro' },
      'X',
    );
    expect(raw).toContain('type: topic');
    expect(raw).toContain('# X\n\n## Intro\n\nHello');
  });

  it('appends to or replaces a section', () => {
    const body = '# T\n\n## A\n\nold\n\n### A.1\n\nsub\n\n## B\n\nb\n';
    expect(patchSection(body, 'A', 'new', 'append')).toContain(
      '## A\n\nold\n\n### A.1\n\nsub\n\nnew\n\n## B',
    );
    const replaced = patchSection(body, 'a', 'new', 'replace');
    expect(replaced).toContain('## A\n\nnew\n\n## B');
    expect(replaced).not.toContain('sub');
    expect(patchSection(body, 'C', 'c', 'append').trimEnd().endsWith('## C\n\nc')).toBe(true);
  });

  it('appends or replaces the whole body when no section is given', () => {
    const raw = '---\ntype: topic\ntitle: T\n---\n\nold\n';
    expect(
      parseNote(
        applyTopicUpdate(raw, { path: 'p', content: 'new', mode: 'append' }, 'T'),
      ).body.trim(),
    ).toBe('old\n\nnew');
    expect(
      parseNote(
        applyTopicUpdate(raw, { path: 'p', content: 'new', mode: 'replace' }, 'T'),
      ).body.trim(),
    ).toBe('new');
  });
});
