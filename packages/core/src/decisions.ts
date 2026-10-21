import type { Decision } from '@second-brain/schema';
import { isHeadingAtMost, parseHeading } from './headings';

/**
 * Decision logs (LLD §1.2, FR-SES-04). A decision log is a Markdown file with one block per
 * decision:
 *
 *   ## DEC-0042 · Use Postgres advisory locks for job dedupe
 *   - date: 2026-10-21
 *   - status: active
 *   - supersedes: DEC-0031
 *   - rationale: Already on Postgres; Redis adds an ops dependency.
 *   - alternatives: Redis SETNX, DB unique constraint
 *
 * Multi-line values continue on lines indented by two spaces. Logs are append-only: the only
 * in-place edit is flipping a superseded decision's `status` and adding `superseded_by`.
 */

const SEPARATORS = ['·', '-', '—', ':'];

/** Parses `## DEC-0042 · Title` without backtracking-prone regexes (see headings.ts). */
function parseDecisionHeader(line: string): { id: string; title: string } | null {
  const h = parseHeading(line);
  if (!h || h.level !== 2) return null;
  const m = /^DEC-\d{4,}/.exec(h.text);
  if (!m) return null;
  const rest = h.text.slice(m[0].length).trimStart();
  const sep = SEPARATORS.find((s) => rest.startsWith(s));
  if (!sep) return null;
  const title = rest.slice(sep.length).trim();
  return title ? { id: m[0], title } : null;
}
const FIELD = /^-[ \t]+([a-z_]+):[ \t]?(.*)$/;

export function formatDecisionId(n: number): string {
  return `DEC-${String(n).padStart(4, '0')}`;
}

export function decisionNumber(id: string): number {
  const m = /^DEC-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

export function parseDecisionLog(body: string): Decision[] {
  const lines = body.split(/\r?\n/);
  const out: Decision[] = [];
  let current: Partial<Decision> & { fields: Record<string, string> } = { fields: {} };
  let lastField: string | null = null;

  const flush = () => {
    if (current.id && current.title) {
      const f = current.fields;
      const d: Decision = {
        id: current.id,
        title: current.title,
        date: f.date ?? '',
        status: f.status === 'superseded' ? 'superseded' : 'active',
        rationale: f.rationale ?? '',
      };
      if (f.alternatives) d.alternatives = f.alternatives;
      if (f.supersedes) d.supersedes = f.supersedes;
      if (f.superseded_by) d.supersededBy = f.superseded_by;
      out.push(d);
    }
    current = { fields: {} };
    lastField = null;
  };

  for (const line of lines) {
    const h = parseDecisionHeader(line);
    if (h) {
      flush();
      current.id = h.id;
      current.title = h.title;
      continue;
    }
    if (!current.id) continue;
    if (isHeadingAtMost(line, 2)) {
      flush();
      continue;
    }
    const f = FIELD.exec(line);
    if (f) {
      lastField = f[1] ?? null;
      if (lastField) current.fields[lastField] = (f[2] ?? '').trim();
      continue;
    }
    if (lastField && /^ {2,}\S/.test(line)) {
      current.fields[lastField] = `${current.fields[lastField] ?? ''}\n${line.trim()}`.trim();
    }
  }
  flush();
  return out;
}

function renderValue(value: string): string {
  return value
    .trim()
    .split(/\r?\n/)
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join('\n');
}

export function renderDecision(d: Decision): string {
  const lines = [
    `## ${d.id} · ${d.title.replace(/\s+/g, ' ').trim()}`,
    `- date: ${d.date}`,
    `- status: ${d.status}`,
  ];
  if (d.supersedes) lines.push(`- supersedes: ${d.supersedes}`);
  if (d.supersededBy) lines.push(`- superseded_by: ${d.supersededBy}`);
  lines.push(`- rationale: ${renderValue(d.rationale)}`);
  if (d.alternatives) lines.push(`- alternatives: ${renderValue(d.alternatives)}`);
  return lines.join('\n');
}

/** Appends decisions to the end of a decision-log body. */
export function appendDecisions(body: string, decisions: Decision[]): string {
  if (decisions.length === 0) return body;
  const base = body.trimEnd();
  const blocks = decisions.map(renderDecision).join('\n\n');
  return base ? `${base}\n\n${blocks}\n` : `${blocks}\n`;
}

/**
 * Marks decision `id` as superseded by `byId`, in place. Returns the new body, or null when the
 * decision is not in this log.
 */
export function markSuperseded(body: string, id: string, byId: string): string | null {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => parseDecisionHeader(l)?.id === id);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeadingAtMost(lines[i] ?? '', 2)) {
      end = i;
      break;
    }
  }
  let sawStatus = false;
  let sawBy = false;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i] ?? '';
    if (/^-[ \t]+status:/.test(line)) {
      lines[i] = '- status: superseded';
      sawStatus = true;
    } else if (/^-[ \t]+superseded_by:/.test(line)) {
      lines[i] = `- superseded_by: ${byId}`;
      sawBy = true;
    }
  }
  const insertAt = start + 1;
  if (!sawBy) lines.splice(insertAt, 0, `- superseded_by: ${byId}`);
  if (!sawStatus) lines.splice(insertAt, 0, '- status: superseded');
  return lines.join('\n');
}

/** Hides superseded decisions unless asked (FR-SES-04). */
export function activeDecisions(decisions: Decision[]): Decision[] {
  return decisions.filter((d) => d.status !== 'superseded');
}
