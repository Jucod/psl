import { z } from 'zod';

export const IdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'identifier made of lowercase letters, digits and hyphens');

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date in YYYY-MM-DD format');

export const UrlSchema = z.url().max(500);

export const ColorSchema = z.enum(['red', 'rose', 'white']);
export type Color = z.infer<typeof ColorSchema>;

export const SourceTypeSchema = z.enum([
  'specification',
  'tech_sheet',
  'directory',
  'producer_page',
  'dev_fixture',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;
