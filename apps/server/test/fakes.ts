import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/env';
import { env } from './helpers';

/**
 * Deterministic stand-ins for Workers AI and Vectorize, so the semantic layer runs end to end in
 * workerd without a Cloudflare account.
 *
 * The fake embedding is a "concept" bag of words: words in CONCEPTS map to a shared concept (so
 * paraphrases like "login" and "authentication" land on the same axis), every other word adds a
 * small hashed component. Cosine similarity then behaves like a crude semantic model: high for
 * shared concepts, low otherwise.
 */
const CONCEPTS: Record<string, string> = {
  auth: 'auth',
  authentication: 'auth',
  login: 'auth',
  signin: 'auth',
  sign: 'auth',
  passkey: 'auth',
  passkeys: 'auth',
  password: 'auth',
  credentials: 'auth',
  deploy: 'deploy',
  deployment: 'deploy',
  ship: 'deploy',
  release: 'deploy',
  rollout: 'deploy',
  staging: 'deploy',
  production: 'deploy',
  search: 'search',
  find: 'search',
  lookup: 'search',
  retrieval: 'search',
  ranking: 'search',
  bm25: 'search',
  embeddings: 'semantic',
  semantic: 'semantic',
  meaning: 'semantic',
  vectors: 'semantic',
  paraphrase: 'semantic',
  paraphrases: 'semantic',
  garden: 'garden',
  plant: 'garden',
  planting: 'garden',
  frost: 'garden',
  seeds: 'garden',
  vegetables: 'garden',
  cost: 'money',
  price: 'money',
  billing: 'money',
  invoice: 'money',
  invoices: 'money',
  spend: 'money',
  cheap: 'money',
  budget: 'money',
  sleep: 'health',
  rest: 'health',
  tired: 'health',
  fatigue: 'health',
  memory: 'memory',
  remember: 'memory',
  recall: 'memory',
  forget: 'memory',
  context: 'memory',
  storage: 'store',
  database: 'store',
  sqlite: 'store',
  d1: 'store',
  persist: 'store',
};

export const FAKE_DIMS = 64;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function conceptEmbedding(text: string, dims = FAKE_DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const concept = CONCEPTS[word];
    if (concept) v[hash(`c:${concept}`) % dims]! += 1;
    else v[hash(`w:${word}`) % dims]! += 0.08;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class FakeAi {
  calls = 0;
  texts: string[] = [];
  models: string[] = [];
  constructor(public fail = false) {}
  async run(model: string, input: { text: string[] }) {
    this.calls += 1;
    if (this.fail) throw new Error('AI is down');
    this.models.push(model);
    this.texts.push(...input.text);
    const data = input.text.map((t) => conceptEmbedding(t));
    return { shape: [data.length, FAKE_DIMS], data };
  }
  reset() {
    this.calls = 0;
    this.texts = [];
    this.models = [];
  }
}

type Meta = Record<string, string | number | boolean>;
type Filter = Record<string, unknown>;

function matches(meta: Meta, filter: Filter | undefined): boolean {
  if (!filter) return true;
  for (const [field, cond] of Object.entries(filter)) {
    const value = meta[field];
    if (cond === null || typeof cond !== 'object') {
      if (value !== cond) return false;
      continue;
    }
    const c = cond as Record<string, unknown>;
    if ('$eq' in c && value !== c.$eq) return false;
    if ('$ne' in c && value === c.$ne) return false;
    if ('$in' in c && !(c.$in as unknown[]).includes(value)) return false;
    if ('$nin' in c && (c.$nin as unknown[]).includes(value)) return false;
  }
  return true;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** In-memory Vectorize with cosine scoring and `$eq/$ne/$in/$nin` metadata filters. */
export class FakeVectorize {
  vectors = new Map<string, { values: number[]; metadata: Meta }>();
  filters: (Filter | undefined)[] = [];
  upserts = 0;
  deleted: string[] = [];
  /** When true, ignores filters: models a misconfigured index to prove D1 re-checks hits. */
  constructor(public opts: { fail?: boolean; ignoreFilters?: boolean } = {}) {}
  async upsert(vs: { id: string; values: number[]; metadata?: Meta }[]) {
    if (this.opts.fail) throw new Error('Vectorize is down');
    this.upserts += vs.length;
    for (const v of vs) this.vectors.set(v.id, { values: v.values, metadata: v.metadata ?? {} });
    return { mutationId: crypto.randomUUID() };
  }
  async query(values: number[], o: { topK?: number; filter?: Filter } = {}) {
    if (this.opts.fail) throw new Error('Vectorize is down');
    this.filters.push(o.filter);
    const filter = this.opts.ignoreFilters ? undefined : o.filter;
    const all = [...this.vectors]
      .filter(([, v]) => matches(v.metadata, filter))
      .map(([id, v]) => ({ id, score: cosine(values, v.values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, o.topK ?? 5);
    return { matches: all, count: all.length };
  }
  async deleteByIds(ids: string[]) {
    if (this.opts.fail) throw new Error('Vectorize is down');
    for (const id of ids) {
      this.vectors.delete(id);
      this.deleted.push(id);
    }
    return { mutationId: crypto.randomUUID() };
  }
  idsFor(noteId: string): string[] {
    return [...this.vectors.keys()].filter((id) => id.startsWith(`${noteId}:`)).sort();
  }
}

export function semanticEnv(
  ai: FakeAi | null,
  vec: FakeVectorize | null,
  extra: Partial<Env> = {},
) {
  const e: Env = { ...env, ...extra };
  if (ai) e.AI = ai as unknown as Ai;
  else delete e.AI;
  if (vec) e.VECTORIZE = vec as unknown as Vectorize;
  else delete e.VECTORIZE;
  return e;
}

/** Like `call`, but against a custom env (fake bindings); waits for deferred work to finish. */
export async function callWith(e: Env, input: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://app.test${input}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
