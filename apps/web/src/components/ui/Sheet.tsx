import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Buttons along the bottom edge. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Hide the close (×) button, e.g. when the user must pick an explicit action. */
  hideClose?: boolean;
  /** Block closing by clicking outside (Esc still works unless `dismissible` is false). */
  dismissible?: boolean;
}

const SIZES = { sm: 'max-w-[400px]', md: 'max-w-[520px]', lg: 'max-w-[680px]' };

/**
 * macOS-style sheet: a centered card over a dim scrim, Esc to close, focus trapped inside.
 * On phones it docks to the bottom edge like an iOS sheet.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  hideClose,
  dismissible = true,
}: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="animate-fade fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          onPointerDownOutside={dismissible ? undefined : (e) => e.preventDefault()}
          onEscapeKeyDown={dismissible ? undefined : (e) => e.preventDefault()}
          className={cn(
            'animate-sheet fixed z-50 flex max-h-[min(88dvh,800px)] w-full flex-col overflow-hidden bg-elevated shadow-sheet ring-1 ring-separator focus:outline-none',
            'inset-x-0 bottom-0 rounded-t-sheet sm:inset-x-auto sm:top-[10dvh] sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:rounded-sheet',
            SIZES[size],
          )}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex items-start gap-3 px-6 pt-5 pb-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[17px] font-semibold tracking-tight text-label">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-[14px] leading-snug text-label-secondary">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            {hideClose ? null : (
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="-mr-2 inline-flex size-7 items-center justify-center rounded-full bg-fill text-label-secondary hover:bg-fill-strong hover:text-label"
                >
                  <X className="size-3.5" strokeWidth={2.25} aria-hidden />
                </button>
              </Dialog.Close>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>
          {footer ? (
            <div className="hairline-t flex flex-wrap items-center justify-end gap-2 px-6 py-3.5">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  busy?: boolean;
}

/** Alert-style confirmation (role="alertdialog"); Cancel is focused first. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  busy,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="animate-fade fixed inset-0 z-40 bg-scrim" />
        <AlertDialog.Content className="animate-sheet fixed top-1/2 left-1/2 z-50 w-[calc(100%-32px)] max-w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-sheet bg-elevated p-5 text-center shadow-sheet ring-1 ring-separator focus:outline-none">
          <AlertDialog.Title className="text-[16px] font-semibold text-label">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[13px] leading-snug text-label-secondary">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? 'destructive' : 'primary'}
              disabled={busy}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
