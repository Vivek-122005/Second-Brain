import { isApiError } from '../api/client';

/** A short title and a sentence for showing any thrown value to a person. */
export function errorMessage(err: unknown): { title: string; detail: string } {
  if (isApiError(err)) {
    return { title: err.title, detail: err.detail ?? `The server answered ${err.status}.` };
  }
  return { title: 'Something went wrong', detail: err instanceof Error ? err.message : '' };
}
