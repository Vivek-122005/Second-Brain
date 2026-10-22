import { useEffect, useRef } from 'react';

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

/** Human label for the platform modifier: ⌘ on Apple devices, Ctrl elsewhere. */
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl+';

export interface HotkeySpec {
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  /** Requires ⌘ on macOS / Ctrl elsewhere. */
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Fire even when focus is inside an input or editor (default true for mod combos). */
  inInputs?: boolean;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export function matchesHotkey(e: KeyboardEvent, spec: HotkeySpec): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (Boolean(spec.mod) !== mod) return false;
  if (Boolean(spec.alt) !== e.altKey) return false;
  if (spec.shift !== undefined && spec.shift !== e.shiftKey) return false;
  if (e.key.toLowerCase() === spec.key.toLowerCase()) return true;
  // With ⌥ held, macOS changes `key` (⌥N types "˜"), so fall back to the physical key.
  return /^[a-z]$/i.test(spec.key) && e.code === `Key${spec.key.toUpperCase()}`;
}

/** Registers global keyboard shortcuts. The handler always sees the latest props. */
export function useHotkeys(bindings: [HotkeySpec, (e: KeyboardEvent) => void][]): void {
  const ref = useRef(bindings);
  useEffect(() => {
    ref.current = bindings;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const [spec, handler] of ref.current) {
        if (!matchesHotkey(e, spec)) continue;
        const allowInInputs = spec.inInputs ?? Boolean(spec.mod);
        if (!allowInInputs && isEditable(e.target)) continue;
        e.preventDefault();
        handler(e);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
