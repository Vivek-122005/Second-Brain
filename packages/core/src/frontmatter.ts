import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseHeading } from './headings';

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  /** True when the file started with a `---` block (even an empty or invalid one). */
  hasFrontmatter: boolean;
  /** Set when the YAML block could not be parsed; the block is then kept as part of the body. */
  error?: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** Splits a Markdown file into YAML frontmatter and body. Never throws. */
export function parseNote(raw: string): ParsedNote {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: {}, body: text, hasFrontmatter: false };

  const body = text.slice(match[0].length);
  try {
    const data: unknown = parseYaml(match[1] ?? '');
    if (data === null || data === undefined) return { frontmatter: {}, body, hasFrontmatter: true };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return {
        frontmatter: {},
        body: text,
        hasFrontmatter: true,
        error: 'frontmatter is not a map',
      };
    }
    return { frontmatter: data as Record<string, unknown>, body, hasFrontmatter: true };
  } catch (err) {
    return {
      frontmatter: {},
      body: text,
      hasFrontmatter: true,
      error: err instanceof Error ? err.message : 'invalid YAML',
    };
  }
}

/** Renders frontmatter + body back into a Markdown file. Undefined values are dropped. */
export function serializeNote(frontmatter: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined));
  const trimmedBody = body.replace(/^\n+/, '');
  if (Object.keys(clean).length === 0) return ensureTrailingNewline(trimmedBody);
  const yaml = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${ensureTrailingNewline(trimmedBody)}`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/** Best title for a note: frontmatter title, then first H1, then the file name. */
export function noteTitle(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim())
    return frontmatter.title.trim();
  for (const line of body.split('\n')) {
    const h = parseHeading(line);
    if (h?.level === 1) return h.text;
  }
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/i, '');
}
