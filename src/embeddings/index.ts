import { env } from '../config/env.js';
import { config } from '../config/domain.js';
import { LocalEmbedding } from './local.js';
import { RemoteEmbedding } from './remote.js';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  /** Deterministic and offline, hence pointless to cache. */
  readonly deterministic: boolean;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export function embeddingProvider(): EmbeddingProvider {
  const name = env.embeddingProvider();
  switch (name) {
    case 'local':
      return new LocalEmbedding(config.embeddingDimension);
    case 'openai':
      return new RemoteEmbedding({
        name: 'openai',
        url: 'https://api.openai.com/v1/embeddings',
        model: 'text-embedding-3-small',
        envKey: 'OPENAI_API_KEY',
        dimension: config.embeddingDimension,
      });
    case 'mistral':
      return new RemoteEmbedding({
        name: 'mistral',
        url: 'https://api.mistral.ai/v1/embeddings',
        model: 'mistral-embed',
        envKey: 'MISTRAL_API_KEY',
        // mistral-embed outputs 1024 dimensions. The column is vector(1536):
        // we pad with zeros on the right, which preserves the cosine.
        dimension: 1024,
      });
    default:
      throw new Error(
        `Unknown PSL_EMBEDDING_PROVIDER="${name}". Values: local, openai, mistral.`,
      );
  }
}

/** Pads with zeros on the right. Does not change the cosine between two vectors. */
export function padDimension(v: number[], target: number): number[] {
  if (v.length === target) return v;
  if (v.length > target) throw new Error(`vector of ${v.length} dims > target ${target}`);
  return [...v, ...new Array(target - v.length).fill(0)];
}
