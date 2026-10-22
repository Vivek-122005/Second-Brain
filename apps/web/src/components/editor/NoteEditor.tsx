import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker, useRouter } from '@tanstack/react-router';
import CodeMirror from '@uiw/react-codemirror';
import { FlaskConical } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { useApi } from '../../api/context';
import type { NoteDetail, NoteSummary } from '../../api/contract';
import { qk, useNotes, useSaveNote } from '../../api/queries';
import { cn } from '../../lib/cn';
import { MOD_LABEL } from '../../lib/hotkeys';
import { markAsConflictCopy, noteHref, stripFrontmatter } from '../../lib/notes';
import { useUi } from '../../lib/ui-context';
import { resolverFromLinks } from '../../lib/wikilinks';
import { PaneHeader } from '../layout/Pane';
import { Markdown } from '../Markdown';
import { Button } from '../ui/Button';
import { errorMessage } from '../../lib/errors';
import { SegmentedControl } from '../ui/SegmentedControl';
import { ConfirmDialog } from '../ui/Sheet';
import { ConflictSheet } from './ConflictSheet';
import { markdownHighlighting } from './highlight';

type Mode = 'edit' | 'split' | 'preview';

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--sb-canvas)', color: 'var(--sb-label)' },
  '.cm-content': { padding: '24px 0 120px', caretColor: 'var(--sb-accent)' },
  '.cm-line': { padding: '0 28px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sb-accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--sb-accent) 26%, transparent) !important',
  },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-tooltip': {
    backgroundColor: 'var(--sb-elevated)',
    border: '1px solid var(--sb-separator)',
    borderRadius: '10px',
    boxShadow: 'var(--sb-shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--sb-accent-fill)',
    color: 'var(--sb-on-accent)',
  },
});

