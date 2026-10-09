import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildGrapeIndex, slug } from '../ingest/util.js';
import type { Wine } from '../schema/wine.js';
import type { Producer } from './extract.js';
import type { Designation, GrapeRules } from './review.js';

export const SEED_DIR = fileURLToPath(new URL('../../db/seed/', import.meta.url));
export const WINES_DIR = join(SEED_DIR, 'wines');

/** What the collector and the promotion step need from the reference data. */
export async function loadCatalog() {
  const seed = JSON.parse(await readFile(join(SEED_DIR, 'pic-saint-loup-seed.json'), 'utf8'));
  const grapes = JSON.parse(await readFile(join(SEED_DIR, 'grapes.json'), 'utf8'));

  const entries: { name: string; website?: string | null }[] = [
    ...(seed.producers?.estates ?? []),
    ...(seed.producers?.cooperatives ?? []),
  ];
  const producers: Producer[] = [];
  for (const p of entries) {
    if (!p.website || p.website === 'TODO') continue;
    // The directory lists some producers twice.
    if (producers.some((q) => q.id === slug(p.name))) continue;
    producers.push({ id: slug(p.name), name: p.name, website: p.website });
  }

  const existing: Wine[] = [];
  for (const f of (await readdir(WINES_DIR)).filter((f) => f.endsWith('.json')).sort()) {
    existing.push(JSON.parse(await readFile(join(WINES_DIR, f), 'utf8')));
  }

  return {
    producers,
    producerIds: new Set(entries.map((p) => slug(p.name))),
    grapeIndex: buildGrapeIndex(grapes.grapes),
    designations: designationsOf(seed),
    existing,
  };
}

/**
 * The designations of the seed, with their colors and grape rules. The rules
 * are empty for the designations whose specification is not transcribed:
 * promotion then checks the color, not the blend.
 */
export function designationsOf(seed: {
  appellations: { id: string; permitted_colors: string[]; grape_rules?: GrapeRules }[];
}): Map<string, Designation> {
  return new Map(seed.appellations.map((a) => [a.id, { colors: a.permitted_colors, rules: a.grape_rules ?? {} }]));
}
