/**
 * Turns free text into a safe SQLite FTS5 MATCH expression (FR-SRC-02).
 *
 * Every term is wrapped in double quotes, so FTS operators (AND, OR, NOT, NEAR, `*`, `^`,
 * column filters, parentheses) typed by a user or an agent are matched as plain words and can
 * never change the query's meaning or cause a syntax error. The last term gets a prefix `*` so
 * search-as-you-type works. Returns null when nothing searchable is left.
 */
export function sanitizeFtsQuery(
  input: string,
  opts: { prefixLast?: boolean; maxTerms?: number } = {},
): string | null {
  const prefixLast = opts.prefixLast ?? true;
  const maxTerms = opts.maxTerms ?? 12;

  const terms = input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, maxTerms);

  if (terms.length === 0) return null;
  return terms
    .map((t, i) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return prefixLast && i === terms.length - 1 && t.length >= 2 ? `${quoted}*` : quoted;
    })
    .join(' ');
}
