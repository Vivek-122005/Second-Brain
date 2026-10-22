import { FolderClosed, SquarePen } from 'lucide-react';
import { useRouter } from '@tanstack/react-router';
import type { ProjectStatus } from '../api/contract';
import { useNotes, useProjects } from '../api/queries';
import { NotePane, NoSelection } from '../components/NoteView';
import { PaneHeader, SplitView } from '../components/layout/Pane';
import { IconButton } from '../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/Feedback';
import { GroupedSection, Row, RowText } from '../components/ui/GroupedList';
import { RouterAnchor } from '../components/ui/RouterAnchor';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { cn } from '../lib/cn';
import { formatDay } from '../lib/format';
import { buildHref } from '../lib/href';
import { MOD_LABEL } from '../lib/hotkeys';
import { noteHref, projectNotePath } from '../lib/notes';
import { useUi } from '../lib/ui-context';

export type ProjectFilter = 'active' | 'paused' | 'done';

export interface ProjectsSearch {
  status?: ProjectFilter | undefined;
  path?: string | undefined;
  mode?: 'edit' | undefined;
}

function RelatedSessions({ slug }: { slug: string }) {
  const sessions = useNotes({ type: 'session', project: slug, limit: 5 });
  const items = sessions.data?.pages[0]?.items ?? [];
  if (!sessions.isSuccess || items.length === 0) return null;
  return (
    <div className="mt-10">
      <GroupedSection title="Recent sessions">
        {items.map((s) => (
          <Row key={s.path} href={noteHref(s.path)}>
            <RowText title={s.title} meta={formatDay(s.updated_at)} />
          </Row>
        ))}
      </GroupedSection>
    </div>
  );
}

export function ProjectsPage({ search }: { search: ProjectsSearch }) {
  const router = useRouter();
  const { openNewNote } = useUi();
  const status: ProjectFilter = search.status ?? 'active';
  const projects = useProjects(status as ProjectStatus);
  const items = projects.data?.items ?? [];
  const href = (s: ProjectsSearch) =>
    buildHref('/projects', {
      status: s.status === 'active' ? undefined : s.status,
      path: s.path,
      mode: s.mode,
    });

  const list = (
    <>
      <PaneHeader
        title="Projects"
        showSidebarToggle
        actions={
          <IconButton
            label="New note"
            shortcut={`${MOD_LABEL}N`}
            onClick={openNewNote}
            tone="accent"
          >
            <SquarePen className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </IconButton>
        }
      />
      <div className="px-3 pt-3 pb-1">
        <SegmentedControl<ProjectFilter>
          label="Project status"
          className="w-full"
          value={status}
          onChange={(s) => void router.navigate({ href: href({ status: s }) })}
          segments={[
            { value: 'active', label: 'Active' },
            { value: 'paused', label: 'Paused' },
            { value: 'done', label: 'Done' },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-6">
        {projects.isPending ? (
          <Skeleton lines={6} className="p-4" />
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={FolderClosed} title={`No ${status} projects`}>
            Projects you create in <code className="font-mono">projects/</code> show up here.
          </EmptyState>
        ) : (
          <ul>
            {items.map((p) => {
              const path = projectNotePath(p.slug);
              const selected = search.path === path;
              return (
                <li key={p.slug}>
                  <RouterAnchor
                    href={href({ status, path })}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'block rounded-[9px] px-3 py-2.5 transition-colors duration-100',
                      selected ? 'bg-accent-tint' : 'hover:bg-hover',
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[14px] font-semibold text-label">
                        {p.title}
                      </span>
                      {p.updated ? (
                        <span className="shrink-0 text-[12px] text-label-secondary">
                          {formatDay(p.updated)}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] text-label-secondary">
                      {p.next ? `Next: ${p.next}` : 'No next step recorded'}
                    </span>
                  </RouterAnchor>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );

  const slug = search.path?.replace(/^projects\//, '').replace(/\.md$/, '');
  const detail = search.path ? (
    <NotePane
      path={search.path}
      backHref={href({ status })}
      viewHref={href({ status, path: search.path })}
      editHref={href({ status, path: search.path, mode: 'edit' })}
      editing={search.mode === 'edit'}
      extra={slug ? <RelatedSessions slug={slug} /> : undefined}
    />
  ) : (
    <NoSelection label="Choose a project to see its goal, next steps and recent sessions." />
  );

  return (
    <SplitView
      list={list}
      detail={detail}
      hasSelection={Boolean(search.path)}
      listLabel="Projects"
    />
  );
}
