import * as Dialog from '@radix-ui/react-dialog';
import { Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { useMe } from '../../api/queries';
import { useHotkeys } from '../../lib/hotkeys';
import { UiContext, type UiState } from '../../lib/ui-context';
import { CommandPalette } from '../CommandPalette';
import { NewNoteDialog } from '../NewNoteDialog';
import { ErrorState, LoadingPane } from '../ui/Feedback';
import { SIDEBAR_SEARCH_ID, Sidebar } from './Sidebar';

/** Element id a page can give its own search field so ⌘/ focuses it instead of the sidebar's. */
export const PAGE_SEARCH_ID = 'page-search';

export function AppShell() {
  const me = useMe();
  const location = useRouterState({ select: (s) => s.location });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ id: number; text: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((text: string) => {
    setToastMessage({ id: Date.now(), text });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), 2400);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const ui = useMemo<UiState>(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openNewNote: () => setNewNoteOpen(true),
      openSidebar: () => setSidebarOpen(true),
      toast,
    }),
    [toast],
  );

  useHotkeys([
    [{ key: 'k', mod: true }, () => setPaletteOpen((o) => !o)],
    // Browsers reserve ⌘N in a normal tab; ⌥⌘N always works (⌘N works in installed/PWA windows).
    [{ key: 'n', mod: true }, () => setNewNoteOpen(true)],
    [{ key: 'n', mod: true, alt: true }, () => setNewNoteOpen(true)],
    [
      { key: '/', mod: true },
      () => {
        const target =
          document.getElementById(PAGE_SEARCH_ID) ?? document.getElementById(SIDEBAR_SEARCH_ID);
        if (target && target.offsetParent !== null) {
          target.focus();
        } else {
          setPaletteOpen(true);
        }
      },
    ],
  ]);

  if (me.isPending) {
    return (
      <div className="flex h-dvh">
        <LoadingPane label="Loading your brain" />
      </div>
    );
  }
  if (me.isError) {
    if (isApiError(me.error) && me.error.isUnauthorized) {
      const redirect = `${location.pathname}${location.searchStr}`;
      return <Navigate to="/sign-in" search={{ redirect }} replace />;
    }
    return (
      <div className="flex h-dvh">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }

  return (
    <UiContext.Provider value={ui}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-elevated focus:px-3 focus:py-2 focus:shadow-card"
      >
        Skip to content
      </a>
      <div className="flex h-dvh overflow-hidden bg-canvas">
        <aside className="material hairline-r hidden w-[244px] shrink-0 lg:block">
          <Sidebar />
        </aside>

        <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="animate-fade fixed inset-0 z-40 bg-scrim lg:hidden" />
            <Dialog.Content
              aria-describedby={undefined}
              // Focus the panel itself rather than its first button (which would pop a tooltip).
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement | null)?.focus();
              }}
              className="material animate-drawer fixed inset-y-0 left-0 z-50 w-[min(300px,86vw)] shadow-sheet focus:outline-none lg:hidden"
            >
              <Dialog.Title className="sr-only">Sidebar</Dialog.Title>
              <Sidebar onNavigate={() => setSidebarOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <main id="main" className="flex min-w-0 flex-1" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNewNote={() => setNewNoteOpen(true)}
      />
      <NewNoteDialog open={newNoteOpen} onOpenChange={setNewNoteOpen} />

      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center"
      >
        {toastMessage ? (
          <span
            key={toastMessage.id}
            className="animate-sheet rounded-full bg-elevated px-4 py-2 text-[14px] font-medium text-label shadow-sheet ring-1 ring-separator"
          >
            {toastMessage.text}
          </span>
        ) : null}
      </div>
    </UiContext.Provider>
  );
}
