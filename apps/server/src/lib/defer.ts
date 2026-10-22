import { AsyncLocalStorage } from 'node:async_hooks';
import { waitUntil } from 'cloudflare:workers';

/**
 * Background work that must outlive the response (e.g. embedding after a save). The request's
 * ExecutionContext is kept in async-local storage by a middleware, so deep service code can defer
 * work without threading `ctx` through every signature.
 */
const current = new AsyncLocalStorage<ExecutionContext>();

export function withExecutionContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return current.run(ctx, fn);
}

/** Runs `task` after the response. Failures are the task's own business: it must log them. */
export function defer(task: Promise<unknown>): void {
  const safe = task.catch(() => undefined);
  const ctx = current.getStore();
  if (ctx) ctx.waitUntil(safe);
  else waitUntil(safe);
}
