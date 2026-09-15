import { z } from 'zod';

export const IdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'identifiant en minuscules, chiffres et tirets');

export const DateISOSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date au format AAAA-MM-JJ');

export const UrlSchema = z.url().max(500);

export const CouleurSchema = z.enum(['rouge', 'rose', 'blanc']);
export type Couleur = z.infer<typeof CouleurSchema>;

export const TypeSourceSchema = z.enum([
  'cahier_des_charges',
  'fiche_technique',
  'annuaire',
  'page_domaine',
  'fixture_dev',
]);
export type TypeSource = z.infer<typeof TypeSourceSchema>;
