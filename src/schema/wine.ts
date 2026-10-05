import { z } from 'zod';
import { ColorSchema, IdSchema, IsoDateSchema, UrlSchema } from './common.js';
import { SourceSchema } from './source.js';

/**
 * Target shape of a product row.
 *
 * The project's SOURCE OF TRUTH. Exported as JSON Schema
 * (db/schema/wine.schema.json) by `npm run schema:export`, and that JSON
 * Schema is what the Python PDF extraction script validates against
 * (milestone 5). Changing this file without re-exporting makes
 * tests/schema-export.test.ts fail.
 */

export const BlendComponentSchema = z
  .strictObject({
    grape: z.string().min(2).max(60),
    pct: z.number().positive().max(100).nullable(),
  });

/** Flat shape, without cross-field invariants: this is what gets exported as JSON Schema. */
export const WineBaseSchema = z
  .strictObject({
    id: IdSchema,
    producer_id: IdSchema,
    appellation_id: IdSchema,
    name: z.string().min(1).max(200),
    color: ColorSchema,
    vintage: z.number().int().min(1900).max(2100).nullable(),
    blend: z.array(BlendComponentSchema).max(12).default([]),
    abv: z.number().min(0).max(20).nullable(),
    aging: z.string().max(500).nullable(),
    price_eur: z.number().min(0).max(10000).nullable(),
    price_as_of: IsoDateSchema.nullable(),
    organic: z.boolean().nullable(),
    certification: z.string().max(60).nullable(),

    /**
     * Tasting note. Comes EXCLUSIVELY from the producer's own sheet, copied
     * verbatim. Never generated, never reworded. When it is missing it stays
     * null, and the system answers from the appellation profile and says so.
     */
    tasting_note: z.string().max(4000).nullable(),
    tasting_note_source: SourceSchema.nullable(),

    producer_pairings: z.array(z.string().max(120)).max(20).default([]),
    page_url: UrlSchema.nullable(),
  });

/**
 * Authoritative schema. The three cross-field invariants below cannot be
 * expressed in JSON Schema; they are duplicated as CHECK constraints in
 * db/migrations/004_producers_wines.sql, which remains the last line of
 * defense.
 */
export const WineSchema = WineBaseSchema
  // Same invariant as the `note_requires_source` constraint in the database.
  // Checked here to fail at ingestion rather than at INSERT time.
  .refine((w) => w.tasting_note === null || w.tasting_note_source !== null, {
    message: 'a tasting note requires its source',
    path: ['tasting_note_source'],
  })
  .refine((w) => w.price_eur === null || w.price_as_of !== null, {
    message: 'a price requires the date it was observed',
    path: ['price_as_of'],
  })
  .refine(
    (w) => {
      const total = w.blend.reduce((sum, component) => sum + (component.pct ?? 0), 0);
      // Tolerance: either no percentage at all, or a plausible total.
      return total === 0 || (total > 95 && total <= 100.5);
    },
    { message: 'blend percentages must add up to ~100', path: ['blend'] },
  );

export type Wine = z.infer<typeof WineSchema>;
