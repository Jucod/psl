import { z } from 'zod';
import { CouleurSchema, DateISOSchema, IdSchema, UrlSchema } from './commun.js';
import { SourceSchema } from './source.js';

/**
 * Forme cible d'une ligne produit.
 *
 * SOURCE DE VERITE du projet. Exportee en JSON Schema
 * (db/schema/cuvee.schema.json) par `npm run schema:export`, et c'est ce
 * JSON Schema que le script d'extraction PDF en Python valide au jalon 5.
 * Modifier ce fichier sans reexporter fait echouer tests/schema-export.test.ts.
 */

export const AssemblageSchema = z
  .strictObject({
    cepage: z.string().min(2).max(60),
    pct: z.number().positive().max(100).nullable(),
  });

/** Forme plate, sans invariants croises: c'est elle qui s'exporte en JSON Schema. */
export const CuveeBaseSchema = z
  .strictObject({
    id: IdSchema,
    domaine_id: IdSchema,
    appellation_id: IdSchema,
    nom_cuvee: z.string().min(1).max(200),
    couleur: CouleurSchema,
    millesime: z.number().int().min(1900).max(2100).nullable(),
    assemblage: z.array(AssemblageSchema).max(12).default([]),
    degre: z.number().min(0).max(20).nullable(),
    elevage: z.string().max(500).nullable(),
    prix_ttc: z.number().min(0).max(10000).nullable(),
    prix_date_releve: DateISOSchema.nullable(),
    bio: z.boolean().nullable(),
    certification: z.string().max(60).nullable(),

    /**
     * Note de degustation. Vient EXCLUSIVEMENT de la fiche technique du
     * producteur, recopiee telle quelle. Jamais generee, jamais reformulee.
     * Si elle est absente, elle reste null et le systeme repond depuis le
     * profil d'appellation en l'annonçant.
     */
    note_degustation: z.string().max(4000).nullable(),
    note_degustation_source: SourceSchema.nullable(),

    accords_producteur: z.array(z.string().max(120)).max(20).default([]),
    fiche_url: UrlSchema.nullable(),
  });

/**
 * Schema faisant foi. Les trois invariants croises ci-dessous ne sont pas
 * exprimables en JSON Schema; ils sont dupliques en contraintes CHECK dans
 * db/migrations/004_domaines_cuvees.sql, qui reste le dernier rempart.
 */
export const CuveeSchema = CuveeBaseSchema
  // Meme invariant que la contrainte `note_exige_source` en base. Verifie
  // ici pour echouer a l'ingestion plutot qu'a l'INSERT.
  .refine((c) => c.note_degustation === null || c.note_degustation_source !== null, {
    message: 'une note de degustation exige sa source',
    path: ['note_degustation_source'],
  })
  .refine((c) => c.prix_ttc === null || c.prix_date_releve !== null, {
    message: 'un prix exige sa date de releve',
    path: ['prix_date_releve'],
  })
  .refine(
    (c) => {
      const total = c.assemblage.reduce((s, a) => s + (a.pct ?? 0), 0);
      // Tolerance: soit aucun pourcentage renseigne, soit un total plausible.
      return total === 0 || (total > 95 && total <= 100.5);
    },
    { message: 'les pourcentages d assemblage doivent totaliser ~100', path: ['assemblage'] },
  );

export type Cuvee = z.infer<typeof CuveeSchema>;
