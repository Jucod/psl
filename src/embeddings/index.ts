import { env } from '../config/env.js';
import { config } from '../config/domaine.js';
import { EmbeddingLocal } from './local.js';
import { EmbeddingDistant } from './distant.js';

export interface FournisseurEmbedding {
  readonly nom: string;
  readonly dimension: number;
  /** Deterministe et hors ligne, donc inutile a mettre en cache. */
  readonly deterministe: boolean;
  embed(textes: readonly string[]): Promise<number[][]>;
}

export function fournisseurEmbedding(): FournisseurEmbedding {
  const nom = env.providerEmbedding();
  switch (nom) {
    case 'local':
      return new EmbeddingLocal(config.dimensionEmbedding);
    case 'openai':
      return new EmbeddingDistant({
        nom: 'openai',
        url: 'https://api.openai.com/v1/embeddings',
        modele: 'text-embedding-3-small',
        cleEnv: 'OPENAI_API_KEY',
        dimension: config.dimensionEmbedding,
      });
    case 'mistral':
      return new EmbeddingDistant({
        nom: 'mistral',
        url: 'https://api.mistral.ai/v1/embeddings',
        modele: 'mistral-embed',
        cleEnv: 'MISTRAL_API_KEY',
        // mistral-embed sort en 1024. La colonne est en vector(1536): on
        // complete a droite par des zeros, ce qui preserve le cosinus.
        dimension: 1024,
      });
    default:
      throw new Error(
        `PSL_EMBEDDING_PROVIDER="${nom}" inconnu. Valeurs: local, openai, mistral.`,
      );
  }
}

/** Complete a droite par des zeros. Ne change pas le cosinus entre deux vecteurs. */
export function ajusterDimension(v: number[], cible: number): number[] {
  if (v.length === cible) return v;
  if (v.length > cible) throw new Error(`vecteur de ${v.length} dims > cible ${cible}`);
  return [...v, ...new Array(cible - v.length).fill(0)];
}
