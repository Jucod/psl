import type pg from 'pg';
import { config, designationLabel, fieldByKey } from '../config/domain.js';
import { DISHES } from '../config/lexicon.js';
import { db, toVector } from '../db/client.js';
import type { Filters } from '../schema/filters.js';
import { buildClauses } from './query.js';
import { embeddingProvider } from '../embeddings/index.js';
import { checkSignature } from '../embeddings/signature.js';
import type {
  CitedSource, DerivedPairing, Relaxation, SearchResult, WineResult,
} from './types.js';

export interface SearchOptions {
  /** Vector of the fuzzy part of the request. null = lexicographic ranking. */
  queryVector?: number[] | null;
  allowFixtures?: boolean;
  pool?: pg.Pool;
  /** Loop guard. One iteration = one relaxation step. */
  maxIterations?: number;
  /**
   * Overrides config.maxResults. Used by ranking tests: observing a partition
   * requires seeing more rows than the interface shows.
   */
  maxResults?: number;
}

/**
 * Two CTEs implement the MASKING of the fields coming from the development
 * overlay when PSL_ALLOW_FIXTURES=0.
 *
 * Fields are masked, the row is not excluded. Excluding made the system
 * answer "the catalog contains no wine" on a catalog of five, while
 * /api/catalog announced the same five. Masking produces the behavior the
 * ingestion already documents: the wine stays visible, its description falls
 * back to the appellation profile, and that is announced.
 *
 * Masking applies to the COLUMNS, not only to the display: a masked price is
 * NULL, so a "under 20 €" filter stops retaining it. Filtering on a value we
 * refuse to show would be worse than excluding it.
 *
 * `wine_grapes` is deliberately redefined here: a CTE shadows the base table
 * for the whole query, including in the EXISTS clauses built from the config.
 * A masked blend therefore stops answering a grape-variety filter.
 */
const RESULTS_SQL = `
  WITH masked AS (
    SELECT id FROM wines WHERE from_fixture AND NOT $2::boolean
  ),
  wine_grapes AS (
    SELECT * FROM public.wine_grapes
     WHERE wine_id NOT IN (SELECT id FROM masked)
  ),
  w AS (
    SELECT
      b.id, b.producer_id, b.appellation_id, b.color, b.name,
      b.vintage, b.page_url, b.embedding, b.from_fixture,
      (b.id IN (SELECT id FROM masked)) AS is_masked,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.tasting_note END           AS tasting_note,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.tasting_note_source_id END AS tasting_note_source_id,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.price_eur END              AS price_eur,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.price_as_of END            AS price_as_of,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.abv END                    AS abv,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.aging END                  AS aging,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.organic END                AS organic,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.certification END          AS certification,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN '{}'::text[] ELSE b.producer_pairings END AS producer_pairings,
      CASE
        WHEN b.id IN (SELECT id FROM masked) OR b.tasting_note IS NULL THEN 'appellation'
        ELSE b.embedding_level
      END AS embedding_level,
      CASE WHEN b.id IN (SELECT id FROM masked) THEN NULL ELSE b.embedding END AS embedding_visible
    FROM wines b
    WHERE b.available
  )
  SELECT
    w.id, w.name, w.appellation_id, w.color, w.vintage, w.abv,
    w.aging, w.price_eur, w.price_as_of::text AS price_as_of,
    w.organic, w.certification, w.tasting_note, w.producer_pairings,
    w.page_url, w.embedding_level, w.from_fixture, w.is_masked,
    p.id AS producer_id, p.name AS producer, p.commune,
    d.name AS appellation_name, d.tier AS appellation_tier,
    ns.id  AS ns_id,  ns.type AS ns_type, ns.label AS ns_label,
    ns.url AS ns_url, ns.authority AS ns_authority, ns.retrieved_on::text AS ns_date,
    ap.profile_text, ap.source_section,
    ps.id  AS ps_id,  ps.type AS ps_type, ps.label AS ps_label,
    ps.url AS ps_url, ps.authority AS ps_authority, ps.retrieved_on::text AS ps_date,
    COALESCE((
      SELECT json_agg(json_build_object('grape', wg.grape, 'pct', wg.pct)
                      ORDER BY wg.pct DESC NULLS LAST, wg.grape)
      FROM wine_grapes wg WHERE wg.wine_id = w.id
    ), '[]'::json) AS blend,
    CASE
      WHEN $1::vector IS NULL THEN NULL
      ELSE 1 - (COALESCE(w.embedding_visible, ap.embedding) <=> $1::vector)
    END AS score
  FROM w
  JOIN producers p ON p.id = w.producer_id
  JOIN appellations d ON d.id = w.appellation_id
  LEFT JOIN appellation_profiles ap
         ON ap.appellation_id = w.appellation_id AND ap.color = w.color
  LEFT JOIN sources ns ON ns.id = w.tasting_note_source_id
  LEFT JOIN sources ps ON ps.id = ap.source_id
  WHERE `;