/** `[[` triggers completion with note paths, like Obsidian. */
function wikilinkCompletion(notes: NoteSummary[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const match = ctx.matchBefore(/\[\[[^\]\n|#]*/);
    if (!match) return null;
    return {
      from: match.from + 2,
      options: notes.map((n) => ({
        label: n.path.replace(/\.md$/, ''),
        detail: n.title,
        type: 'text',
        apply: `${n.path.replace(/\.md$/, '')}]]`,
      })),
      validFor: /^[^\]\n|#]*$/,
    };
  };
}

function conflictCopyPath(path: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const base = path.replace(/\.md$/, '');
  // Conflict copies go next to the original, except sessions/decision logs which agents own.
  const safeBase = /^(sessions|decisions)\//.test(base)
    ? `inbox/${base.split('/').pop() ?? 'note'}`
    : base;
  return `${safeBase}-conflict-${stamp}.md`;
}

function initialMode(): Mode {
  try {
    return window.matchMedia('(min-width: 1280px)').matches ? 'split' : 'edit';
  } catch {
    return 'edit';
  }
}

export default function NoteEditor({
  note,
  doneHref,
  backHref,
}: {
  note: NoteDetail;
  doneHref: string;
  backHref: string;
}) {
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useUi();
  const save = useSaveNote();
  const allNotes = useNotes({ limit: 200 });

  const [content, setContent] = useState(note.raw);
  const [savedContent, setSavedContent] = useState(note.raw);
  const [baseVersion, setBaseVersion] = useState(note.version);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [conflict, setConflict] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictError, setConflictError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();
  const [copyPath, setCopyPath] = useState('');
  const bypassBlock = useRef(false);

  const dirty = content !== savedContent;

  const blocker = useBlocker({
    shouldBlockFn: () => !bypassBlock.current,
    disabled: !dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });

  const noteList = useMemo<NoteSummary[]>(
    () => allNotes.data?.pages.flatMap((p) => p.items) ?? [],
    [allNotes.data],
  );

  const doSave = useCallback(() => {
    if (!dirty || save.isPending) return;
    setSaveError(undefined);
    const sent = content;
    save.mutate(
      {
        path: note.path,
        content: sent,
        base_version: baseVersion,
        message: `Edit ${note.path} from the web app`,
      },
      {
        onSuccess: (res) => {
          setBaseVersion(res.version);
          setSavedContent(sent);
          toast('Saved');
        },
        onError: (err) => {
          if (isApiError(err) && err.isConflict) {
            setCopyPath(conflictCopyPath(note.path));
            setConflictError(undefined);
            setConflict(true);
          } else {
            setSaveError(errorMessage(err).detail || errorMessage(err).title);
          }
        },
      },
    );
  }, [dirty, save, content, note.path, baseVersion, toast]);

  // One window-level ⌘S handler (it also fires inside CodeMirror); a ref keeps it current.
  const saveRef = useRef(doSave);
  useEffect(() => {
    saveRef.current = doSave;
  }, [doSave]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const extensions = useMemo(
    () => [
      // Setext headings are removed so YAML frontmatter (text between `---` lines) is not
      // highlighted as a giant heading.
      markdown({ base: markdownLanguage, extensions: [{ remove: ['SetextHeading'] }] }),
      markdownHighlighting,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': `Markdown source of ${note.title}` }),
      autocompletion({ override: [wikilinkCompletion(noteList)], icons: false }),
      editorTheme,
    ],
    [note.title, noteList],
  );

  const resolve = useMemo(() => {
    const fromLinks = resolverFromLinks(note.links, (p) => noteHref(p));
    return (target: string) => {
      const known = fromLinks(target);
      if (known) return known;
      const wanted = target.toLowerCase().replace(/\.md$/, '');
      const match = noteList.find(
        (n) =>
          n.path.toLowerCase().replace(/\.md$/, '') === wanted ||
          n.path.toLowerCase().split('/').pop()?.replace(/\.md$/, '') === wanted,
      );
      return match ? noteHref(match.path) : null;
    };
  }, [note.links, noteList]);

  const reloadTheirs = async () => {
    setConflictBusy(true);
    try {
      const latest = await api.getNote(note.path);
      qc.setQueryData(qk.note(note.path), latest);
      setContent(latest.raw);
      setSavedContent(latest.raw);
      setBaseVersion(latest.version);
      setConflict(false);
      toast('Loaded the latest version');
    } catch (err) {
      setConflictError(errorMessage(err).detail);
    } finally {
      setConflictBusy(false);
    }
  };

  const keepMineAsCopy = async () => {
    setConflictBusy(true);
    try {
      const res = await api.saveNote({
        path: copyPath,
        content: markAsConflictCopy(content),
        base_version: null,
        message: `Save conflict copy of ${note.path} from the web app`,
      });
      void qc.invalidateQueries({ queryKey: qk.notesAll });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
      setConflict(false);
      bypassBlock.current = true;
      toast('Your version was saved as a copy');
      await router.navigate({ href: noteHref(res.path) });
    } catch (err) {
      setConflictError(errorMessage(err).detail);
    } finally {
      setConflictBusy(false);
    }
  };

  const preview = (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[720px] px-7 pt-6 pb-24">
        <Markdown source={stripFrontmatter(content)} resolveLink={resolve} />
      </div>
    </div>
  );

  const status = save.isPending ? 'Saving…' : dirty ? 'Edited' : 'Saved';

  return (
    <>
      <PaneHeader
        backHref={backHref}
        title={note.title}
        subtitle={
          <span aria-live="polite">
            {status}
            {dirty ? ` · ${MOD_LABEL}S to save` : ''}
          </span>
        }
        actions={
          <>
            {api.dev ? (
              <Button
                variant="plain"
                size="sm"
                title="Mock mode: change this note as if another device saved it, so your next save conflicts"
                onClick={() => {
                  void api.dev
                    ?.simulateRemoteEdit(note.path)
                    .then(() => toast('Changed on “another device”'));
                }}
              >
                <FlaskConical aria-hidden className="size-3.5" strokeWidth={1.75} />
                <span className="hidden xl:inline">Simulate remote edit</span>
              </Button>
            ) : null}
            <SegmentedControl<Mode>
              label="Editor layout"
              size="sm"
              value={mode}
              onChange={setMode}
              segments={[
                { value: 'edit', label: 'Edit' },
                { value: 'split', label: 'Split' },
                { value: 'preview', label: 'Preview' },
              ]}
              className="mx-1 hidden sm:inline-flex"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void router.navigate({ href: doneHref })}
            >
              Done
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={doSave}
              disabled={!dirty || save.isPending}
            >
              Save
            </Button>
          </>
        }
      />
      {saveError ? (
        <p role="alert" className="hairline-b bg-red-tint px-4 py-2 text-[13px] text-red">
          Could not save: {saveError}
        </p>
      ) : null}
      <div className="flex justify-center px-3 py-2 sm:hidden">
        <SegmentedControl<Mode>
          label="Editor layout"
          size="sm"
          value={mode === 'split' ? 'edit' : mode}
          onChange={setMode}
          segments={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1',
            mode === 'preview' && 'hidden',
            mode === 'split' && 'hairline-r',
          )}
        >
          <CodeMirror
            value={content}
            onChange={setContent}
            extensions={extensions}
            theme="none"
            height="100%"
            className="h-full"
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              syntaxHighlighting: false,
              autocompletion: false,
            }}
            autoFocus
          />
        </div>
        {mode !== 'edit' ? <div className="min-h-0 min-w-0 flex-1 bg-canvas">{preview}</div> : null}
      </div>

      <ConflictSheet
        open={conflict}
        path={note.path}
        copyPath={copyPath}
        busy={conflictBusy}
        error={conflictError}
        onReloadTheirs={() => void reloadTheirs()}
        onKeepMineAsCopy={() => void keepMineAsCopy()}
        onCancel={() => setConflict(false)}
      />

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(o) => {
          if (!o) blocker.reset?.();
        }}
        title="Discard unsaved changes?"
        description="Your edits to this note have not been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}
