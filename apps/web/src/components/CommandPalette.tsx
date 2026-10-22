import { useRouter } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  BookOpen,
  FileText,
  FolderClosed,
  History,
  Inbox,
  KeyRound,
  Moon,
  Scale,
  Search,
  Settings,
  SquarePen,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useSearch } from '../api/queries';
import { noteHref, TYPE_LABELS } from '../lib/notes';
import { resolvedScheme, useThemePreference } from '../lib/theme';
import { useDebounced } from '../lib/useDebounced';
import type { NoteType } from '../api/contract';
import { Snippet } from './Snippet';
import { Spinner } from './ui/Feedback';

interface Action {
  id: string;
  label: string;
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
}

const TYPE_ICONS: Record<string, LucideIcon> = {
  project: FolderClosed,
  topic: BookOpen,
  'decision-log': Scale,
  session: History,
  note: FileText,
};

/** ⌘K: jump anywhere, run an action, or search notes as you type. */
export function CommandPalette({
  open,
  onOpenChange,
  onNewNote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewNote: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 150);
  const search = useSearch(open ? debounced : '', [], 8);
  const [pref, setPref] = useThemePreference();

  const close = () => {
    onOpenChange(false);
    setQuery('');
  };
  const go = (href: string) => {
    close();
    void router.navigate({ href });
  };

  const actions: Action[] = [
    { id: 'today', label: 'Today', icon: Sun, keywords: 'dashboard home', run: () => go('/') },
    { id: 'projects', label: 'Projects', icon: FolderClosed, run: () => go('/projects') },
    { id: 'topics', label: 'Topics', icon: BookOpen, run: () => go('/topics') },
    { id: 'decisions', label: 'Decisions', icon: Scale, run: () => go('/decisions') },
    { id: 'sessions', label: 'Sessions', icon: History, run: () => go('/sessions') },
    { id: 'inbox', label: 'Inbox', icon: Inbox, run: () => go('/inbox') },
    {
      id: 'keys',
      label: 'Keys & Devices',
      icon: KeyRound,
      keywords: 'api mcp connect',
      run: () => go('/keys'),
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      keywords: 'account theme sign out',
      run: () => go('/settings'),
    },
    {
      id: 'new',
      label: 'New note',
      icon: SquarePen,
      keywords: 'create add',
      run: () => {
        close();
        onNewNote();
      },
    },
    {
      id: 'theme',
      label:
        resolvedScheme(pref) === 'dark'
          ? 'Switch to light appearance'
          : 'Switch to dark appearance',
      icon: resolvedScheme(pref) === 'dark' ? Sun : Moon,
      keywords: 'theme dark light mode appearance',
      run: () => {
        setPref(resolvedScheme(pref) === 'dark' ? 'light' : 'dark');
        close();
      },
    },
  ];

  const q = query.trim().toLowerCase();
  const visibleActions = q
    ? actions.filter((a) => `${a.label} ${a.keywords ?? ''}`.toLowerCase().includes(q))
    : actions;
  const hits = q ? (search.data?.hits ?? []) : [];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      label="Command palette"
      shouldFilter={false}
      loop
      overlayClassName="animate-fade fixed inset-0 z-40 bg-scrim"
      contentClassName="animate-sheet fixed top-[12dvh] left-1/2 z-50 w-[calc(100%-32px)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-sheet bg-elevated shadow-sheet ring-1 ring-separator"
    >
      <div className="hairline-b flex items-center gap-2.5 px-4">
        <Search aria-hidden className="size-[18px] text-label-secondary" strokeWidth={1.75} />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search notes or jump to…"
          className="h-13 flex-1 bg-transparent text-[16px] text-label focus:outline-none"
        />
        {search.isFetching && q ? <Spinner label="Searching" /> : null}
      </div>
      <Command.List className="max-h-[min(60dvh,440px)] overflow-y-auto py-2">
        <Command.Empty>{q && search.isFetching ? 'Searching…' : 'No results'}</Command.Empty>
        {hits.length > 0 ? (
          <Command.Group heading="Notes">
            {hits.map((hit) => {
              const Icon = TYPE_ICONS[hit.type] ?? FileText;
              return (
                <Command.Item
                  key={`${hit.path}#${hit.heading}`}
                  value={`note:${hit.path}`}
                  onSelect={() => go(noteHref(hit.path))}
                >
                  <Icon aria-hidden className="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{hit.title}</span>
                    <Snippet
                      text={hit.snippet}
                      className="cmdk-sub block truncate text-[12px] text-label-secondary"
                    />
                  </span>
                  <span className="cmdk-sub shrink-0 text-[12px] text-label-secondary">
                    {TYPE_LABELS[hit.type as NoteType] ?? hit.type}
                  </span>
                </Command.Item>
              );
            })}
            <Command.Item
              value="search:all"
              onSelect={() => go(`/search?q=${encodeURIComponent(query.trim())}`)}
            >
              <Search aria-hidden className="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
              <span>Show all results for “{query.trim()}”</span>
            </Command.Item>
          </Command.Group>
        ) : null}
        {visibleActions.length > 0 ? (
          <Command.Group heading={q ? 'Actions' : 'Go to'}>
            {visibleActions.map((a) => (
              <Command.Item key={a.id} value={`action:${a.id}`} onSelect={a.run}>
                <a.icon aria-hidden className="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
                <span>{a.label}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
