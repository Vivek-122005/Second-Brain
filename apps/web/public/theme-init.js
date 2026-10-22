// Runs before the app bundle so a saved Light/Dark override applies on first paint.
// Kept as a plain external script (not inline) so a strict Content-Security-Policy stays possible.
try {
  const saved = window.localStorage.getItem('sb.theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // Storage can be unavailable (private mode, blocked cookies); fall back to the system scheme.
}
