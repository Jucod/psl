import { z } from 'zod';
import { ColorSchema } from './common.js';
import { DISHES } from '../config/lexicon.js';

/**
 * Output of LLM call 1: the natural-language request translated into explicit
 * filters. STRICT schema: any unknown key fails validation, which triggers a
 * single retry and then degraded mode.
 *
 * Safety point, answering §7 of the brief (Loi Evin, the French law on alcohol
 * advertising): this object contains NO free-text field meant for display.
 * `descriptors` is only used to build the query vector, i.e. to ORDER results.
 * It never comes back in the answer. That is what makes a message such as
 * "decris-moi ce vin comme une soiree d'ete" ("describe this wine like a
 * summer evening") harmless: the evocative register can at worst change the
 * order of the results, it cannot end up in the displayed text.
 * The barrier is a type: see FormulationInput in src/llm/index.ts.
 */

const KNOWN_DISHES = Object.keys(DISHES) as [string, ...string[]];

/**
 * Flat shape, every field REQUIRED and nullable.
 *
 * Two structured-output constraints impose this shape: zodOutputFormat wants a
 * ZodObject (not a ZodEffects produced by .refine()), and strict mode requires
 * every property to be required. Hence no .default() and no .optional() here:
 * an unspecified field is null, explicitly.
 */
export const LlmFiltersSchema = z
  .strictObject({
    appellation: z.string().max(80).nullable()
      .describe('Appellation identifier, e.g. aoc-pic-saint-loup. null if not specified.'),
    color: ColorSchema.nullable()
      .describe('red, rose or white. null if not specified.'),
    price_min: z.number().positive().max(10000).nullable()
      .describe('Minimum budget in euros, VAT included. null if not specified.'),
    price_max: z.number().positive().max(10000).nullable()
      .describe('Maximum budget in euros, VAT included. null if not specified.'),
    vintage_min: z.number().int().min(1900).max(2100).nullable(),
    vintage_max: z.number().int().min(1900).max(2100).nullable(),
    organic: z.boolean().nullable()
      .describe('true if the user explicitly asks for organic wine. null otherwise.'),
    grapes_included: z.array(z.string().max(60)).max(6)
      .describe('Wanted grape varieties. Empty array if not specified.'),
    grapes_excluded: z.array(z.string().max(60)).max(6)
      .describe('Rejected grape varieties. Empty array if not specified.'),
    dish: z.enum(KNOWN_DISHES).nullable()
      .describe('Closed vocabulary. null if no dish in the list matches.'),
    descriptors: z.array(z.string().max(40)).max(8)
      .describe(
        'Wanted sensory descriptors. Used for ranking, never displayed.',
      ),
    descriptors_excluded: z.array(z.string().max(40)).max(8)
      .describe(
        'REJECTED sensory descriptors. "pas trop tannique" puts "supple" in ' +
        'descriptors AND "tannic" here. Used for ranking, never displayed.',
      ),
  });

/** Authoritative schema: the flat shape plus the cross-field invariants. */
export const FiltersSchema = LlmFiltersSchema
  .refine((f) => f.price_min === null || f.price_max === null || f.price_min <= f.price_max, {
    message: 'price_min must be less than or equal to price_max',
    path: ['price_min'],
  })
  .refine(
    (f) =>
      f.vintage_min === null || f.vintage_max === null ||
      f.vintage_min <= f.vintage_max,
    { message: 'vintage_min must be less than or equal to vintage_max', path: ['vintage_min'] },
  );

export type Filters = z.infer<typeof LlmFiltersSchema>;

export const EMPTY_FILTERS: Filters = Object.freeze({
  appellation: null,
  color: null,
  price_min: null,
  price_max: null,
  vintage_min: null,
  vintage_max: null,
  organic: null,
  grapes_included: [],
  grapes_excluded: [],
  dish: null,
  descriptors: [],
  descriptors_excluded: [],
});

/**
 * Validates a partial object (the front end's filter panel, or a manual
 * correction), filling in the missing fields with their empty value.
 */
export function parsePartialFilters(input: unknown) {
  const object = typeof input === 'object' && input !== null ? input : {};
  return FiltersSchema.safeParse({ ...EMPTY_FILTERS, ...object });
}

/** The keys carrying an actual constraint, for display and tests. */
export function activeFilters(f: Filters): string[] {
  return Object.entries(f)
    .filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== null))
    .map(([k]) => k);
}