/** `ns` = source of the note, `ps` = source of the appellation profile. */
function source(
  r: Record<string, any>, prefix: 'ns' | 'ps',
): CitedSource | null {
  const id = r[`${prefix}_id`];
  if (!id) return null;
  return {
    id,
    type: r[`${prefix}_type`],
    label: r[`${prefix}_label`],
    url: r[`${prefix}_url`],
    authority: r[`${prefix}_authority`] ?? null,
    retrieved_on: r[`${prefix}_date`],
  };
}

function toResult(r: Record<string, any>): WineResult {
  const noteSource = source(r, 'ns');
  const profileSource = source(r, 'ps');
  return {
    id: r.id,
    name: r.name,
    producer: r.producer,
    producer_id: r.producer_id,
    commune: r.commune ?? null,
    appellation_id: r.appellation_id,
    appellation_name: r.appellation_name,
    appellation_tier: r.appellation_tier,
    color: r.color,
    vintage: r.vintage ?? null,
    abv: r.abv ?? null,
    aging: r.aging ?? null,
    price_eur: r.price_eur ?? null,
    price_as_of: r.price_as_of ?? null,
    organic: r.organic ?? null,
    certification: r.certification ?? null,
    blend: r.blend ?? [],
    page_url: r.page_url ?? null,
    tasting_note: r.tasting_note ?? null,
    note_source: noteSource,
    producer_pairings: r.producer_pairings ?? [],
    level: r.embedding_level,
    appellation_profile:
      r.profile_text && profileSource
        ? { text: r.profile_text, source: profileSource, section: r.source_section ?? null }
        : null,
    score: r.score === null || r.score === undefined ? 0 : Number(r.score),
    fixture: r.from_fixture === true,
    relevant_excerpt: null,
  };
}

async function runQuery(
  pool: pg.Pool,
  filters: Filters,
  vector: number[] | null,
  allowFixtures: boolean,
  maxResults: number = config.maxResults,
): Promise<WineResult[]> {
  const { text, params } = buildClauses(filters, 3);
  const sql =
    RESULTS_SQL + `(${text})\n` +
    `  ORDER BY score DESC NULLS LAST, w.price_eur ASC NULLS LAST, w.id\n` +
    `  LIMIT ${Number.isInteger(maxResults) ? maxResults : config.maxResults}`;

  const { rows } = await pool.query(sql, [
    vector ? toVector(vector) : null,
    allowFixtures,
    ...params,
  ]);
  return rows.map(toResult);
}

/**
 * Spread of the scores over EVERY wine that satisfies the hard filters, not
 * over the rows shown. Measured on the top three, it shrank as the catalog
 * grew: the best three of 57 wines are close to each other by construction,
 * and the engine fell back to a price ranking on requests the vector
 * separated perfectly well. Whether the vector discriminates is a property of
 * the candidates, not of the page.
 */
async function candidateSpread(
  pool: pg.Pool, filters: Filters, vector: number[], allowFixtures: boolean,
): Promise<number> {
  const { text, params } = buildClauses(filters, 3);
  const { rows } = await pool.query(
    `SELECT COALESCE(max(score) - min(score), 0)::float AS spread
       FROM (${RESULTS_SQL}(${text})) candidates`,
    [toVector(vector), allowFixtures, ...params],
  );
  return rows[0]!.spread as number;
}

/**
 * Checks that the requested combination is covered by the catalog at the
 * reference-data level. It is a QUERY, not a prompt instruction: refusing a
 * white Pic Saint-Loup is reproducible and testable without any LLM call.
 */
