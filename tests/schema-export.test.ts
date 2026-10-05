import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { WineSchema } from '../src/schema/wine.js';

/**
 * zod is the single source of truth. db/schema/*.json is its committed
 * projection, and it is what the Python PDF extraction script (milestone 5)
 * validates against. This test fails when someone changes a schema without
 * exporting it again.
 */
describe('schema contract', () => {
  it('the committed JSON Schemas are up to date', async () => {
    const { TARGETS, render } = await import('../src/cli/export-schema.js');
    expect(TARGETS.length).toBeGreaterThan(0);

    for (const target of TARGETS) {
      // A Windows checkout with core.autocrlf turns LF into CRLF: compare content, not line endings.
      const committed = readFileSync(new URL(`../db/schema/${target.file}`, import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
      expect(committed, `db/schema/${target.file} is stale: run npm run schema:export`)
        .toBe(render(target));
    }
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
