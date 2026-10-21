/** Only same-app relative paths are allowed as a post-sign-in destination (no open redirect). */
export function safeRedirect(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}
