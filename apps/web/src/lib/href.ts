/** Builds `/pathname?a=b` from a search object, dropping empty values. */
export function buildHref(
  pathname: string,
  search: Record<string, string | undefined | null>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  }
  const s = params.toString();
  return s ? `${pathname}?${s}` : pathname;
}
