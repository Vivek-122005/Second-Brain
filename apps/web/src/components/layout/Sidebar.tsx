import { useRouter, useRouterState } from '@tanstack/react-router';
import {
  BookOpen,
  FolderClosed,
  History,
  Inbox,
  KeyRound,
  Scale,
  Search,
  Settings,
  SquarePen,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useMe } from '../../api/queries';
import { cn } from '../../lib/cn';
import { MOD_LABEL } from '../../lib/hotkeys';
import { useUi } from '../../lib/ui-context';
import { IconButton } from '../ui/Button';
import { Kbd } from '../ui/Feedback';
import { RouterAnchor } from '../ui/RouterAnchor';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const GROUPS: { label?: string; items: NavItem[] }[] = [
  { items: [{ href: '/', label: 'Today', icon: Sun }] },
  {
    label: 'Library',
    items: [
      { href: '/projects', label: 'Projects', icon: FolderClosed },
      { href: '/topics', label: 'Topics', icon: BookOpen },
      { href: '/decisions', label: 'Decisions', icon: Scale },
      { href: '/sessions', label: 'Sessions', icon: History },
      { href: '/inbox', label: 'Inbox', icon: Inbox },
    ],
  },
  {
    label: 'Find',
    items: [{ href: '/search', label: 'Search', icon: Search }],
  },
  {
    label: 'Account',
    items: [
      { href: '/keys', label: 'Keys & Devices', icon: KeyRound },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export const SIDEBAR_SEARCH_ID = 'sidebar-search';

/** Translucent source list, like the sidebar in Notes or Finder. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const router = useRouter();
  const { openNewNote, openPalette } = useUi();
  const me = useMe();
  const [query, setQuery] = useState('');

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    void router.navigate({ href: q ? `/search?q=${encodeURIComponent(q)}` : '/search' });
    setQuery('');
    onNavigate?.();
  };

  return (
    <nav aria-label="Sidebar" className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <span className="flex-1 truncate px-1 text-[13px] font-semibold text-label-secondary">
          Second Brain
        </span>
        <IconButton label="New note" shortcut={`${MOD_LABEL}N`} onClick={openNewNote} tone="accent">
          <SquarePen className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>

      <form role="search" onSubmit={onSearch} className="px-3 pb-3">
        <label htmlFor={SIDEBAR_SEARCH_ID} className="sr-only">
          Search notes
        </label>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-label-secondary"
            strokeWidth={1.75}
          />
          <input
            id={SIDEBAR_SEARCH_ID}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            autoComplete="off"
            className="h-8 w-full rounded-[8px] bg-fill pr-12 pl-8 text-[14px] text-label focus:bg-canvas focus:shadow-[0_0_0_3px_var(--color-accent-tint)] focus:outline-none"
          />
          <button
            type="button"
            onClick={openPalette}
            aria-label="Open command palette"
            className="absolute top-1/2 right-1.5 -translate-y-1/2"
          >
            <Kbd>{MOD_LABEL}K</Kbd>
          </button>
        </div>
      </form>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {GROUPS.map((group, gi) => (
          <div key={gi} className="mb-3">
            {group.label ? (
              <h2 className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-label-secondary uppercase">
                {group.label}
              </h2>
            ) : null}
            <ul>
              {group.items.map((item) => {
                const active =
                  item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <RouterAnchor
                      href={item.href}
                      onClick={() => onNavigate?.()}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex h-8 items-center gap-2.5 rounded-[7px] px-2.5 text-[14px] transition-colors duration-100',
                        active
                          ? 'bg-fill-strong font-medium text-label'
                          : 'text-label hover:bg-hover',
                      )}
                    >
                      <Icon
                        aria-hidden
                        className={cn('size-[17px]', active ? 'text-accent' : 'text-accent/90')}
                        strokeWidth={1.75}
                      />
                      {item.label}
                    </RouterAnchor>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {me.data ? (
        <div className="hairline-t px-4 py-3">
          <p className="truncate text-[13px] font-medium text-label">
            {me.data.user.name ?? me.data.user.email}
          </p>
          <p className="truncate text-[12px] text-label-secondary">{me.data.user.email}</p>
        </div>
      ) : null}
    </nav>
  );
}
