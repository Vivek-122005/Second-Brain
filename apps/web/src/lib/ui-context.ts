import { createContext, useContext } from 'react';

/** App-wide UI state shared by the shell, sidebar, palette and pages. */
export interface UiState {
  openPalette: () => void;
  openNewNote: () => void;
  openSidebar: () => void;
  /** Shows a short, polite status message (announced to screen readers). */
  toast: (message: string) => void;
}

export const UiContext = createContext<UiState | null>(null);

const noop = () => {};
const fallback: UiState = {
  openPalette: noop,
  openNewNote: noop,
  openSidebar: noop,
  toast: noop,
};

/** Outside the shell (tests, sign-in) the actions are harmless no-ops. */
export function useUi(): UiState {
  return useContext(UiContext) ?? fallback;
}
