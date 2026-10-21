const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Accepts `2026-10-21` (treated as a local date) or a full ISO timestamp. */
export function parseDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  }
  return new Date(value);
}

/** "Today", "Yesterday", "Monday", or "12 Oct 2026", like Apple Notes. */
export function formatDay(value: string, now = new Date()): string {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Time for today, otherwise a short date. */
export function formatShort(value: string, now = new Date()): string {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return value;
  if (startOfDay(now) === startOfDay(date) && value.includes('T')) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return formatDay(value, now);
}

export function formatDateTime(value: string): string {
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "2 hours ago", "in 14 minutes". */
export function formatRelative(value: string, now = new Date()): string {
  const date = parseDate(value);
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(seconds / 86_400), 'day');
  return formatDay(value, now);
}

/** Groups items into Apple Notes style buckets: Today, Yesterday, Previous 7 Days, month names. */
export function groupByRecency<T>(
  items: T[],
  getDate: (item: T) => string,
  now = new Date(),
): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const date = parseDate(getDate(item));
    const diff = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
    let label: string;
    if (diff <= 0) label = 'Today';
    else if (diff === 1) label = 'Yesterday';
    else if (diff < 7) label = 'Previous 7 Days';
    else if (diff < 30) label = 'Previous 30 Days';
    else
      label = date.toLocaleDateString(undefined, {
        month: 'long',
        year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      });
    const list = groups.get(label) ?? [];
    list.push(item);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, items: list }));
}

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
