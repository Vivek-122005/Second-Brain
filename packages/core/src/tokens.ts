/**
 * Cheap token estimate: ~4 characters per token for English prose and code (LLD §4.3).
 * Deliberately conservative; budgets use it to decide what to drop, not for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

/** Truncates text to roughly `maxTokens`, cutting at a line or word boundary. */
export function truncateToTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  const sp = cut.lastIndexOf(' ');
  const at = nl > maxChars * 0.6 ? nl : sp > maxChars * 0.6 ? sp : maxChars;
  cut = cut.slice(0, at).trimEnd();
  return { text: cut, truncated: true };
}
