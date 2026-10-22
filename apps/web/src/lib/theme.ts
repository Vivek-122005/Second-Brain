import { useCallback, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'sb.theme';
const EVENT = 'sb-theme-change';

export function readThemePreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: pref }));
}

let current: ThemePreference | null = null;

function subscribe(onChange: () => void): () => void {
  const handler = (e: Event) => {
    current = (e as CustomEvent<ThemePreference>).detail;
    onChange();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

function getSnapshot(): ThemePreference {
  current ??= readThemePreference();
  return current;
}

export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, getSnapshot, () => 'system' as const);
  const set = useCallback((p: ThemePreference) => setThemePreference(p), []);
  return [pref, set];
}

/** The scheme actually in effect (resolves "system"). */
export function resolvedScheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
