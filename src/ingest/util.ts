import { normalize } from '../config/lexicon.js';

/** "Chateau de Lancyre" -> "chateau-de-lancyre" */
export function slug(text: string): string {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Normalizes a grape variety name to its code.
 * "Syrah N", "shiraz", "SYRAH" -> "syrah". Returns null when unknown, so that
 * ingestion fails loudly rather than silently losing a filter.
 */
export function grapeCode(
  name: string,
  index: ReadonlyMap<string, string>,
): string | null {
  return index.get(normalize(name).trim()) ?? null;
}

export function buildGrapeIndex(
  grapes: readonly { code: string; label: string; synonyms: string[] }[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const g of grapes) {
    index.set(normalize(g.code), g.code);
    index.set(normalize(g.label), g.code);
    for (const s of g.synonyms) index.set(normalize(s), g.code);
  }
  return index;
}
