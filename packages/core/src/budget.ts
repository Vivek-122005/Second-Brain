import type { ContextOutput } from '@second-brain/schema';
import { estimateTokens } from './tokens';

export interface BudgetResult {
  data: ContextOutput;
  truncated: boolean;
  tokens: number;
}

const TRIM_NOTE = 'Trimmed to fit the token budget. Use brain_read or brain_search for the rest.';

function measure(data: ContextOutput): number {
  return estimateTokens(JSON.stringify(data));
}

/**
 * Fits session-start context into a token budget (FR-SES-02, LLD §4.3).
 *
 * Inputs are expected newest-first. Drop order when over budget: oldest session, then oldest
 * decision (always keeping one of each while possible), then the tail of the project body,
 * then the remaining sessions/decisions, then active projects. The project header (title,
 * status, goal, next) and the session id are never dropped.
 */
export function budgetContext(input: ContextOutput, budgetTokens: number): BudgetResult {
  const data: ContextOutput = {
    ...input,
    project: input.project ? { ...input.project, next: [...input.project.next] } : null,
    decisions: [...input.decisions],
    sessions: [...input.sessions],
    active_projects: [...input.active_projects],
  };

  const originalNote = input.note;
  let truncated = false;
  let tokens = measure(data);
  let guard = 10_000;

  while (tokens > budgetTokens && guard-- > 0) {
    truncated = true;
    data.note = originalNote ? `${originalNote} ${TRIM_NOTE}` : TRIM_NOTE;
    if (data.sessions.length > 1) data.sessions.pop();
    else if (data.decisions.length > 1) data.decisions.pop();
    else if (data.project?.body) {
      const body = data.project.body;
      const keep = Math.floor(body.length / 2);
      data.project.body = keep < 200 ? undefined : `${body.slice(0, keep).trimEnd()}\n…`;
    } else if (data.sessions.length) data.sessions.pop();
    else if (data.decisions.length) data.decisions.pop();
    else if (data.active_projects.length) data.active_projects.pop();
    else break;
    tokens = measure(data);
  }

  if (!truncated) {
    if (originalNote === undefined) delete data.note;
    else data.note = originalNote;
  }
  return { data, truncated, tokens };
}
