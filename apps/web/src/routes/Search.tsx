import { useRouter } from '@tanstack/react-router';
import { Search as SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { NoteType } from '../api/contract';
import { useSearch } from '../api/queries';
import { PAGE_SEARCH_ID } from '../components/layout/AppShell';
import { Page } from '../components/layout/Pane';
import { Snippet } from '../components/Snippet';
import { EmptyState, ErrorState, Pill, Skeleton } from '../components/ui/Feedback';
import { GroupedSection, Row } from '../components/ui/GroupedList';
import { cn } from '../lib/cn';
import { buildHref } from '../lib/href';
import { noteHref, TYPE_LABELS } from '../lib/notes';
import { useDebounced } from '../lib/useDebounced';

export interface SearchPageSearch {
  q?: string | undefined;
  types?: string | undefined;
}

const FILTERS: { value: NoteType; label: string }[] = [
  { value: 'project', label: 'Projects' },
  { value: 'topic', label: 'Topics' },
  { value: 'decision-log', label: 'Decisions' },
  { value: 'session', label: 'Sessions' },
  { value: 'note', label: 'Notes' },
];

function parseTypes(raw: string | undefined): NoteType[] {
  const valid = new Set(FILTERS.map((f) => f.value));
  return (raw ?? '').split(',').filter((t): t is NoteType => valid.has(t as NoteType));
}

export function SearchPage({ search }: { search: SearchPageSearch }) {
  const router = useRouter();
  const [query, setQuery] = useState(search.q ?? '');
  // Pick up a new ?q= from outside (sidebar search, palette) without remounting.
  const [urlQ, setUrlQ] = useState(search.q ?? '');
  if ((search.q ?? '') !== urlQ) {
    setUrlQ(search.q ?? '');
    if ((search.q ?? '') !== query.trim()) setQuery(search.q ?? '');
  }
  const types = parseTypes(search.types);
  const debounced = useDebounced(query, 200);
  const results = useSearch(debounced, types, 30);

  // Keep the URL in sync with what is typed (replace, so Back skips keystrokes).
  useEffect(() => {
    const q = debounced.trim();
    if (q === (search.q ?? '')) return;
    void router.navigate({
      href: buildHref('/search', { q: q || undefined, types: search.types }),
      replace: true,
    });
  }, [debounced, search.q, search.types, router]);

  const toggleType = (t: NoteType) => {
    const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t];
    void router.navigate({
      href: buildHref('/search', {
        q: query.trim() || undefined,
        types: next.join(',') || undefined,
      }),
      replace: true,
    });
  };

  const hits = results.data?.hits ?? [];
  const q = debounced.trim();

  return (
    <Page title="Search">
      <form role="search" onSubmit={(e) => e.preventDefault()} className="mb-4">
        <label htmlFor={PAGE_SEARCH_ID} className="sr-only">
          Search all notes
        </label>
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-label-secondary"
            strokeWidth={1.75}
          />
          <input
            id={PAGE_SEARCH_ID}
            type="search"
            autoFocus
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects, topics, decisions, sessions…"
            className="h-11 w-full rounded-[11px] bg-cell pr-4 pl-10 text-[16px] text-label shadow-soft ring-1 ring-separator focus:shadow-[0_0_0_3px_var(--color-accent-tint)] focus:ring-accent focus:outline-none"
          />
        </div>
      </form>

      <div role="group" aria-label="Filter by type" className="mb-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const on = types.includes(f.value);
          return (
            <button
              key={f.value}
              type="button"
              aria-pressed={on}
              onClick={() => toggleType(f.value)}
              className={cn(
                'h-8 rounded-full px-3.5 text-[13px] font-medium transition-colors duration-150',
                on ? 'bg-accent-fill text-on-accent' : 'bg-fill text-label hover:bg-fill-strong',
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {!q ? (
        <EmptyState icon={SearchIcon} title="Search your brain">
          Find anything across projects, topics, decisions and sessions.
        </EmptyState>
      ) : results.isPending ? (
        <Skeleton lines={6} />
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : hits.length === 0 ? (
        <EmptyState icon={SearchIcon} title="No results">
          Nothing matches “{q}”{types.length ? ' with these filters' : ''}.
        </EmptyState>
      ) : (
        <GroupedSection
          title={`${hits.length} ${hits.length === 1 ? 'result' : 'results'}`}
          action={
            <span className="text-[12px] text-label-secondary">
              {results.data.mode === 'hybrid' ? 'Keyword + semantic' : 'Keyword'}
              {results.isFetching ? ' · updating…' : ''}
            </span>
          }
        >
          {hits.map((hit) => (
            <Row key={`${hit.path}#${hit.heading}`} href={noteHref(hit.path)}>
              <span className="block min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-medium text-label">{hit.title}</span>
                  <Pill tone="gray">{TYPE_LABELS[hit.type as NoteType] ?? hit.type}</Pill>
                </span>
                {hit.heading ? (
                  <span className="mt-0.5 block truncate text-[12px] text-label-secondary">
                    {hit.heading}
                  </span>
                ) : null}
                <Snippet
                  text={hit.snippet}
                  className="mt-1 line-clamp-2 block text-[13px] leading-snug text-label-secondary"
                />
              </span>
            </Row>
          ))}
        </GroupedSection>
      )}
    </Page>
  );
}
