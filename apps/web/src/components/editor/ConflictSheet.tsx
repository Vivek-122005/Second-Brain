import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';

interface ConflictSheetProps {
  open: boolean;
  path: string;
  copyPath: string;
  busy: boolean;
  error?: string | undefined;
  onReloadTheirs: () => void;
  onKeepMineAsCopy: () => void;
  onCancel: () => void;
}

/**
 * Shown when a save returns 409: someone (another device, an agent) changed the note after it
 * was opened. Nothing is overwritten silently; the user picks which version wins.
 */
export function ConflictSheet({
  open,
  path,
  copyPath,
  busy,
  error,
  onReloadTheirs,
  onKeepMineAsCopy,
  onCancel,
}: ConflictSheetProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title="This note changed while you were editing"
      description={
        <>
          A newer version of <code className="font-mono text-[13px] text-label">{path}</code> was
          saved from somewhere else, so your changes were not saved.
        </>
      }
      size="sm"
      dismissible={!busy}
    >
      <div className="space-y-3">
        <div className="flex gap-3 rounded-card bg-orange-tint p-3 text-[13px] leading-snug text-label">
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-orange"
            strokeWidth={2}
          />
          <span>
            Choose which version to keep. Your text is still in the editor until you decide.
          </span>
        </div>
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          onClick={onKeepMineAsCopy}
          disabled={busy}
        >
          Keep mine as a copy
        </Button>
        <p className="-mt-1 px-1 text-[12px] text-label-secondary">
          Saves your version as <code className="font-mono">{copyPath}</code> and leaves theirs
          untouched.
        </p>
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={onReloadTheirs}
          disabled={busy}
        >
          Reload theirs
        </Button>
        <p className="-mt-1 px-1 text-[12px] text-label-secondary">
          Discards your unsaved changes and loads the latest version.
        </p>
        {error ? (
          <p role="alert" className="text-[13px] text-red">
            {error}
          </p>
        ) : null}
        <Button variant="plain" className="w-full" onClick={onCancel} disabled={busy}>
          Keep editing
        </Button>
      </div>
    </Sheet>
  );
}
