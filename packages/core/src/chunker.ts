import { parseHeading } from './headings';
import { countWords, estimateTokens } from './tokens';

export interface Chunk {
  ord: number;
  /** Heading trail, e.g. `["Billing", "Webhooks", "Retries"]`. Empty for text before the first heading. */
  headingPath: string[];
  body: string;
  /** Self-contained text for embeddings: title + heading path + body (LLD §4.1). */
  text: string;
  tokenCount: number;
}

export interface ChunkOptions {
  /** Sections above this many words are split at paragraph breaks. */
  maxWords?: number;
  /** Chunks stay under this many characters; a bigger single block is hard-split at a sentence boundary. */
  maxChars?: number;
}

const FENCE = /^\s*(```|~~~)/;

interface Section {
  headingPath: string[];
  lines: string[];
}

/** Splits a note into heading-aware chunks (FR-SRC-01). Pure and deterministic. */
export function chunkNote(title: string, body: string, opts: ChunkOptions = {}): Chunk[] {
  const maxWords = opts.maxWords ?? 400;
  const maxChars = opts.maxChars ?? 1500;

  const sections = splitSections(body);
  const pieces: { headingPath: string[]; body: string }[] = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (!text) continue;
    for (const part of splitBySize(text, maxWords, maxChars)) {
      pieces.push({ headingPath: section.headingPath, body: part });
    }
  }

  return pieces.map((p, ord) => {
    const trail = p.headingPath.length ? `${p.headingPath.join(' > ')}\n` : '';
    return {
      ord,
      headingPath: p.headingPath,
      body: p.body,
      text: `${title}\n${trail}${p.body}`,
      tokenCount: estimateTokens(p.body),
    };
  });
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [{ headingPath: [], lines: [] }];
  const stack: { level: number; text: string }[] = [];
  let inFence: string | null = null;

  for (const line of body.split(/\r?\n/)) {
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '';
      if (inFence === null) inFence = marker;
      else if (inFence === marker) inFence = null;
      sections[sections.length - 1]?.lines.push(line);
      continue;
    }
    const h = inFence === null ? parseHeading(line) : null;
    if (h) {
      const level = h.level;
      while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, text: h.text });
      sections.push({ headingPath: stack.map((s) => s.text), lines: [] });
      continue;
    }
    sections[sections.length - 1]?.lines.push(line);
  }
  return sections;
}

/** Splits text into paragraphs, keeping fenced code blocks whole. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence: string | null = null;
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '';
      if (inFence === null) inFence = marker;
      else if (inFence === marker) inFence = null;
    }
    if (inFence === null && !fence && line.trim() === '') {
      if (current.length) out.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current.join('\n'));
  return out.map((p) => p.trim()).filter(Boolean);
}

function splitBySize(text: string, maxWords: number, maxChars: number): string[] {
  const paras = paragraphs(text);
  const fits = countWords(text) <= maxWords && text.length <= maxChars;
  if (fits) return [text];

  // Oversized: pack paragraphs (hard-splitting any giant block) into chunks of at most
  // maxWords words and maxChars characters.
  const blocks = paras.flatMap((p) => (p.length > maxChars ? hardSplit(p, maxChars) : [p]));
  const out: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const block of blocks) {
    const w = countWords(block);
    const chars = current.reduce((n, b) => n + b.length + 2, 0);
    if (current.length && (words + w > maxWords || chars + block.length > maxChars)) {
      out.push(current.join('\n\n'));
      current = [];
      words = 0;
    }
    current.push(block);
    words += w;
  }
  if (current.length) out.push(current.join('\n\n'));
  return out;
}

/** Cuts an oversized block (e.g. a pasted log) at sentence or whitespace boundaries. */
function hardSplit(block: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = block;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (const re of [/[.!?]\s/g, /\n/g, /\s/g]) {
      let m: RegExpExecArray | null;
      let last = -1;
      re.lastIndex = 0;
      while ((m = re.exec(window)) !== null) last = m.index + 1;
      if (last > maxChars * 0.5) {
        cut = last;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
