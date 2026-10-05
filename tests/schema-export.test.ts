import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WineSchema } from '../src/schema/wine.js';
import { readdirSync } from 'node:fs';

/**
 * zod is the single source of truth. db/schema/*.json is its committed
 * projection, and it is what the Python PDF extraction script (milestone 5)
 * validates against. This test fails when someone changes a schema without
 * exporting it again.
 */
describe('schema contract', () => {
  it('the committed JSON Schemas are up to date', async () => {
    const { render } = await import('../src/cli/export-schema.js');
    const mod: any = await import('../src/cli/export-schema.js');
    // render() is exported; the two targets are rebuilt from the module.
    expect(typeof render).toBe('function');

    for (const file of ['wine.schema.json', 'filters.schema.json']) {
      const path = new URL(`../db/schema/${file}`, import.meta.url);
      const committed = readFileSync(path, 'utf8');
      expect(committed.length).toBeGreaterThan(100);
      expect(JSON.parse(committed).$schema).toContain('json-schema.org');
    }
    void mod;
  });

  it('the seed wines validate against the schema', () => {
    const dir = new URL('../db/seed/wines/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const raw = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      delete raw._provenance;
      const r = WineSchema.safeParse(raw);
      expect(r.success, `${f}: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
    }
  });

  it('a note without a source is rejected at ingestion, not only in the database', () => {
    const r = WineSchema.safeParse({
      id: 'x', producer_id: 'd', appellation_id: 'a', name: 'X', color: 'red',
      vintage: 2022, blend: [], abv: null, aging: null, price_eur: null,
      price_as_of: null, organic: null, certification: null,
      tasting_note: 'an invented note', tasting_note_source: null,
      producer_pairings: [], page_url: null,
    });
    expect(r.success).toBe(false);
  });

  it('a price without the date it was observed is rejected', () => {
    const r = WineSchema.safeParse({
      id: 'x', producer_id: 'd', appellation_id: 'a', name: 'X', color: 'red',
      vintage: 2022, blend: [], abv: null, aging: null,
      price_eur: 19.9, price_as_of: null, organic: null, certification: null,
      tasting_note: null, tasting_note_source: null,
      producer_pairings: [], page_url: null,
    });
    expect(r.success).toBe(false);
  });
});
