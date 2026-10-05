import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { WineSchema, type Wine } from '../schema/wine.js';
import { buildGrapeIndex, grapeCode } from './util.js';
import { inspectNote, type QuarantinedNote } from './quarantine.js';

const BASE_DIR = fileURLToPath(new URL('../../db/seed/wines/', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../../db/seed/wines.fixtures/', import.meta.url));
const GRAPES_PATH = fileURLToPath(new URL('../../db/seed/grapes.json', import.meta.url));

export interface WineIngestSummary {
  wines: number;
  withProducerNote: number;
  onAppellationProfile: number;
  fixturesApplied: number;
  blendRows: number;
  /** Notes containing what looks like an instruction: to be reviewed by hand. */
  quarantine: QuarantinedNote[];
}

/**
 * `optional` is only true for the fixtures overlay, whose absence is a normal
 * state (and a desirable one in production). The base directory, on the other
 * hand, must exist: a silent `catch` there turned a broken path into an empty
 * catalog, and the seed finished "successfully" with zero wines.
 */
async function readJsonDir(
  dir: string,
  optional = false,
): Promise<Record<string, any>[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (err: any) {
    if (optional && err?.code === 'ENOENT') return [];
    throw new Error(`unreadable wines directory: ${dir} (${err?.code ?? err})`);
  }
  if (!optional && files.length === 0) {
    throw new Error(`no wine in ${dir}: the seed has nothing to load.`);
  }
  return Promise.all(
    files.sort().map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))),
  );
}

/**
 * Loads the wines. The files in db/seed/wines/ only carry what could be
 * sourced. db/seed/wines.fixtures/ is an OVERLAY that fills in the missing
 * fields (note, price, blend) with development values, under a source of type
 * `dev_fixture`.
 *
 * The overlay is only applied when allowFixtures is true. Otherwise the wines
 * stay without a note and the system answers from the appellation profile,
 * saying so, which is the behavior §3 of the brief expects: it never fills
 * the gap.
 */
export async function loadWines(allowFixtures: boolean): Promise<{
  wines: (Wine & { _fixture: boolean })[];
  fixturesApplied: number;
}> {
  const base = await readJsonDir(BASE_DIR);
  const overlays = allowFixtures ? await readJsonDir(FIXTURES_DIR, true) : [];
  const overlayById = new Map(overlays.map((o) => [o.id as string, o]));

  let fixturesApplied = 0;
  const wines = base.map((raw) => {
    const overlay = overlayById.get(raw.id);
    const merged: Record<string, any> = { ...raw };
    delete merged._provenance;

    if (overlay) {
      fixturesApplied++;
      for (const [key, value] of Object.entries(overlay)) {
        if (key.startsWith('_') || key === 'id') continue;
        merged[key] = value;
      }
    }

    const parsed = WineSchema.safeParse(merged);
    if (!parsed.success) {
      throw new Error(
        `invalid wine ${raw.id}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }
    // Provenance follows the ROW, not the note alone: the overlay also sets
    // price, blend, alcohol content, aging and certification.
    return { ...parsed.data, _fixture: overlay !== undefined };
  });

  return { wines, fixturesApplied };
}

export async function ingestWines(
  client: pg.PoolClient,
  allowFixtures: boolean,
): Promise<WineIngestSummary> {
  const grapesDoc = JSON.parse(await readFile(GRAPES_PATH, 'utf8'));
  const grapeIndex = buildGrapeIndex(grapesDoc.grapes);

  const { wines, fixturesApplied } = await loadWines(allowFixtures);

  const summary: WineIngestSummary = {
    wines: 0, withProducerNote: 0, onAppellationProfile: 0,
    fixturesApplied, blendRows: 0, quarantine: [],
  };

  for (const w of wines) {
    const suspicious = inspectNote(w.id, w.tasting_note);
    if (suspicious) summary.quarantine.push(suspicious);

    let noteSourceId: string | null = null;
    if (w.tasting_note_source) {
      const s = w.tasting_note_source;
      await client.query(
        `INSERT INTO sources (id, type, label, url, authority, retrieved_on)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           type=EXCLUDED.type, label=EXCLUDED.label, url=EXCLUDED.url,
           retrieved_on=EXCLUDED.retrieved_on`,
        [s.id, s.type, s.label, s.url, s.authority ?? null, s.retrieved_on],
      );
      noteSourceId = s.id;
    }

    // Level separation, materialized in the database. The producer's note is
    // embedded ON ITS OWN. When it is missing we make nothing up: the wine is
    // marked 'appellation' and search falls back to the AOC profile, saying so.
    const level = w.tasting_note ? 'wine' : 'appellation';
    const embeddingText = w.tasting_note;

    await client.query(
      `INSERT INTO wines
         (id, producer_id, appellation_id, color, name, vintage, abv,
          aging, price_eur, price_as_of, organic, certification,
          tasting_note, tasting_note_source_id, producer_pairings,
          embedding_text, embedding_level, page_url, from_fixture)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO UPDATE SET
         producer_id=EXCLUDED.producer_id, appellation_id=EXCLUDED.appellation_id,
         color=EXCLUDED.color, name=EXCLUDED.name,
         vintage=EXCLUDED.vintage, abv=EXCLUDED.abv,
         aging=EXCLUDED.aging, price_eur=EXCLUDED.price_eur,
         price_as_of=EXCLUDED.price_as_of, organic=EXCLUDED.organic,
         certification=EXCLUDED.certification,
         tasting_note=EXCLUDED.tasting_note,
         tasting_note_source_id=EXCLUDED.tasting_note_source_id,
         producer_pairings=EXCLUDED.producer_pairings,
         embedding_text=EXCLUDED.embedding_text,
         embedding_level=EXCLUDED.embedding_level,
         page_url=EXCLUDED.page_url,
         from_fixture=EXCLUDED.from_fixture,
         updated_at=now()`,
      [w.id, w.producer_id, w.appellation_id, w.color, w.name, w.vintage,
       w.abv, w.aging, w.price_eur, w.price_as_of, w.organic, w.certification,
       w.tasting_note, noteSourceId, w.producer_pairings,
       embeddingText, level, w.page_url, w._fixture],
    );

    summary.wines++;
    if (level === 'wine') summary.withProducerNote++;
    else summary.onAppellationProfile++;

    await client.query('DELETE FROM wine_grapes WHERE wine_id = $1', [w.id]);
    for (const component of w.blend) {
      const code = grapeCode(component.grape, grapeIndex);
      if (!code) {
        throw new Error(
          `wine ${w.id}: unknown grape variety "${component.grape}". Add it to db/seed/grapes.json ` +
          `rather than letting it through: a non-normalized variety makes a filter miss silently.`,
        );
      }
      await client.query(
        `INSERT INTO wine_grapes (wine_id, grape, pct) VALUES ($1,$2,$3)
         ON CONFLICT (wine_id, grape) DO UPDATE SET pct=EXCLUDED.pct`,
        [w.id, code, component.pct],
      );
      summary.blendRows++;
    }
  }

  return summary;
}
