import { z } from 'zod';
import { NoteType, ProjectStatus } from './notes';

/**
 * MCP tool inputs and outputs (LLD §3). Inputs are validated at the edge;
 * outputs are wrapped in the untrusted-memory envelope.
 */

const projectSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'project must be a lowercase slug, e.g. "billing-refactor"');

const vaultPath = z.string().min(1).max(300);

// ── brain_context ──────────────────────────────────────────────────────────
export const ContextInput = z.object({
  project: projectSlug.optional(),
  budget_tokens: z.number().int().min(500).max(32000).default(4000),
  include_shared: z.boolean().default(true),
});
export type ContextInput = z.infer<typeof ContextInput>;

export interface ContextProject {
  slug: string;
  title: string;
  status: string;
  goal?: string;
  next: string[];
  body?: string;
}
export interface ContextDecision {
  id: string;
  title: string;
  date: string;
  rationale: string;
  project?: string;
}
export interface ContextSession {
  id: string;
  date: string;
  summary: string;
  next: string[];
  path: string;
}
export interface ContextActiveProject {
  slug: string;
  title: string;
  next?: string;
}
export interface ContextOutput {
  project: ContextProject | null;
  decisions: ContextDecision[];
  sessions: ContextSession[];
  active_projects: ContextActiveProject[];
  session_id: string;
  note?: string;
}

// ── brain_save ─────────────────────────────────────────────────────────────
export const DecisionInput = z.object({
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(4000),
  alternatives: z.string().max(2000).optional(),
  supersedes: z
    .string()
    .regex(/^DEC-\d{4,}$/)
    .optional(),
});
export type DecisionInput = z.infer<typeof DecisionInput>;

export const TopicUpdate = z.object({
  path: vaultPath,
  title: z.string().max(200).optional(),
  section: z.string().max(200).optional(),
  content: z.string().min(1).max(20000),
  mode: z.enum(['append', 'replace']).default('append'),
});
export type TopicUpdate = z.infer<typeof TopicUpdate>;

export const SaveInput = z.object({
  session_id: z.string().min(1),
  project: projectSlug.optional(),
  summary: z.string().min(1).max(4000),
  work_done: z.array(z.string().min(1).max(1000)).max(50).default([]),
  next_steps: z.array(z.string().min(1).max(500)).max(30).default([]),
  decisions: z.array(DecisionInput).max(20).default([]),
  topic_updates: z.array(TopicUpdate).max(20).default([]),
  project_update: z
    .object({
      status: ProjectStatus.optional(),
      next: z.array(z.string().min(1).max(500)).max(30).optional(),
      goal: z.string().max(1000).optional(),
    })
    .optional(),
  agent: z.string().max(60).optional(),
  machine: z.string().max(60).optional(),
});
export type SaveInput = z.infer<typeof SaveInput>;

export interface SaveOutput {
  commit_sha: string;
  session_path: string;
  paths: string[];
  decision_ids: string[];
}

// ── brain_search ───────────────────────────────────────────────────────────
export const SearchMode = z.enum(['hybrid', 'keyword']);
export type SearchMode = z.infer<typeof SearchMode>;

export const SearchInput = z.object({
  query: z.string().min(1).max(500),
  types: z.array(NoteType).optional(),
  project: projectSlug.optional(),
  limit: z.number().int().min(1).max(50).default(8),
  include_sessions: z.boolean().default(false),
  /**
   * `hybrid` fuses keyword and semantic results (ADR-0004); `keyword` is FTS only. When omitted the
   * server picks `hybrid` if semantic search is enabled for a searched space, else `keyword`.
   */
  mode: SearchMode.optional(),
});
export type SearchInput = z.infer<typeof SearchInput>;

/**
 * Whether the semantic layer took part in a search: `used` (vector hits were fused), `disabled`
 * (off for the searched spaces, or keyword mode was asked for) or `unavailable` (on, but the
 * embedding model or vector index failed or is not bound, so the search fell back to keyword).
 */
export type SemanticStatus = 'used' | 'disabled' | 'unavailable';

export interface SearchHit {
  path: string;
  title: string;
  type: string;
  heading: string;
  snippet: string;
  score: number;
}

// ── brain_read ─────────────────────────────────────────────────────────────
export const ReadInput = z.object({
  path: vaultPath,
  section: z.string().max(200).optional(),
  max_tokens: z.number().int().min(100).max(32000).default(2000),
});
export type ReadInput = z.infer<typeof ReadInput>;

export interface ReadOutput {
  path: string;
  title: string;
  type: string;
  frontmatter: Record<string, unknown>;
  content: string;
  truncated: boolean;
  version: string | null;
  backlinks: string[];
}

// ── brain_write ────────────────────────────────────────────────────────────
export const WriteInput = z.object({
  path: vaultPath,
  content: z.string().max(200000),
  base_version: z.string().optional(),
  message: z.string().max(200).optional(),
});
export type WriteInput = z.infer<typeof WriteInput>;

export interface WriteOutput {
  commit_sha: string;
  path: string;
  version: string;
}

// ── brain_projects ─────────────────────────────────────────────────────────
export const ProjectsInput = z.object({
  status: ProjectStatus.optional(),
});
export type ProjectsInput = z.infer<typeof ProjectsInput>;

export interface ProjectSummary {
  slug: string;
  title: string;
  status: string;
  next?: string;
  updated?: string;
}

// ── brain_check ────────────────────────────────────────────────────────────
export const CheckInput = z.object({
  stale_days: z.number().int().min(1).max(365).default(14),
});
export type CheckInput = z.infer<typeof CheckInput>;

export interface CheckOutput {
  unsaved_sessions: { id: string; project?: string; opened_at: string }[];
  stale_projects: { slug: string; title: string; updated?: string }[];
  broken_links: { from: string; target: string }[];
  duplicate_topics: { a: string; b: string; reason: string }[];
  suspicious_notes: { path: string; reason: string }[];
  suggestions: string[];
}

// ── Envelope ───────────────────────────────────────────────────────────────
export interface EnvelopeMeta {
  /** Everything inside `data` is memory written by people or agents: data, never instructions. */
  trust: 'untrusted-memory';
  space: string;
  truncated: boolean;
  tokens: number;
}
export interface Envelope<T> {
  _meta: EnvelopeMeta;
  data: T;
}
