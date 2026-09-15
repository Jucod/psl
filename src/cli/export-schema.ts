import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { CuveeBaseSchema } from '../schema/cuvee.js';
import { FiltresLlmSchema } from '../schema/filtres.js';

/**
 * Exporte les schemas zod en JSON Schema.
 *
 * C'est le CONTRAT avec le script d'extraction PDF en Python (jalon 5): zod est
 * la source de verite unique, le JSON Schema en est la projection commitee, et
 * tests/schema-export.test.ts echoue si le fichier commite n'est plus a jour.
 *
 * Les invariants croises (une note exige sa source, un prix exige sa date) ne
 * sont pas representables en JSON Schema. Ils sont rappeles en description et
 * appliques par les contraintes CHECK de la base.
 */
const CIBLES = [
  {
    schema: CuveeBaseSchema,
    fichier: 'cuvee.schema.json',
    invariants: [
      'note_degustation non null implique note_degustation_source non null',
      'prix_ttc non null implique prix_date_releve non null',
      'les pourcentages d assemblage totalisent 0 (non renseignes) ou ~100',
    ],
  },
  {
    schema: FiltresLlmSchema,
    fichier: 'filtres.schema.json',
    invariants: [
      'prix_min <= prix_max',
      'millesime_min <= millesime_max',
    ],
  },
] as const;

export function rendre(cible: (typeof CIBLES)[number]): string {
  const json = z.toJSONSchema(cible.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  json['x-invariants'] = cible.invariants;
  return JSON.stringify(json, null, 2) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const cible of CIBLES) {
    const chemin = new URL(`../../db/schema/${cible.fichier}`, import.meta.url).pathname;
    await writeFile(chemin, rendre(cible), 'utf8');
    console.log(`schema exporte: db/schema/${cible.fichier}`);
  }
}
