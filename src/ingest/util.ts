import { normaliser } from '../config/lexique.js';

/** "Chateau de Lancyre" -> "chateau-de-lancyre" */
export function slug(texte: string): string {
  return normaliser(texte)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Normalise une denomination de cepage vers son code.
 * "Syrah N", "shiraz", "SYRAH" -> "syrah". Retourne null si inconnu, pour que
 * l'ingestion echoue bruyamment plutot que de perdre un filtre en silence.
 */
export function codeCepage(
  denomination: string,
  index: ReadonlyMap<string, string>,
): string | null {
  return index.get(normaliser(denomination).trim()) ?? null;
}

export function construireIndexCepages(
  cepages: readonly { code: string; libelle: string; synonymes: string[] }[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of cepages) {
    index.set(normaliser(c.code), c.code);
    index.set(normaliser(c.libelle), c.code);
    for (const s of c.synonymes) index.set(normaliser(s), c.code);
  }
  return index;
}
