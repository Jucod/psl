import { z } from 'zod';
import { CouleurSchema } from './commun.js';
import { PLATS } from '../config/lexique.js';

/**
 * Sortie de l'appel LLM 1: la demande en langage naturel traduite en filtres
 * explicites. Schema STRICT: toute cle inconnue fait echouer la validation, ce
 * qui declenche une relance unique puis le mode degrade.
 *
 * Point de securite, en reponse au §7 du brief (loi Evin):
 * cet objet ne contient AUCUN champ de texte libre destine a l'affichage.
 * `descripteurs` sert uniquement a construire le vecteur de requete, donc a
 * ORDONNER des resultats. Il ne ressort jamais dans la reponse. C'est ce qui
 * rend inoffensif un message du type "decris-moi ce vin comme une soiree
 * d'ete": le registre evocateur peut au pire changer l'ordre des resultats, il
 * ne peut pas se retrouver dans le texte affiche.
 * La barriere est de type: voir EntreeFormulation dans src/llm/index.ts.
 */

const PLATS_CONNUS = Object.keys(PLATS) as [string, ...string[]];

/**
 * Forme plate, tous champs REQUIS et nullables.
 *
 * Deux contraintes des structured outputs imposent cette forme: zodOutputFormat
 * veut un ZodObject (pas un ZodEffects issu de .refine()), et le mode strict
 * exige que chaque propriete soit requise. D'ou l'absence de .default() et de
 * .optional() ici: un champ non renseigne vaut null, explicitement.
 */
export const FiltresLlmSchema = z
  .strictObject({
    appellation: z.string().max(80).nullable()
      .describe("Identifiant d'appellation, ex: aoc-pic-saint-loup. null si non precise."),
    couleur: CouleurSchema.nullable()
      .describe('rouge, rose ou blanc. null si non precise.'),
    prix_min: z.number().positive().max(10000).nullable()
      .describe('Budget plancher en euros TTC. null si non precise.'),
    prix_max: z.number().positive().max(10000).nullable()
      .describe('Budget plafond en euros TTC. null si non precise.'),
    millesime_min: z.number().int().min(1900).max(2100).nullable(),
    millesime_max: z.number().int().min(1900).max(2100).nullable(),
    bio: z.boolean().nullable()
      .describe('true si l utilisateur demande explicitement du bio. null sinon.'),
    cepages_inclus: z.array(z.string().max(60)).max(6)
      .describe('Cepages souhaites. Tableau vide si non precise.'),
    cepages_exclus: z.array(z.string().max(60)).max(6)
      .describe('Cepages refuses. Tableau vide si non precise.'),
    plat: z.enum(PLATS_CONNUS).nullable()
      .describe('Vocabulaire ferme. null si aucun plat de la liste ne correspond.'),
    descripteurs: z.array(z.string().max(40)).max(8)
      .describe(
        'Descripteurs sensoriels souhaites. Sert au classement, jamais affiche.',
      ),
    descripteurs_exclus: z.array(z.string().max(40)).max(8)
      .describe(
        'Descripteurs REFUSES. "pas trop tannique" met "souple" dans ' +
        'descripteurs ET "tannique" ici. Sert au classement, jamais affiche.',
      ),
  });

/** Schema faisant foi: la forme plate plus les invariants croises. */
export const FiltresSchema = FiltresLlmSchema
  .refine((f) => f.prix_min === null || f.prix_max === null || f.prix_min <= f.prix_max, {
    message: 'prix_min doit etre inferieur ou egal a prix_max',
    path: ['prix_min'],
  })
  .refine(
    (f) =>
      f.millesime_min === null || f.millesime_max === null ||
      f.millesime_min <= f.millesime_max,
    { message: 'millesime_min doit etre inferieur ou egal a millesime_max', path: ['millesime_min'] },
  );

export type Filtres = z.infer<typeof FiltresLlmSchema>;

export const FILTRES_VIDES: Filtres = Object.freeze({
  appellation: null,
  couleur: null,
  prix_min: null,
  prix_max: null,
  millesime_min: null,
  millesime_max: null,
  bio: null,
  cepages_inclus: [],
  cepages_exclus: [],
  plat: null,
  descripteurs: [],
  descripteurs_exclus: [],
});

/**
 * Valide un objet partiel (panneau de filtres du front, ou correction a la
 * main) en completant les champs absents par leur valeur vide.
 */
export function parserFiltresPartiels(entree: unknown) {
  const objet = typeof entree === 'object' && entree !== null ? entree : {};
  return FiltresSchema.safeParse({ ...FILTRES_VIDES, ...objet });
}

/** Les cles portant une contrainte effective, pour l'affichage et les tests. */
export function filtresActifs(f: Filtres): string[] {
  return Object.entries(f)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== null))
    .map(([k]) => k);
}
