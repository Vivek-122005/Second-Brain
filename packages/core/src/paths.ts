import type { NoteType } from '@second-brain/schema';

/** Top-level folders agents may write to (security.md §4.4). */
export const WRITABLE_ROOTS = [
  'projects',
  'topics',
  'sessions',
  'decisions',
  'inbox',
  'notes',
] as const;

export class InvalidPathError extends Error {
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`Invalid vault path "${path}": ${reason}`);
    this.name = 'InvalidPathError';
  }
}

/**
 * Validates and normalises a vault-relative path. Rejects traversal, absolute paths, hidden
 * segments, non-Markdown files and (when `forWrite`) folders outside the writable roots.
 */
export function normalizeVaultPath(input: string, opts: { forWrite?: boolean } = {}): string {
  const raw = input.trim().replace(/\\/g, '/');
  if (!raw) throw new InvalidPathError(input, 'empty');
  if (raw.startsWith('/')) throw new InvalidPathError(input, 'must be relative');
  if (raw.includes('\0')) throw new InvalidPathError(input, 'contains a null byte');

  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  for (const s of segments) {
    if (s === '..') throw new InvalidPathError(input, 'path traversal is not allowed');
    if (s.startsWith('.'))
      throw new InvalidPathError(input, 'hidden files and folders are not allowed');
  }
  let path = segments.join('/');
  if (!/\.md$/i.test(path)) path = `${path}.md`;

  if (opts.forWrite) {
    const root = segments[0] ?? '';
    if (segments.length < 2 || !(WRITABLE_ROOTS as readonly string[]).includes(root)) {
      throw new InvalidPathError(input, `writes are limited to ${WRITABLE_ROOTS.join('/, ')}/`);
    }
  }
  return path;
}

/** Infers a note type from its folder when frontmatter does not say. */
export function typeFromPath(path: string): NoteType {
  const root = path.split('/')[0];
  switch (root) {
    case 'projects':
      return 'project';
    case 'topics':
      return 'topic';
    case 'sessions':
      return 'session';
    case 'decisions':
      return 'decision-log';
    default:
      return 'note';
  }
}

/** Lowercase, ASCII, dash-separated slug. */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

export function projectPath(slug: string): string {
  return `projects/${slug}.md`;
}

export function decisionLogPath(projectSlug?: string): string {
  return `decisions/${projectSlug ?? 'global'}.md`;
}

/** `sessions/2026/10/2026-10-21-ses_xxx.md` */
export function sessionPath(sessionId: string, date: Date): string {
  const iso = date.toISOString();
  const y = iso.slice(0, 4);
  const m = iso.slice(5, 7);
  return `sessions/${y}/${m}/${iso.slice(0, 10)}-${sessionId}.md`;
}

/** The project slug a path belongs to, when it can be inferred from the folder layout. */
export function projectSlugFromPath(path: string): string | undefined {
  const m = /^(?:projects|decisions)\/([^/]+)\.md$/.exec(path);
  if (m?.[1] && m[1] !== 'global') return m[1];
  return undefined;
}
