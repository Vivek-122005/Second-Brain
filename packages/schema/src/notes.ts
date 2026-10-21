import { z } from 'zod';

/** The kinds of note a vault holds (FR-VLT-01). */
export const NoteType = z.enum(['project', 'decision-log', 'topic', 'session', 'note']);
export type NoteType = z.infer<typeof NoteType>;

export const ProjectStatus = z.enum(['active', 'paused', 'done', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

const stringList = z.array(z.string().min(1)).default([]);

/** YAML dates come back as Date objects; normalise them to ISO strings. */
const dateish = z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.string().min(1));

export const ProjectFrontmatter = z.looseObject({
  type: z.literal('project'),
  id: z.string().optional(),
  title: z.string().min(1),
  status: ProjectStatus.default('active'),
  goal: z.string().optional(),
  next: stringList,
  tags: stringList,
  updated: dateish.optional(),
});
export type ProjectFrontmatter = z.infer<typeof ProjectFrontmatter>;

export const SessionFrontmatter = z.looseObject({
  type: z.literal('session'),
  id: z.string().min(1),
  project: z.string().optional(),
  agent: z.string().optional(),
  machine: z.string().optional(),
  started: dateish.optional(),
  saved: dateish.optional(),
  summary: z.string().default(''),
  next: stringList,
});
export type SessionFrontmatter = z.infer<typeof SessionFrontmatter>;

export const TopicFrontmatter = z.looseObject({
  type: z.literal('topic'),
  id: z.string().optional(),
  title: z.string().min(1),
  aliases: stringList,
  tags: stringList,
});
export type TopicFrontmatter = z.infer<typeof TopicFrontmatter>;

export const DecisionLogFrontmatter = z.looseObject({
  type: z.literal('decision-log'),
  project: z.string().optional(),
  title: z.string().optional(),
});
export type DecisionLogFrontmatter = z.infer<typeof DecisionLogFrontmatter>;

export const GenericFrontmatter = z.looseObject({
  type: z.literal('note').default('note'),
  title: z.string().optional(),
  tags: stringList,
});
export type GenericFrontmatter = z.infer<typeof GenericFrontmatter>;

export const DecisionStatus = z.enum(['active', 'superseded']);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/** One entry in a decision log (FR-SES-04). */
export const Decision = z.object({
  id: z.string().regex(/^DEC-\d{4,}$/),
  title: z.string().min(1),
  date: z.string().min(1),
  status: DecisionStatus.default('active'),
  rationale: z.string().default(''),
  alternatives: z.string().optional(),
  supersedes: z.string().optional(),
  supersededBy: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;
