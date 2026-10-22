/** `wdjbmjht` or `WDJB MJHT` → `WDJB-MJHT`. */
export function normalizeUserCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : input.trim().toUpperCase();
}
