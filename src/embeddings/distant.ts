import { ajusterDimension, type FournisseurEmbedding } from './index.js';

export interface OptionsDistant {
  nom: string;
  url: string;
  modele: string;
  cleEnv: string;
  dimension: number;
}

/** Providers compatibles OpenAI (OpenAI, Mistral). Cables, non testes hors ligne. */
export class EmbeddingDistant implements FournisseurEmbedding {
  readonly deterministe = false;

  constructor(private readonly opts: OptionsDistant) {}

  get nom(): string { return this.opts.nom; }
  get dimension(): number { return this.opts.dimension; }

  async embed(textes: readonly string[]): Promise<number[][]> {
    const cle = process.env[this.opts.cleEnv];
    if (!cle) {
      throw new Error(
        `${this.opts.cleEnv} absente. Renseigne-la, ou repasse en ` +
        `PSL_EMBEDDING_PROVIDER=local.`,
      );
    }

    const reponse = await fetch(this.opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cle}` },
      body: JSON.stringify({ model: this.opts.modele, input: textes }),
    });

    if (!reponse.ok) {
      throw new Error(`${this.opts.nom} ${reponse.status}: ${await reponse.text()}`);
    }

    const json = (await reponse.json()) as { data: { embedding: number[]; index: number }[] };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => ajusterDimension(d.embedding, 1536));
  }
}
