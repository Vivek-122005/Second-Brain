import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ListFilter, SquarePen, type LucideIcon } from 'lucide-react';
import type { NoteType } from '../api/contract';
import { useNotes, useProjects } from '../api/queries';
import { NotePane, NoSelection } from '../components/NoteView';
import { PaneHeader, SplitView } from '../components/layout/Pane';
import { Button, IconButton } from '../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback';
import { RouterAnchor } from '../components/ui/RouterAnchor';
import { cn } from '../lib/cn';
import { formatShort, groupByRecency } from '../lib/format';
import { buildHref } from '../lib/href';
import { MOD_LABEL } from '../lib/hotkeys';
import type { SectionPath } from '../lib/notes';
import { useUi } from '../lib/ui-context';

export interface NoteSearch {
  path?: string | undefined;
  mode?: 'edit' | undefined;
  project?: string | undefined;
}

const menuItem =
  'flex h-8 cursor-default items-center gap-2 rounded-[6px] pr-2.5 pl-7 text-[14px] text-label outline-none select-none data-[highlighted]:bg-accent-fill data-[highlighted]:text-on-accent relative';

function ProjectFilter({
  value,
  onHref,
}: {
  value: string | undefined;
  onHref: (project: string | undefined) => string;
}) {
  const projects = useProjects();
  const items = projects.data?.items ?? [];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton
          label={value ? `Filtered by ${value}` : 'Filter by project'}
          tone={value ? 'accent' : 'default'}
        >
          <ListFilter className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="animate-fade z-50 max-h-[60dvh] min-w-52 overflow-y-auto rounded-[10px] bg-elevated p-1 shadow-sheet ring-1 ring-separator"
        >
          <DropdownMenu.Label className="px-2.5 py-1 text-[12px] font-medium text-label-secondary">
            Project
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value ?? ''}>
            {[{ slug: '', title: 'All projects' }, ...items].map((p) => (
              <DropdownMenu.RadioItem key={p.slug} value={p.slug} className={menuItem} asChild>
                <RouterAnchor href={onHref(p.slug || undefined)}>
                  <DropdownMenu.ItemIndicator className="absolute left-2">
                    <Check className="size-3.5" strokeWidth={2.25} aria-hidden />
                  </DropdownMenu.ItemIndicator>
                  {p.title}
                </RouterAnchor>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface NotesSectionProps {
  section: SectionPath;
  title: string;
  /** Note type to list; undefined lists every note. */
  type?: NoteType;
  icon: LucideIcon;
  emptyText: string;
  search: NoteSearch;
}

/** A sidebar section: list of notes (grouped by recency) plus the selected note. */
export function NotesSection({ section, title, type, icon, emptyText, search }: NotesSectionProps) {
  const { openNewNote } = useUi();
  const notes = useNotes({
    ...(type ? { type } : {}),
    ...(search.project ? { project: search.project } : {}),
  });
  const items = notes.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = groupByRecency(items, (n) => n.updated_at);

  const listHref = buildHref(section, { project: search.project });
  const hrefFor = (path: string, edit = false) =>
    buildHref(section, { project: search.project, path, mode: edit ? 'edit' : undefined });

  const list = (
    <>
      <PaneHeader
        title={title}
        subtitle={
          notes.isSuccess
            ? `${items.length}${notes.hasNextPage ? '+' : ''} ${items.length === 1 ? 'note' : 'notes'}${search.project ? ` · ${search.project}` : ''}`
            : undefined
        }
        showSidebarToggle
        actions={
          <>
            <ProjectFilter
              value={search.project}
              onHref={(project) => buildHref(section, { project, path: search.path })}
            />
            <IconButton
              label="New note"
              shortcut={`${MOD_LABEL}N`}
              onClick={openNewNote}
              tone="accent"
            >
              <SquarePen className="size-[18px]" strokeWidth={1.75} aria-hidden />
            </IconButton>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto px-2 pb-6">
        {notes.isPending ? (
          <Skeleton lines={8} className="p-4" />
        ) : notes.isError ? (
          <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={icon} title={`No ${title.toLowerCase()} yet`}>
            {emptyText}
          </EmptyState>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.label}>
                <h2 className="sticky top-0 z-[1] bg-canvas/95 px-3 pt-4 pb-1 text-[12px] font-semibold text-label-secondary backdrop-blur">
                  {g.label}
                </h2>
                <ul>
                  {g.items.map((n) => {
                    const selected = n.path === search.path;
                    return (
                      <li key={n.path}>
                        <RouterAnchor
                          href={hrefFor(n.path)}
                          aria-current={selected ? 'true' : undefined}
                          className={cn(
                            'relative block rounded-[9px] px-3 py-2.5 transition-colors duration-100',
                            selected ? 'bg-accent-tint' : 'hover:bg-hover',
                          )}
                        >
                          <span className="block truncate text-[14px] font-semibold text-label">
                            {n.title}
                          </span>
                          <span className="mt-0.5 flex gap-2 text-[13px] text-label-secondary">
                            <span className="shrink-0 tabular-nums">
                              {formatShort(n.updated_at)}
                            </span>
                            <span className="truncate">
                              {[n.project, ...n.tags.map((t) => `#${t}`)]
                                .filter(Boolean)
                                .join('  ')}
                            </span>
                          </span>
                        </RouterAnchor>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {notes.hasNextPage ? (
              <div className="flex justify-center py-3">
                <Button
                  variant="plain"
                  onClick={() => void notes.fetchNextPage()}
                  disabled={notes.isFetchingNextPage}
                >
                  {notes.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );

  const detail = search.path ? (
    <NotePane
      path={search.path}
      backHref={listHref}
      viewHref={hrefFor(search.path)}
      editHref={hrefFor(search.path, true)}
      editing={search.mode === 'edit'}
    />
  ) : (
    <NoSelection label={`Choose a note from ${title}, or press ${MOD_LABEL}K to jump to one.`} />
  );

  return (
    <SplitView list={list} detail={detail} hasSelection={Boolean(search.path)} listLabel={title} />
  );
}
