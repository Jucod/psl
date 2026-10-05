import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { WineBaseSchema } from '../schema/wine.js';
import { LlmFiltersSchema } from '../schema/filters.js';

/**
 * Exports the zod schemas as JSON Schema.
 *
 * This is the CONTRACT with the Python PDF extraction script (milestone 5):
 * zod is the single source of truth, the JSON Schema is its committed
 * projection, and tests/schema-export.test.ts fails when the committed file is
 * out of date.
 *
 * Cross-field invariants (a note requires its source, a price requires its
 * date) cannot be expressed in JSON Schema. They are restated as a description
 * and enforced by the database CHECK constraints.
 */
const TARGETS = [
  {
    schema: WineBaseSchema,
    file: 'wine.schema.json',
    invariants: [
      'a non-null tasting_note implies a non-null tasting_note_source',
      'a non-null price_eur implies a non-null price_as_of',
      'blend percentages add up to 0 (not provided) or ~100',
    ],
  },
  {
    schema: LlmFiltersSchema,
    file: 'filters.schema.json',
    invariants: [
      'price_min <= price_max',
      'vintage_min <= vintage_max',
    ],
  },
] as const;

export function render(target: (typeof TARGETS)[number]): string {
  const json = z.toJSONSchema(target.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  json['x-invariants'] = target.invariants;
  return JSON.stringify(json, null, 2) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const target of TARGETS) {
    const path = fileURLToPath(new URL(`../../db/schema/${target.file}`, import.meta.url));
    await writeFile(path, render(target), 'utf8');
    console.log(`schema exported: db/schema/${target.file}`);
  }
}
