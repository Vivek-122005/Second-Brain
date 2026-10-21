export interface Heading {
  level: number;
  text: string;
}

/**
 * Parses an ATX heading line (`## Title ##`) in linear time.
 *
 * Deliberately not a regular expression: patterns like `[ \t]+(.+?)[ \t#]*$` backtrack
 * polynomially on lines full of tabs or spaces, and note text comes from users and agents, so a
 * crafted note could burn the Worker's CPU budget (CodeQL js/polynomial-redos).
 */
export function parseHeading(line: string): Heading | null {
  let level = 0;
  while (level < line.length && line[level] === '#') level++;
  if (level < 1 || level > 6) return null;
  const sep = line[level];
  if (sep !== ' ' && sep !== '\t') return null;

  let text = line.slice(level).trim();
  // Drop an optional closing sequence of #s, which must be preceded by whitespace.
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0) text = '';
  else if (end < text.length && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    text = text.slice(0, end).trimEnd();
  }
  return text ? { level, text } : null;
}

/** True when the line starts a heading of `maxLevel` or higher (fewer #s). */
export function isHeadingAtMost(line: string, maxLevel: number): boolean {
  const h = parseHeading(line);
  return h !== null && h.level <= maxLevel;
}
