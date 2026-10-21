import { useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { useSaveNote } from '../api/queries';
import { todayIso } from '../lib/format';
import { newNoteTemplate, noteHref, slugify, type NewNoteFolder } from '../lib/notes';
import { useUi } from '../lib/ui-context';
import { Button } from './ui/Button';
import { errorMessage } from '../lib/errors';
import { TextField } from './ui/Field';
import { SegmentedControl } from './ui/SegmentedControl';
import { Sheet } from './ui/Sheet';

const FOLDERS: { value: NewNoteFolder; label: string }[] = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'topics', label: 'Topic' },
  { value: 'projects', label: 'Project' },
];

/** ⌘N: pick a folder, give it a title, and land in the editor. */
export function NewNoteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const save = useSaveNote();
  const { toast } = useUi();
  const [folder, setFolder] = useState<NewNoteFolder>('inbox');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | undefined>();

  const path = `${folder}/${slugify(title || 'untitled')}.md`;

  const reset = () => {
    setTitle('');
    setError(undefined);
    save.reset();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) {
      setError('Give the note a title.');
      return;
    }
    save.mutate(
      {
        path,
        content: newNoteTemplate(folder, t, todayIso()),
        base_version: null,
        message: `Create ${path} from the web app`,
      },
      {
        onSuccess: (res) => {
          onOpenChange(false);
          reset();
          toast('Note created');
          void router.navigate({ href: noteHref(res.path, { edit: true }) });
        },
        onError: (err) => {
          setError(
            isApiError(err) && err.isConflict
              ? `A note named “${t}” already exists in ${folder}/. Pick another title.`
              : errorMessage(err).detail,
          );
        },
      },
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      title="New note"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-note-form" disabled={save.isPending}>
            {save.isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id="new-note-form" onSubmit={onSubmit} className="space-y-5 pt-1">
        <div className="space-y-1.5">
          <span id="new-note-folder" className="block text-[13px] font-medium text-label">
            Folder
          </span>
          <SegmentedControl
            label="Folder"
            segments={FOLDERS}
            value={folder}
            onChange={setFolder}
            className="w-full"
          />
        </div>
        <TextField
          label="Title"
          value={title}
          autoFocus
          onChange={(e) => {
            setTitle(e.target.value);
            setError(undefined);
          }}
          placeholder="e.g. Rate limiting"
          error={error}
          hint={
            <>
              Saved as <code className="font-mono text-[12px] text-label">{path}</code>
            </>
          }
        />
      </form>
    </Sheet>
  );
}
