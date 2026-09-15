import { z } from 'zod';
import { DateISOSchema, IdSchema, TypeSourceSchema, UrlSchema } from './commun.js';

export const SourceSchema = z
  .strictObject({
    id: IdSchema,
    type: TypeSourceSchema,
    label: z.string().min(1).max(300),
    url: UrlSchema,
    autorite: z.string().max(120).nullish(),
    date_releve: DateISOSchema,
    contenu_sha256: z.string().length(64).nullish(),
  });

export type Source = z.infer<typeof SourceSchema>;
