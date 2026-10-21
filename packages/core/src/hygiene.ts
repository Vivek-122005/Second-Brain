import { slugify } from './paths';

/**
 * Heuristics for `brain_check` (FR-SES-05, security.md §4.5). They only *suggest*; nothing here
 * changes notes.
 */

const INSTRUCTION_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /\bignore (?:all |any )?(?:the )?(?:previous|prior|above) (?:instructions|rules|prompts?)\b/i,
    reason: 'asks to ignore previous instructions',
  },
  {
    re: /\bdisregard (?:all |any )?(?:the )?(?:previous|prior|system) (?:instructions|prompt)\b/i,
    reason: 'asks to disregard instructions',
  },
  { re: /\byou are now (?:a|an|in) /i, reason: 'tries to change the assistant role' },
  {
    re: /<\/?(?:system|assistant|im_start|im_end)>/i,
    reason: 'contains chat-template control tags',
  },
  {
    re: /\b(?:exfiltrate|send (?:all|the) (?:secrets|keys|credentials|env))\b/i,
    reason: 'mentions exfiltrating secrets',
  },
  { re: /\bcurl\s+[^\n]*\|\s*(?:sh|bash)\b/i, reason: 'pipes a download into a shell' },
];

/** Flags note text that looks like it is trying to instruct an agent (prompt injection). */
export function findSuspiciousInstructions(text: string): string[] {
  return INSTRUCTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.reason);
}

function titleTokens(title: string): Set<string> {
  return new Set(
    slugify(title, 200)
      .split('-')
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface TopicLike {
  path: string;
  title: string;
  aliases?: string[];
}

/** Pairs of topics whose titles or aliases look like the same subject. */
export function findDuplicateTopics(
  topics: TopicLike[],
  threshold = 0.75,
): { a: string; b: string; reason: string }[] {
  const out: { a: string; b: string; reason: string }[] = [];
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const a = topics[i];
      const b = topics[j];
      if (!a || !b) continue;
      const namesA = [a.title, ...(a.aliases ?? [])].map((n) => slugify(n));
      const namesB = [b.title, ...(b.aliases ?? [])].map((n) => slugify(n));
      if (namesA.some((n) => namesB.includes(n))) {
        out.push({ a: a.path, b: b.path, reason: 'same title or alias' });
        continue;
      }
      const sim = jaccard(titleTokens(a.title), titleTokens(b.title));
      if (sim >= threshold)
        out.push({ a: a.path, b: b.path, reason: `similar titles (${Math.round(sim * 100)}%)` });
    }
  }
  return out;
}
