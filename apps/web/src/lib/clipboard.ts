import { useCallback, useEffect, useRef, useState } from 'react';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** `copied` flips to true for a moment after a successful copy. */
export function useCopy(resetMs = 1600): {
  copied: boolean;
  failed: boolean;
  copy: (text: string) => void;
} {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    (text: string) => {
      void copyText(text).then((ok) => {
        setState(ok ? 'copied' : 'failed');
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), resetMs);
      });
    },
    [resetMs],
  );
  return { copied: state === 'copied', failed: state === 'failed', copy };
}
