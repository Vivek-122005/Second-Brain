/**
 * Text → vector, behind an interface so the model is swappable (ADR-0004, OD-4) and tests can use a
 * deterministic fake. The model id is recorded per note in `embeddings_meta`, so changing
 * `EMBEDDING_MODEL` makes every note stale and the catch-up job re-embeds them.
 */
export interface Embedder {
  /** Model id, recorded with every embedded note. */
  readonly model: string;
  /** One vector per input text, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
/** Dimensions of the default model; the Vectorize index must be created with the same value. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
/** Workers AI accepts up to 100 texts per call for the bge models; stay well under. */
export const EMBED_BATCH = 50;

export class EmbedderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderError';
  }
}

/** The part of the Workers AI binding we use. The model id is configurable, so it is a string. */
interface AiTextEmbeddings {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

function vectorsFrom(result: unknown, expected: number): number[][] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new EmbedderError('embedding response has the wrong shape');
  }
  const out: number[][] = [];
  for (const v of data) {
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number')) {
      throw new EmbedderError('embedding response has the wrong shape');
    }
    out.push(v as number[]);
  }
  const dims = out[0]?.length;
  if (out.some((v) => v.length !== dims)) throw new EmbedderError('mixed embedding dimensions');
  return out;
}

/** Workers AI embedder (default `@cf/baai/bge-base-en-v1.5`, 768-d). */
export function workersAiEmbedder(ai: Ai, model = DEFAULT_EMBEDDING_MODEL): Embedder {
  const binding = ai as unknown as AiTextEmbeddings;
  return {
    model,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        out.push(...vectorsFrom(await binding.run(model, { text: batch }), batch.length));
      }
      return out;
    },
  };
}
