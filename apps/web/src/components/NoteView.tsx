import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Ellipsis, FileText, Info, Link2, Pencil } from 'lucide-react';
import { lazy, Suspense, useCallback, useMemo, type ReactNode } from 'react';
import type { NoteDetail } from '../api/contract';
import { useNote } from '../api/queries';
import { copyText } from '../lib/clipboard';
import { formatDateTime, formatDay } from '../lib/format';
import { noteHref, stripFrontmatter, TYPE_LABELS } from '../lib/notes';
import { useUi } from '../lib/ui-context';
import { resolverFromLinks } from '../lib/wikilinks';
import { PaneHeader } from './layout/Pane';
import { Markdown } from './Markdown';
import { PropertyList } from './PropertyList';
import { IconButton, IconLink } from './ui/Button';
import { EmptyState, ErrorState, LoadingPane, Skeleton } from './ui/Feedback';
import { GroupedSection, Row, RowText } from './ui/GroupedList';

// CodeMirror is big; load it only when someone edits.
const NoteEditor = lazy(() => import('./editor/NoteEditor'));

const menuItem =
  'flex h-8 cursor-default items-center gap-2.5 rounded-[6px] px-2.5 text-[14px] text-label outline-none select-none data-[highlighted]:bg-accent-fill data-[highlighted]:text-on-accent';

interface NotePaneProps {
  path: string;
  /** Href that leaves the note (phones show a Back button to it). */
  backHref: string;
  /** Href for view mode and edit mode of this note in the current section. */
  viewHref: string;
  editHref: string;
  editing: boolean;
  /** Extra content under the note (e.g. related sessions for a project). */
  extra?: ReactNode;
}

/** Detail column: a note rendered for reading, or the editor when `editing`. */
export function NotePane({ path, backHref, viewHref, editHref, editing, extra }: NotePaneProps) {
  const note = useNote(path);

  if (note.isPending) {
    return (
      <>
        <PaneHeader backHref={backHref} />
        <div className="mx-auto w-full max-w-[720px] px-6 py-10">
          <Skeleton lines={6} />
        </div>
      </>
    );
  }
  if (note.isError) {
    return (
      <>
        <PaneHeader backHref={backHref} />
        <ErrorState error={note.error} onRetry={() => void note.refetch()} />
      </>
    );
  }
  if (editing) {
    return (
      <Suspense fallback={<LoadingPane label="Loading editor" />}>
        <NoteEditor key={note.data.path} note={note.data} doneHref={viewHref} backHref={backHref} />
      </Suspense>
    );
  }
  return <NoteReader note={note.data} backHref={backHref} editHref={editHref} extra={extra} />;
}

function NoteReader({
  note,
  backHref,
  editHref,
  extra,
}: {
  note: NoteDetail;
  backHref: string;
  editHref: string;
  extra?: ReactNode;
}) {
  const { toast } = useUi();
  const toHref = useCallback((p: string) => noteHref(p), []);
  const resolve = useMemo(() => resolverFromLinks(note.links, toHref), [note.links, toHref]);
  const body = note.body || stripFrontmatter(note.raw);
  const wikilink = `[[${note.path.replace(/\.md$/, '')}]]`;

  const copy = (text: string, what: string) => {
    void copyText(text).then((ok) => toast(ok ? `${what} copied` : 'Could not copy'));
  };

  return (
    <>
      <PaneHeader
        backHref={backHref}
        title={<span className="md:sr-only">{note.title}</span>}
        actions={
          <>
            <IconLink label="Edit" href={editHref}>
              <Pencil className="size-[18px]" strokeWidth={1.75} aria-hidden />
            </IconLink>
            <Popover.Root>
              <Popover.Trigger asChild>
                <IconButton label="Note info">
                  <Info className="size-[18px]" strokeWidth={1.75} aria-hidden />
                </IconButton>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={6}
                  className="animate-fade z-50 w-72 rounded-card bg-elevated p-4 text-[13px] shadow-sheet ring-1 ring-separator focus:outline-none"
                >
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                    <dt className="text-label-secondary">Path</dt>
                    <dd className="font-mono text-[12px] break-all">{note.path}</dd>
                    <dt className="text-label-secondary">Type</dt>
                    <dd>{TYPE_LABELS[note.type]}</dd>
                    <dt className="text-label-secondary">Modified</dt>
                    <dd>{formatDateTime(note.updated_at)}</dd>
                    <dt className="text-label-secondary">Version</dt>
                    <dd className="font-mono text-[12px] break-all">{note.version}</dd>
                  </dl>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton label="More actions">
                  <Ellipsis className="size-[18px]" strokeWidth={1.75} aria-hidden />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="animate-fade z-50 min-w-48 rounded-[10px] bg-elevated p-1 shadow-sheet ring-1 ring-separator"
                >
                  <DropdownMenu.Item
                    className={menuItem}
                    onSelect={() => copy(wikilink, 'Wikilink')}
                  >
                    <Link2 aria-hidden className="size-4" strokeWidth={1.75} /> Copy wikilink
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className={menuItem} onSelect={() => copy(note.path, 'Path')}>
                    <FileText aria-hidden className="size-4" strokeWidth={1.75} /> Copy path
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-[720px] px-5 pt-6 pb-20 sm:px-10">
          <p className="mb-4 text-center text-[12px] text-label-secondary">
            {TYPE_LABELS[note.type]} · Edited {formatDay(note.updated_at)}
            {note.project ? ` · ${note.project}` : ''}
          </p>
          <details className="group mb-6">
            <summary className="mb-2 inline-flex cursor-default list-none items-center gap-1 rounded-md text-[13px] font-medium text-label-secondary hover:text-label [&::-webkit-details-marker]:hidden">
              <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>
                ›
              </span>
              Properties
            </summary>
            <PropertyList frontmatter={note.frontmatter} resolveLink={resolve} />
          </details>
          <Markdown source={body} resolveLink={resolve} />

          {extra}

          {note.links.length > 0 || note.backlinks.length > 0 ? (
            <div className="mt-12 grid gap-x-6 sm:grid-cols-2">
              <GroupedSection title={`Links (${note.links.length})`}>
                {note.links.length === 0 ? (
                  <Row>
                    <span className="text-[14px] text-label-secondary">None</span>
                  </Row>
                ) : (
                  note.links.map((l) =>
                    l.path ? (
                      <Row key={l.target} href={noteHref(l.path)}>
                        <RowText title={l.target} />
                      </Row>
                    ) : (
                      <Row
                        key={l.target}
                        href={`/search?q=${encodeURIComponent(l.target)}`}
                        trailing={<span className="text-[12px]">Missing</span>}
                      >
                        <RowText title={<span className="text-label-secondary">{l.target}</span>} />
                      </Row>
                    ),
                  )
                )}
              </GroupedSection>
              <GroupedSection title={`Backlinks (${note.backlinks.length})`}>
                {note.backlinks.length === 0 ? (
                  <Row>
                    <span className="text-[14px] text-label-secondary">None</span>
                  </Row>
                ) : (
                  note.backlinks.map((b) => (
                    <Row key={b.path} href={noteHref(b.path)}>
                      <RowText title={b.title} subtitle={b.path} />
                    </Row>
                  ))
                )}
              </GroupedSection>
            </div>
          ) : null}
        </article>
      </div>
    </>
  );
}

export function NoSelection({ label }: { label: string }) {
  return (
    <EmptyState icon={FileText} title="No note selected">
      {label}
    </EmptyState>
  );
}
