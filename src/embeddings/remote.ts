import { config } from '../config/domain.js';
import { padDimension, type EmbeddingProvider } from './index.js';

export interface RemoteOptions {
  name: string;
  url: string;
  model: string;
  envKey: string;
  dimension: number;
}

/** OpenAI-compatible providers (OpenAI, Mistral). Wired, not tested offline. */
export class RemoteEmbedding implements EmbeddingProvider {
  readonly deterministic = false;

  constructor(private readonly opts: RemoteOptions) {}

  get name(): string { return this.opts.name; }
  get dimension(): number { return this.opts.dimension; }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const key = process.env[this.opts.envKey];
    if (!key) {
      throw new Error(
        `${this.opts.envKey} is missing. Set it, or switch back to ` +
        `PSL_EMBEDDING_PROVIDER=local.`,
      );
    }

    const response = await fetch(this.opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: this.opts.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`${this.opts.name} ${response.status}: ${await response.text()}`);
    }

    const json = (await response.json()) as { data: { embedding: number[]; index: number }[] };
    return json.data
      .sort((a, b) => a.index - b.index)
      // Stored in a vector(config.embeddingDimension) column, whatever the
      // model's native size.
      .map((d) => padDimension(d.embedding, config.embeddingDimension));
  }
}
