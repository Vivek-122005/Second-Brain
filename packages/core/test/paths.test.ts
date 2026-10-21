import { describe, expect, it } from 'vitest';
import {
  InvalidPathError,
  normalizeVaultPath,
  projectSlugFromPath,
  sessionPath,
  slugify,
  typeFromPath,
} from '../src/paths';

describe('normalizeVaultPath', () => {
  it('normalises separators, dots and the .md extension', () => {
    expect(normalizeVaultPath('topics\\./rate-limits')).toBe('topics/rate-limits.md');
    expect(normalizeVaultPath('topics//x.md')).toBe('topics/x.md');
  });

  it.each([
    '../etc/passwd',
    'topics/../../x',
    '/abs/path',
    '.brain/config',
    'topics/.hidden',
    '',
    'a\0b',
  ])('rejects %j', (p) => {
    expect(() => normalizeVaultPath(p)).toThrow(InvalidPathError);
  });

  it('limits writes to the allowed roots', () => {
    expect(normalizeVaultPath('inbox/idea', { forWrite: true })).toBe('inbox/idea.md');
    expect(() => normalizeVaultPath('README', { forWrite: true })).toThrow(/writes are limited/);
    expect(() => normalizeVaultPath('secrets/x', { forWrite: true })).toThrow(/writes are limited/);
  });
});

describe('helpers', () => {
  it('infers types from folders', () => {
    expect(typeFromPath('projects/a.md')).toBe('project');
    expect(typeFromPath('topics/a.md')).toBe('topic');
    expect(typeFromPath('sessions/2026/10/a.md')).toBe('session');
    expect(typeFromPath('decisions/a.md')).toBe('decision-log');
    expect(typeFromPath('inbox/a.md')).toBe('note');
  });

  it('slugifies text', () => {
    expect(slugify('  Héllo, World! 2026 ')).toBe('hello-world-2026');
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify('a'.repeat(100), 10)).toBe('aaaaaaaaaa');
  });

  it('builds session paths by date', () => {
    expect(sessionPath('ses_1', new Date('2026-10-21T09:00:00Z'))).toBe(
      'sessions/2026/10/2026-10-21-ses_1.md',
    );
  });

  it('finds the project slug for project and decision files', () => {
    expect(projectSlugFromPath('projects/billing.md')).toBe('billing');
    expect(projectSlugFromPath('decisions/billing.md')).toBe('billing');
    expect(projectSlugFromPath('decisions/global.md')).toBeUndefined();
    expect(projectSlugFromPath('topics/x.md')).toBeUndefined();
  });
});
