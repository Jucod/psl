import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { slug } from './util.js';

const SEED_PATH = fileURLToPath(new URL('../../db/seed/pic-saint-loup-seed.json', import.meta.url));
const GRAPES_PATH = fileURLToPath(new URL('../../db/seed/grapes.json', import.meta.url));

/**
 * Date the reference data was collected by hand, not the publication date of
 * the INAO text. A source added later states its own `retrieved_on`.
 */
const RETRIEVED_ON = '2026-09-14';

const SOURCE_TYPES = new Set(['specification', 'regulation', 'directory', 'producer_page']);
const TIERS = new Set(['aop', 'igp', 'vsig']);

export interface ReferenceIngestSummary {
  sources: number; appellations: number; colors: number;
  profiles: number; pairings: number; producers: number; grapes: number;
}

export async function ingestReference(client: pg.PoolClient): Promise<ReferenceIngestSummary> {
  const seed = JSON.parse(await readFile(SEED_PATH, 'utf8'));
  const grapesDoc = JSON.parse(await readFile(GRAPES_PATH, 'utf8'));

  const summary: ReferenceIngestSummary = {
    sources: 0, appellations: 0, colors: 0, profiles: 0, pairings: 0, producers: 0, grapes: 0,
  };

  for (const s of seed._meta.sources) {
    if (!SOURCE_TYPES.has(s.type)) throw new Error(`source ${s.id}: unknown type ${s.type}`);
    await client.query(
      `INSERT INTO sources (id, type, label, url, authority, retrieved_on)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         type=EXCLUDED.type, label=EXCLUDED.label, url=EXCLUDED.url,
         authority=EXCLUDED.authority, retrieved_on=EXCLUDED.retrieved_on`,
      [slug(s.id), s.type, s.label, s.url, s.authority ?? null, s.retrieved_on ?? RETRIEVED_ON],
    );
    summary.sources++;
  }

  for (const a of seed.appellations) {
    // The tier is what the AOP badge shows: a designation without one would be
    // displayed as protected or not by accident.
    if (!TIERS.has(a.tier)) throw new Error(`designation ${a.id}: tier must be aop, igp or vsig`);
    await client.query(
      `INSERT INTO appellations
         (id, name, tier, aliases, status, region, recognized_year, communes, grape_rules,
          production, terroir, source_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, tier=EXCLUDED.tier, aliases=EXCLUDED.aliases,
         status=EXCLUDED.status, region=EXCLUDED.region,
         recognized_year=EXCLUDED.recognized_year,
         communes=EXCLUDED.communes, grape_rules=EXCLUDED.grape_rules,
         production=EXCLUDED.production, terroir=EXCLUDED.terroir,
         source_id=EXCLUDED.source_id, updated_at=now()`,
      [
        a.id, a.name, a.tier, a.aliases ?? [], a.status, a.region ?? null,
        a.aoc_recognized ? Number(a.aoc_recognized) : null,
        JSON.stringify(a.communes ?? {}),
        JSON.stringify(a.grape_rules ?? {}),
        JSON.stringify(a.production ?? {}),
        JSON.stringify(a.terroir ?? {}),
        slug(a.source),
      ],
    );
    summary.appellations++;

    // The table that produces the refusal "the AOC only covers reds and roses".
    for (const color of a.permitted_colors) {
      await client.query(
        `INSERT INTO appellation_colors (appellation_id, color)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [a.id, color],
      );
      summary.colors++;
    }

    const profiles = a.official_sensory_profile ?? {};
    const sourceSection: string | undefined = profiles._source;
    for (const [color, p] of Object.entries<any>(profiles)) {
      if (color.startsWith('_')) continue;
      if (!a.permitted_colors.includes(color)) continue;

      // Flat text embedded at the APPELLATION level. Never merged with a
      // wine's note: merging would make all the wines of the AOC collinear and
      // flatten the ranking. The text is French ("robe", "aromes", "bouche"):
      // it is compared to French notes and shown to visitors as it is.
      const text = [
        p.appearance ? `robe ${p.appearance}` : null,
        Array.isArray(p.aromas) && p.aromas.length ? `aromes ${p.aromas.join(', ')}` : null,
        p.palate ? `bouche ${p.palate}` : null,
        p.structure ?? null,
        p.aging_potential ?? null,
      ].filter(Boolean).join('. ');

      await client.query(
        `INSERT INTO appellation_profiles
           (appellation_id, color, appearance, aromas, palate, structure, aging_potential,
            profile_text, source_id, source_section)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (appellation_id, color) DO UPDATE SET
           appearance=EXCLUDED.appearance, aromas=EXCLUDED.aromas, palate=EXCLUDED.palate,
           structure=EXCLUDED.structure, aging_potential=EXCLUDED.aging_potential,
           profile_text=EXCLUDED.profile_text, source_id=EXCLUDED.source_id,
           source_section=EXCLUDED.source_section`,
        [a.id, color, p.appearance ?? null, p.aromas ?? [], p.palate ?? null,
         p.structure ?? null, p.aging_potential ?? null, text, slug(a.source),
         sourceSection ?? null],
      );
      summary.profiles++;
    }

    // DERIVED pairings. The seed's `rationale` field is NOT ingested: unsourced
    // editorial prose, in the evocative register the Loi Evin forbids.
    const pairings = a.food_pairings ?? {};
    const CATEGORIES = ['meat', 'cheese', 'fish'] as const;
    for (const [color, block] of Object.entries<any>(pairings)) {
      if (color.startsWith('_')) continue;
      if (!a.permitted_colors.includes(color)) continue;
      for (const category of CATEGORIES) {
        for (const label of block[category] ?? []) {
          await client.query(
            `INSERT INTO appellation_pairings
               (appellation_id, color, category, label, status, derived_from)
             VALUES ($1,$2,$3,$4,'derived',$5)
             ON CONFLICT (appellation_id, color, category, label) DO NOTHING`,
            [a.id, color, category, label, `official_sensory_profile.${color}`],
          );
          summary.pairings++;
        }
      }
    }
  }

  const producers = seed.producers ?? {};
  for (const p of producers.estates ?? []) {
    await client.query(
      `INSERT INTO producers (id, name, commune, department, type, website_url, source_id)
       VALUES ($1,$2,$3,$4,'estate',$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, commune=EXCLUDED.commune, type=EXCLUDED.type,
         source_id=EXCLUDED.source_id, updated_at=now()`,
      [slug(p.name), p.name, p.commune ?? null, 'Herault',
       p.website === 'TODO' ? null : p.website, slug('syndicat_psl')],
    );
    summary.producers++;
  }
  for (const c of producers.cooperatives ?? []) {
    await client.query(
      `INSERT INTO producers (id, name, commune, department, type, source_id)
       VALUES ($1,$2,$3,$4,'cooperative',$5)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, commune=EXCLUDED.commune, type=EXCLUDED.type, updated_at=now()`,
      [slug(c.name), c.name, (c.communes ?? [])[0] ?? null, 'Herault', slug('syndicat_psl')],
    );
    summary.producers++;
  }

  for (const g of grapesDoc.grapes) {
    await client.query(
      `INSERT INTO grapes (code, label, synonyms) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label, synonyms=EXCLUDED.synonyms`,
      [g.code, g.label, g.synonyms],
    );
    summary.grapes++;
  }

  return summary;
}
