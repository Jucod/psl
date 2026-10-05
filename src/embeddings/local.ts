import { FAMILY_BY_STEM, tokenize } from '../config/lexicon.js';
import type { EmbeddingProvider } from './index.js';

/**
 * Deterministic, offline embedding provider that needs no API key.
 *
 * It is not a model: it is a bag of words projected by signed hashing (the
 * "hashing trick"), enriched with the descriptor families declared in
 * src/config/lexicon.ts. The lexicon does the job a pre-trained model would
 * otherwise do: bringing "souple" close to "fondu" and "soyeux".
 *
 * Why it is enough here: the corpus is a few hundred tasting notes, with a
 * narrow and highly codified vocabulary. On that ground a synonym-aware bag of
 * words behaves honorably, it is instantaneous, it costs nothing and it is
 * reproducible to the bit, which makes ranking tests deterministic.
 *
 * Its limits, to be aware of: no understanding of negation ("pas tannique" and
 * "tannique" share the same dimension), no notion of order, no generalization
 * outside the lexicon. Switch to a real model (PSL_EMBEDDING_PROVIDER=openai)
 * as soon as the corpus outgrows the lexicon.
 * Negation is handled upstream, by the filter parser, which turns it into an
 * explicit constraint rather than a vector signal.
 */
export class LocalEmbedding implements EmbeddingProvider {
  readonly name = 'local';
  readonly deterministic = true;

  /** A family token weighs more than its surface form: synonymy comes first. */
  private static readonly SURFACE_WEIGHT = 1.0;
  private static readonly FAMILY_WEIGHT = 1.6;

  constructor(readonly dimension: number) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  vector(text: string): number[] {
    const v = new Array<number>(this.dimension).fill(0);
    const tokens = tokenize(text);

    for (const token of tokens) {
      this.add(v, token, LocalEmbedding.SURFACE_WEIGHT);
      const family = FAMILY_BY_STEM.get(token);
      if (family) this.add(v, `family:${family}`, LocalEmbedding.FAMILY_WEIGHT);
    }

    let sum = 0;
    for (const x of v) sum += x * x;
    const norm = Math.sqrt(sum);
    if (norm === 0) return v;
    return v.map((x) => x / norm);
  }

  private add(v: number[], token: string, weight: number): void {
    const h = fnv1a(token);
    const index = h % this.dimension;
    // Second hash for the sign: limits constructive collisions.
    const sign = fnv1a(`${token}#sign`) % 2 === 0 ? 1 : -1;
    v[index] = (v[index] ?? 0) + sign * weight;
  }
}

/** 32-bit FNV-1a. Stable across Node versions, unlike a native hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
