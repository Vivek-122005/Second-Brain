import type { NoteType } from '../api/contract';

/** Sidebar sections that list notes, keyed by their route path. */
export type SectionPath =
  '/projects' | '/topics' | '/decisions' | '/sessions' | '/inbox' | '/notes';

export const TYPE_LABELS: Record<NoteType, string> = {
  project: 'Project',
  'decision-log': 'Decisions',
  topic: 'Topic',
  session: 'Session',
  note: 'Note',
};

export function sectionForPath(path: string): SectionPath {
  const root = path.split('/')[0];
  switch (root) {
    case 'projects':
      return '/projects';
    case 'topics':
      return '/topics';
    case 'decisions':
      return '/decisions';
    case 'sessions':
      return '/sessions';
    case 'inbox':
      return '/inbox';
    default:
      return '/notes';
  }
}

/** In-app URL that opens a note in its section. */
export function noteHref(path: string, opts: { edit?: boolean } = {}): string {
  const params = new URLSearchParams({ path });
  if (opts.edit) params.set('mode', 'edit');
  return `${sectionForPath(path)}?${params.toString()}`;
}

/** `projects/billing-refactor.md` for a project slug. */
export function projectNotePath(slug: string): string {
  return `projects/${slug}.md`;
}

/** Lowercase, ASCII, dash-separated slug (matches `@second-brain/core` slugify). */
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

/** Strips a leading YAML frontmatter block so the editor preview renders only the body. */
export function stripFrontmatter(raw: string): string {
  const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n?---[ \t]*(?:\r?\n|$)/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

/** Marks a conflict copy in its frontmatter title so it is easy to tell apart in lists. */
export function markAsConflictCopy(raw: string): string {
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm?.[1]) return raw;
  const block = fm[1].replace(/^title:[ \t]*(.+)$/m, (_line, value: string) => {
    const title = value.trim().replace(/^(["'])(.*)\1$/, '$2');
    return `title: ${JSON.stringify(`${title} (conflicted copy)`)}`;
  });
  return raw.replace(fm[1], block);
}

export type NewNoteFolder = 'inbox' | 'topics' | 'projects';

function yamlString(s: string): string {
  return /^[\w][\w .,'()-]*$/.test(s) && !/:\s/.test(s) ? s : JSON.stringify(s);
}

/** Starter content for a new note, with frontmatter that matches the vault schema (LLD §1.2). */
export function newNoteTemplate(folder: NewNoteFolder, title: string, today: string): string {
  const t = yamlString(title);
  switch (folder) {
    case 'projects':
      return `---\ntype: project\ntitle: ${t}\nstatus: active\ngoal: ""\nnext: []\ntags: []\nupdated: ${today}\n---\n\n# ${title}\n\n## Goal\n\n## Notes\n`;
    case 'topics':
      return `---\ntype: topic\ntitle: ${t}\naliases: []\ntags: []\n---\n\n# ${title}\n\n`;
    case 'inbox':
      return `---\ntype: note\ntitle: ${t}\ntags: []\n---\n\n# ${title}\n\n`;
  }
}
