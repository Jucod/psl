import { z } from 'zod';
import { IdSchema, IsoDateSchema, SourceTypeSchema, UrlSchema } from './common.js';

export const SourceSchema = z
  .strictObject({
    id: IdSchema,
    type: SourceTypeSchema,
    label: z.string().min(1).max(300),
    url: UrlSchema,
    authority: z.string().max(120).nullish(),
    retrieved_on: IsoDateSchema,
    content_sha256: z.string().length(64).nullish(),
  });

export type Source = z.infer<typeof SourceSchema>;
