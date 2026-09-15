import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { FournisseurEmbedding } from './index.js';

const CHEMIN = new URL('../../db/seed/embeddings.cache.json', import.meta.url).pathname;

type Cache = Record<string, number[]>;

function cle(provider: string, dimension: number, texte: string): string {
  return createHash('sha256').update(`${provider}:${dimension}:${texte}`).digest('hex');
}

async function lire(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CHEMIN, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/**
 * Embedde en passant par un cache commite, pour que `npm run setup` soit
 * reproductible et executable en CI sans cle API.
 *
 * Le provider local n'est PAS mis en cache: il est deterministe et instantane,
 * et un cache le rendrait insensible a une evolution du lexique, ce qui est
 * exactement le piege (on corrigerait le lexique sans que le classement bouge).
 */
export async function embedAvecCache(
  fournisseur: FournisseurEmbedding,
  textes: readonly string[],
): Promise<number[][]> {
  if (fournisseur.deterministe) return fournisseur.embed(textes);

  const cache = await lire();
  const manquants: string[] = [];
  for (const t of textes) {
    if (!(cle(fournisseur.nom, fournisseur.dimension, t) in cache)) manquants.push(t);
  }

  if (manquants.length > 0) {
    const frais = await fournisseur.embed(manquants);
    manquants.forEach((t, i) => {
      cache[cle(fournisseur.nom, fournisseur.dimension, t)] = frais[i]!;
    });
    await writeFile(CHEMIN, JSON.stringify(cache, null, 0) + '\n', 'utf8');
  }

  const relu = await lire();
  return textes.map((t) => relu[cle(fournisseur.nom, fournisseur.dimension, t)]!);
}
