import type { ProjectStatus, TopicUpdate } from '@second-brain/schema';
import { parseNote, serializeNote } from './frontmatter';
import { parseHeading } from './headings';

export interface SessionNoteInput {
  id: string;
  projectSlug?: string;
  agent?: string;
  machine?: string;
  started: string;
  saved: string;
  summary: string;
  workDone: string[];
  nextSteps: string[];
  decisionIds: string[];
  topicPaths: string[];
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i.replace(/\r?\n/g, ' ').trim()}`).join('\n');
}

/** Renders a session log note (`sessions/YYYY/MM/<date>-<id>.md`). */
export function renderSessionNote(s: SessionNoteInput): string {
  const fm: Record<string, unknown> = {
    type: 'session',
    id: s.id,
    project: s.projectSlug ? `[[projects/${s.projectSlug}]]` : undefined,
    agent: s.agent,
    machine: s.machine,
    started: s.started,
    saved: s.saved,
    summary: s.summary.replace(/\s+/g, ' ').trim(),
    next: s.nextSteps,
  };
  const parts: string[] = [
    `# Session ${s.saved.slice(0, 10)}`,
    '',
    '## Summary',
    '',
    s.summary.trim(),
  ];
  if (s.workDone.length) parts.push('', '## Work done', '', bullets(s.workDone));
  if (s.nextSteps.length) parts.push('', '## Next steps', '', bullets(s.nextSteps));
  if (s.decisionIds.length) {
    const log = s.projectSlug ? `decisions/${s.projectSlug}` : 'decisions/global';
    parts.push('', '## Decisions', '', bullets(s.decisionIds.map((id) => `[[${log}#${id}]]`)));
  }
  if (s.topicPaths.length) {
    parts.push(
      '',
      '## Topics touched',
      '',
      bullets(s.topicPaths.map((p) => `[[${p.replace(/\.md$/, '')}]]`)),
    );
  }
  return serializeNote(fm, parts.join('\n'));
}

export interface ProjectUpdate {
  status?: ProjectStatus;
  next?: string[];
  goal?: string;
}

/** Applies status/next/goal changes to a project note, creating it when missing. */
export function applyProjectUpdate(
  raw: string | null,
  slug: string,
  update: ProjectUpdate,
  today: string,
): string {
  if (raw === null) {
    const title = slug.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    const fm: Record<string, unknown> = {
      type: 'project',
      title,
      status: update.status ?? 'active',
      goal: update.goal,
      next: update.next ?? [],
      updated: today,
    };
    return serializeNote(fm, `# ${title}\n\n${update.goal ? `${update.goal}\n` : ''}`);
  }
  const { frontmatter, body } = parseNote(raw);
  const fm: Record<string, unknown> = { ...frontmatter, type: frontmatter.type ?? 'project' };
  if (update.status) fm.status = update.status;
  if (update.next) fm.next = update.next;
  if (update.goal) fm.goal = update.goal;
  fm.updated = today;
  return serializeNote(fm, body);
}

/** Creates or edits a topic note; `section` targets one heading, otherwise the whole body. */
export function applyTopicUpdate(
  raw: string | null,
  update: TopicUpdate,
  fallbackTitle: string,
): string {
  const content = update.content.trim();
  if (raw === null) {
    const title = update.title ?? fallbackTitle;
    const body = update.section
      ? `# ${title}\n\n## ${update.section}\n\n${content}\n`
      : `# ${title}\n\n${content}\n`;
    return serializeNote({ type: 'topic', title }, body);
  }

  const { frontmatter, body, hasFrontmatter } = parseNote(raw);
  let next: string;
  if (!update.section) {
    next = update.mode === 'replace' ? `${content}\n` : `${body.trimEnd()}\n\n${content}\n`;
  } else {
    next = patchSection(body, update.section, content, update.mode);
  }
  return hasFrontmatter ? serializeNote(frontmatter, next) : next;
}

/** Appends to or replaces the content under `## section`; adds the section when missing. */
export function patchSection(
  body: string,
  section: string,
  content: string,
  mode: 'append' | 'replace',
): string {
  const lines = body.split('\n');
  const want = section.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeading(lines[i] ?? '');
    if (h && h.text.toLowerCase() === want) {
      start = i;
      level = h.level;
      break;
    }
  }
  if (start < 0) return `${body.trimEnd()}\n\n## ${section}\n\n${content}\n`;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = parseHeading(lines[i] ?? '');
    if (h && h.level <= level) {
      end = i;
      break;
    }
  }
  const existing = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  const merged = mode === 'replace' || !existing ? content : `${existing}\n\n${content}`;
  const before = lines.slice(0, start + 1).join('\n');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${merged}\n${after ? `\n${after}` : ''}`.replace(/\n{3,}/g, '\n\n');
}