async function checkCoverage(
  pool: pg.Pool,
  filters: Filters,
): Promise<{ message: string; source: CitedSource | null } | null> {
  const { table, keys, message } = config.coverage;
  const values: Record<string, unknown> = {};
  for (const { filter } of keys) {
    const v = (filters as Record<string, unknown>)[filter];
    if (v === null || v === undefined) return null; // nothing to check
    values[filter] = v;
  }

  const conditions = keys.map((k, i) => `${k.column} = $${i + 1}`).join(' AND ');
  const params = keys.map((k) => values[k.filter]);

  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE ${conditions}`, params);
  if (rowCount && rowCount > 0) return null;

  // The combination does not exist. We say what does exist, we do not offer
  // something close.
  const discriminatingKey = keys[keys.length - 1]!;
  const others = keys.slice(0, -1);
  const { rows } = await pool.query(
    `SELECT ${discriminatingKey.column} AS v FROM ${table}
      WHERE ${others.map((k, i) => `${k.column} = $${i + 1}`).join(' AND ') || 'TRUE'}
      ORDER BY 1`,
    others.map((k) => values[k.filter]),
  );
  const available = rows.map((r) => String(r.v));
  if (available.length === 0) return null; // unknown appellation: not a coverage refusal

  const { rows: src } = await pool.query(
    `SELECT a.name, s.id, s.type, s.label, s.url, s.authority, s.retrieved_on::text AS retrieved_on
       FROM appellations a JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1`,
    [values[keys[0]!.filter]],
  );

  // The message is addressed to a visitor: they must read "Pic Saint-Loup",
  // not "aoc-pic-saint-loup".
  const readable = { ...values };
  if (src[0]?.name) readable[keys[0]!.filter] = src[0].name;

  // Where the catalog DOES hold that color. Nothing is served (it is still a
  // refusal), but "a white Pic Saint-Loup" is the first thing a visitor asks,
  // and the estates' whites exist under other designations: saying which
  // turns a dead end into the next request.
  const { rows: elsewhere } = await pool.query<{ name: string; tier: string }>(
    `SELECT d.name, d.tier
       FROM wines w JOIN appellations d ON d.id = w.appellation_id
      WHERE w.available AND w.${discriminatingKey.column} = $1 AND w.${keys[0]!.column} <> $2
      GROUP BY d.name, d.tier
      ORDER BY array_position(ARRAY['aop','igp','vsig'], d.tier), d.name`,
    [values[discriminatingKey.filter], values[keys[0]!.filter]],
  );

  return {
    message: message(readable, available, elsewhere.map((r) => designationLabel(r.name, r.tier))),
    source: src[0]
      ? {
          id: src[0].id, type: src[0].type, label: src[0].label, url: src[0].url,
          authority: src[0].authority ?? null, retrieved_on: src[0].retrieved_on,
        }
      : null,
  };
}

async function dishPairings(
  pool: pg.Pool, filters: Filters,
): Promise<DerivedPairing[]> {
  if (!filters.dish || !filters.appellation || !filters.color) return [];
  const category = DISHES[filters.dish]?.category;
  if (!category) return [];

  const { rows } = await pool.query(
    `SELECT label, category, status, derived_from FROM appellation_pairings
      WHERE appellation_id = $1 AND color = $2 AND category = $3
      ORDER BY label`,
    [filters.appellation, filters.color, category],
  );
  return rows as DerivedPairing[];
}

/**
 * Which active filters bear on a column that is unknown for every candidate
 * wine? The coverage keys (appellation, color) are excluded: they are
 * identity criteria, not data that may be missing.
 *
 * Fixture masking is applied, otherwise we would conclude from values we
 * refuse to show.
 */
async function undecidableFilters(
  pool: pg.Pool, filters: Filters, allowFixtures: boolean,
): Promise<{ field: string; label: string }[]> {
  const identity = new Set(config.coverage.keys.map((k) => k.filter));
  const candidates = config.fields.filter(
    (f) =>
      f.column &&
      !identity.has(f.key) &&
      (filters as Record<string, unknown>)[f.key] !== null &&
      (filters as Record<string, unknown>)[f.key] !== undefined,
  );
  if (candidates.length === 0) return [];

  const projections = candidates
    .map((f, i) => `count(${f.column}) FILTER (WHERE NOT is_masked)::int AS n${i}`)
    .join(', ');

  const { rows } = await pool.query(
    `SELECT ${projections}
       FROM (
         SELECT *, (from_fixture AND NOT $3::boolean) AS is_masked
           FROM wines
          WHERE available
            AND ($1::text IS NULL OR appellation_id = $1)
            AND ($2::text IS NULL OR color = $2)
       ) t`,
    [filters.appellation, filters.color, allowFixtures],
  );

  return candidates
    .filter((_, i) => rows[0]![`n${i}`] === 0)
    .map((f) => ({ field: f.key, label: f.label }));
}

async function catalogSize(pool: pg.Pool, filters: Filters): Promise<number> {
  const { rows } = await pool.query(
    // Masked rows still exist in the catalog: only their development fields
    // are hidden. Subtracting them would be lying about the size of the
    // catalog, which /api/catalog would contradict at once.
    `SELECT count(*)::int AS n FROM wines w
      WHERE w.available
        AND ($1::text IS NULL OR w.appellation_id = $1)
        AND ($2::text IS NULL OR w.color = $2)`,
    [filters.appellation, filters.color],
  );
  return rows[0]!.n as number;
}

export async function search(
  filters: Filters,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const pool = options.pool ?? db();
  const allowFixtures = options.allowFixtures ?? false;
  const maxIterations = options.maxIterations ?? 12;
  const maxResults = options.maxResults ?? config.maxResults;
  const warnings: string[] = [];

  // Were the stored vectors computed with the current configuration?
  // If not, we refuse to rank by vector: a wrong order that looks right costs
  // more than an openly price-based ranking.
  let vector = options.queryVector ?? null;
  if (vector) {
    const state = await checkSignature(pool, embeddingProvider());
    if (!state.upToDate) {
      warnings.push(state.message!);
      vector = null;
    }
  }

  const base: SearchResult = {
    status: 'empty',
    refusal: null,
    requestedFilters: filters,
    appliedFilters: filters,
    relaxations: [],
    ranking: vector ? 'vector' : 'lexicographic',
    results: [],
    dishPairings: [],
    catalogSize: 0,
    warnings,
    undecidableFilters: [],
  };

  // 1. Can the catalog, by construction, contain what is requested?
  const refusal = await checkCoverage(pool, filters);
  if (refusal) return { ...base, status: 'refused', refusal };

  base.catalogSize = await catalogSize(pool, filters);
  base.dishPairings = await dishPairings(pool, filters);

  // 2. Search, then relax ONE constraint at a time.
  const original = { ...filters } as Record<string, any>;
  let current = { ...filters } as Record<string, any>;
  const relaxations: Relaxation[] = [];

  for (let i = 0; i <= maxIterations; i++) {
    const results = await runQuery(pool, current as Filters, vector, allowFixtures, maxResults);

    if (results.length > 0) {
      // The threshold must decide BEFORE the LIMIT, not after.
      //
      // Re-sorting in JS the three rows the vector had selected announced
      // "ranked by price" while returning the 2nd and 3rd most expensive
      // bottles of the catalog, although two cheaper ones satisfied every
      // hard filter. So we run the query again without the vector.

      // Two conditions, both learned the hard way.
      //
      // 1. An APPELLATION-level signal is not a ranking of wines. When every
      //    row falls back to the same AOC profile, their vectors are
      //    IDENTICAL: the cosine is 0.28 everywhere, the actual order is only
      //    the tie-break by price then by id, and the engine still announced
      //    "ranked by relevance". It is an appellation trait presented as a
      //    wine trait, in its most extreme form.
      //
      // 2. Discrimination is measured by the SPREAD, not by an absolute
      //    floor, and over the candidates, not the rows shown. See the
      //    comments on config.discriminationThreshold and candidateSpread().
      const relevant =
        vector !== null &&
        results.some((r) => r.level === 'wine') &&
        (await candidateSpread(pool, current as Filters, vector, allowFixtures)) >=
          config.discriminationThreshold;

      const ordered = relevant
        ? results
        : await runQuery(pool, current as Filters, null, allowFixtures, maxResults);

      return {
        ...base,
        status: 'ok',
        appliedFilters: current as Filters,
        relaxations,
        ranking: relevant ? 'vector' : 'lexicographic',
        results: ordered,
      };
    }

    const step = relaxOneStep(current, original);
    if (!step) break;
    current = step.filters;
    relaxations.push(step.relaxation);
  }

  return {
    ...base,
    status: 'empty',
    appliedFilters: current as Filters,
    relaxations,
    undecidableFilters: await undecidableFilters(pool, filters, allowFixtures),
  };
}

/**
 * Relaxes exactly ONE constraint by one step, following the order declared in
 * the config. Returns null when nothing can be relaxed any more: the system
 * then answers "I have nothing", it never widens silently.
 */
function relaxOneStep(
  current: Record<string, any>,
  original: Record<string, any>,
): { filters: Record<string, any>; relaxation: Relaxation } | null {
  for (const key of config.relaxationOrder) {
    const value = current[key];
    if (value === null || value === undefined) continue;

    const field = fieldByKey.get(key);
    if (!field?.relax) continue;

    const next = field.relax(value, original[key]);
    // A relaxation that does not move is not a relaxation: without this
    // guard, a budget rounded to itself monopolized the ladder and the
    // vintage rung was never reached, while announcing thirteen times
    // "budget porte de 0.01 € a 0.01 €".
    if (!next || Object.is(next.value, value)) continue;

    return {
      filters: { ...current, [key]: next.value },
      relaxation: { field: key, label: field.label, announcement: next.announcement },
    };
  }
  return null;
}
