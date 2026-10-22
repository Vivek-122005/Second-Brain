import { formatDateTime } from '../lib/format';
import { RouterAnchor } from './ui/RouterAnchor';

interface PropertyListProps {
  frontmatter: Record<string, unknown>;
  resolveLink: (target: string) => string | null;
}

const HIDDEN = new Set(['title']);
const LABELS: Record<string, string> = {
  next: 'Next steps',
  updated: 'Updated',
  started: 'Started',
  saved: 'Saved',
  id: 'ID',
};

function label(key: string): string {
  return LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
}

function Value({
  value,
  resolveLink,
}: {
  value: unknown;
  resolveLink: PropertyListProps['resolveLink'];
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-label-tertiary">—</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-label-tertiary">—</span>;
    const short = value.every((v) => typeof v === 'string' && v.length <= 24);
    if (short) {
      return (
        <span className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span key={i} className="rounded-full bg-fill px-2 py-px text-[12px] text-label">
              {String(v)}
            </span>
          ))}
        </span>
      );
    }
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} resolveLink={resolveLink} />
          </li>
        ))}
      </ul>
    );
  }
  if (value instanceof Date) return <span>{formatDateTime(value.toISOString())}</span>;
  if (typeof value === 'object') {
    return <code className="font-mono text-[12px]">{JSON.stringify(value)}</code>;
  }
  const text = String(value);
  const wiki = /^\[\[([^\]|#]+)(?:[^\]]*)\]\]$/.exec(text.trim());
  if (wiki?.[1]) {
    const href = resolveLink(wiki[1]);
    return href ? (
      <RouterAnchor href={href} className="text-accent-text hover:underline">
        {wiki[1].split('/').pop()}
      </RouterAnchor>
    ) : (
      <span>{wiki[1]}</span>
    );
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return <span>{formatDateTime(text)}</span>;
  return <span>{text}</span>;
}

/** Frontmatter as a tidy two-column property list, like Finder's Get Info. */
export function PropertyList({ frontmatter, resolveLink }: PropertyListProps) {
  const entries = Object.entries(frontmatter).filter(([k]) => !HIDDEN.has(k));
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(84px,auto)_1fr] gap-x-5 gap-y-1.5 rounded-card bg-grouped/60 px-4 py-3 text-[13px] ring-1 ring-separator">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-label-secondary">{label(key)}</dt>
          <dd className="min-w-0 break-words text-label">
            <Value value={value} resolveLink={resolveLink} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
