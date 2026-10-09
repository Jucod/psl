import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, toVector } from '../src/db/client.js';
import { search } from '../src/engine/search.js';
import { LocalEmbedding } from '../src/embeddings/local.js';
import { vectorText } from '../src/llm/parser.js';
import { combine } from '../src/pipeline.js';
import { config } from '../src/config/domain.js';
import { EMPTY_FILTERS, type Filters } from '../src/schema/filters.js';

const PSL = 'aoc-pic-saint-loup';
const emb = new LocalEmbedding(config.embeddingDimension);

function filters(partial: Partial<Filters>): Filters {
  return { ...EMPTY_FILTERS, appellation: PSL, ...partial };
}

/** Builds the query vector exactly as the pipeline does. */
async function vector(f: Filters): Promise<number[] | null> {
  const t = vectorText(f);
  if (!t) return null;
  const [vIn, vEx] = await emb.embed([t.included || ' ', ...(t.excluded ? [t.excluded] : [])]);
  return vEx ? combine(vIn!, vEx, config.rejectionWeight) : vIn!;
}

const options = { allowFixtures: true };

const OVERLAY_DIR = new URL('../db/seed/wines.fixtures/', import.meta.url);

/** Content of the development overlay, read at the source. */
const OVERLAY: { id: string; keys: string[] }[] = (() => {
  try {
    return readdirSync(OVERLAY_DIR)
      .filter((x) => x.endsWith('.json'))
      .map((x) => JSON.parse(readFileSync(new URL(x, OVERLAY_DIR), 'utf8')))
      .map((o: Record<string, unknown>) => ({
        id: String(o.id),
        keys: Object.keys(o).filter((k) => !k.startsWith('_') && k !== 'id'),
      }));
  } catch {
    return [];
  }
})();
const OVERLAY_IDS = new Set(OVERLAY.map((c) => c.id));

/**
 * The overlay is temporary: the project's goal is to delete it. The day it
 * disappears, these cases have nothing left to test. They are SKIPPED visibly
 * rather than allowed to pass on an empty set, which would turn them into
 * silent false witnesses.
 */
const ifOverlay = OVERLAY_IDS.size > 0 ? it : it.skip;

/**
 * Builds a catalog state inside a rolled-back transaction.
 *
 * A SINGLE-connection pool is required: with an ordinary pool the engine
 * would take another connection and would not see the transaction.
 */
async function inTransaction<T>(
  setup: string, body: (pool: pg.Pool) => Promise<T>,
): Promise<T> {
  const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await p.query('BEGIN');
    await p.query(setup);
    return await body(p);
  } finally {
    await p.query('ROLLBACK').catch(() => {});
    await p.end();
  }
}

// Partition established by READING the notes, not by sorting the scores:
// picking the members from the ranking under test would be circular. Each id
// carries the segment of its note that places it.
const SUPPLE = [
  'morties-que-sera-sera-2024',      // "les tanins fins et delicats"
  'mas-bruguiere-l-arbouse-2024',    // "la rondeur s'associe a une belle fraicheur"
  'mas-foulaquier-l-orphee-2023',    // "alliant gourmandise, souplesse et puissance"
  'mas-foulaquier-les-calades-2024', // "alliant gourmandise, souplesse et epice"
];
const STRUCTURED = [
  'lancyre-vieilles-vignes-2022',    // "Bouche dense et charpentee, tanins presents et serres"
  'lancyre-grande-cuvee-2021',       // "Bouche puissante et structuree, tanins fermes"
  'morties-pic-saint-loup-2024',     // "des tanins presents qui s'affineront"
];

describe('milestone 2 - hybrid search', () => {
  afterAll(async () => { await closeDb(); });

  it('REFUSAL CASE: a white Pic Saint-Loup is refused, not approximated', async () => {
    const r = await search(filters({ color: 'white' }), options);

    expect(r.status).toBe('refused');
    expect(r.results).toHaveLength(0);
    expect(r.refusal?.message).toMatch(/ne couvre pas les blancs/i);
    // The refusal says what exists...
    expect(r.refusal?.message).toMatch(/rouge/);
    expect(r.refusal?.message).toMatch(/rose/);
    // ...and cites its source.
    expect(r.refusal?.source?.url).toMatch(/^https?:\/\//);
  });

  it('EMPTY CASE: a criterion covered by the AOC but absent from the catalog', async () => {
    // This case used to be about rose, which no wine represented back then.
    // The real corpus contains one (Dame Jeanne 2025): the premise is dead,
    // and that is good news. It is rebuilt on the grape axis, where it
    // discriminates better: cinsault is permitted by the AOC grape rules, so
    // NO coverage refusal is due, but no wine in the catalog contains any.
    //
    // The three states of the same axis are thus held by three tests:
    //   chardonnay -> refused (outside the AOC grape rules)
    //   cinsaut    -> empty   (in the AOC, absent from the catalog)
    //   syrah      -> ok
    const r = await search(filters({ color: 'red', grapes_included: ['cinsaut'] }), options);

    expect(r.status).toBe('empty');
    expect(r.results).toHaveLength(0);
    expect(r.refusal).toBeNull();
    // The catalog is not empty: it is that grape that is missing.
    expect(r.catalogSize).toBeGreaterThan(0);
    // And no missing data is used as an excuse: the blends are known.
    expect(r.undecidableFilters).toHaveLength(0);
  });

  it('ROSE CASE: an AOC color now represented gets a normal answer', async () => {
    // Witness of the switch from fixtures to real data: rose used to be the
    // hole in the catalog, it no longer is. If this test turns empty again,
    // the corpus has regressed.
    const r = await search(filters({ color: 'rose' }), options);

    expect(r.status).toBe('ok');
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.refusal).toBeNull();
    for (const c of r.results) expect(c.color).toBe('rose');
  });

  it('RELAXATION CASE: the budget is relaxed step by step, and announced', async () => {
    // Nothing under 12 euros: the cheapest red in the catalog is at 16.
    const r = await search(filters({ color: 'red', price_max: 12 }), options);

    expect(r.status).toBe('ok');
    expect(r.relaxations.length).toBeGreaterThan(0);
    expect(r.relaxations[0]!.field).toBe('price_max');
    expect(r.relaxations[0]!.announcement).toMatch(/budget porte de/);
    // The applied budget moved, the requested one did not.
    expect(r.appliedFilters.price_max).toBeGreaterThan(12);
    expect(r.requestedFilters.price_max).toBe(12);
    // Capped at +50%: no endless drift.
    expect(r.appliedFilters.price_max).toBeLessThanOrEqual(12 * 1.5 + 0.01);
  });

  it('RELAXATION CASE: the announced cap is REACHABLE, not decorative', async () => {
    // Regression. The ladder went up in 25% steps and gave up as soon as the
    // NEXT step exceeded the cap, instead of settling on it: 12 € -> 15 €,
    // then 18.75 € > 18 € so stop. We answered "nothing found" while keeping
    // 3 € of announced margin up our sleeve, although two wines were at 16 €.
    // A cap that cannot be reached lies about what the system really tried.
    //
    // Invisible on the fixture corpus: the cheapest wine there was at 14 €,
    // so the first step was always enough. The real corpus now has reds at
    // 13 and 14 €: the state is BUILT, no red at 15 € or less, so that only
    // the capped step can answer.
    const r = await inTransaction(
      'UPDATE wines SET available = false WHERE price_eur <= 15',
      (pool) => search(filters({ color: 'red', price_max: 12 }), { ...options, pool }),
    );

    expect(r.status).toBe('ok');
    expect(r.appliedFilters.price_max).toBeCloseTo(18, 2);
    // Every step is announced, and each one moves forward.
    const announcements = r.relaxations.map((x) => x.announcement);
    expect(announcements.length).toBeGreaterThanOrEqual(2);
    expect(new Set(announcements).size).toBe(announcements.length);
    // And the result fits within the announced cap.
    for (const c of r.results) expect(c.price_eur).toBeLessThanOrEqual(18);
  });

  it('NO POSSIBLE RELAXATION: nothing, and we say so', async () => {
    const r = await search(filters({ color: 'red', price_max: 3 }), options);

    expect(r.status).toBe('empty');
    expect(r.results).toHaveLength(0);
    // Relaxations were indeed attempted before giving up.
    expect(r.relaxations.length).toBeGreaterThan(0);
  });

  it('THE APPELLATION IS NEVER RELAXED silently', async () => {
    const r = await search(filters({ color: 'red', price_max: 3 }), options);
    expect(r.relaxations.some((x) => x.field === 'appellation')).toBe(false);
    expect(r.appliedFilters.appellation).toBe(PSL);
  });

  it('RANKING CASE: "pas trop tannique" separates supple wines from structured ones', async () => {
    // Asserting an EXACT RANK would be a false witness: between two notes
    // equally supple, the gap is worth the hashing collision noise. What is
    // really discriminated is the PARTITION.
    //
    // maxResults covers the whole red catalog: on a top-3, the first three
    // are often tied and the partition cannot be observed.
    const f = filters({
      color: 'red',
      descriptors: ['supple'], descriptors_excluded: ['tannic'],
    });
    const r = await search(f, {
      ...options, queryVector: await vector(f), maxResults: 50,
    });

    expect(r.status).toBe('ok');
    expect(r.ranking).toBe('vector');

    const score = (id: string) => r.results.find((x) => x.id === id)?.score;
    const suppleScores = SUPPLE.map(score).filter((s): s is number => s !== undefined);
    const structuredScores = STRUCTURED.map(score).filter((s): s is number => s !== undefined);

    // Without these two equalities, a renamed id would silently leave the set
    // and the test would pass on an empty set.
    expect(suppleScores.length).toBe(SUPPLE.length);
    expect(structuredScores.length).toBe(STRUCTURED.length);

    const worstSupple = Math.min(...suppleScores);
    const bestStructured = Math.max(...structuredScores);
    expect(worstSupple).toBeGreaterThan(bestStructured);
    // Required margin, so that the test fails if the signal DEGRADES and not
    // only if it flips. Observed value on the real corpus: 0.27, bounded by
    // Morties Pic Saint-Loup, the most ambiguous of the seven notes ("bouche
    // equilibree" AND "tanins presents"). 0.20 leaves ~25% of slack.
    expect(worstSupple - bestStructured).toBeGreaterThan(0.20);
  });

  it('REVERSE CASE: the partition flips when the request flips', async () => {
    // A negative assertion on a single id would pass on a sort by price, by
    // id, or at random. So the whole partition is tested again, the other way
    // round: the same two groups must swap places.
    //
    // The previous version read the score with "?? -Infinity". After the
    // wines were renamed, the compared ids no longer existed and it compared
    // -Infinity with -Infinity: green, and witnessing nothing.
    const f = filters({
      color: 'red',
      descriptors: ['tannic', 'concentrated'], descriptors_excluded: ['supple'],
    });
    const r = await search(f, {
      ...options, queryVector: await vector(f), maxResults: 50,
    });

    expect(r.status).toBe('ok');
    expect(r.ranking).toBe('vector');

    const score = (id: string) => {
      const c = r.results.find((x) => x.id === id);
      // Fail on absence, never replace it with a value that would make the
      // comparison true.
      expect(c, `${id} missing from the ranking`).toBeDefined();
      return c!.score;
    };
    const worstStructured = Math.min(...STRUCTURED.map(score));
    const bestSupple = Math.max(...SUPPLE.map(score));
    expect(worstStructured).toBeGreaterThan(bestSupple);
  });

  it('honors the result cap without returning an empty list', async () => {
    const r = await search(filters({ color: 'red' }), options);
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.length).toBeLessThanOrEqual(config.maxResults);
  });

  it('every result carries a usable source', async () => {
    const r = await search(filters({ color: 'red' }), options);
    for (const c of r.results) {
      if (c.level === 'wine') {
        expect(c.note_source).not.toBeNull();
        expect(c.note_source!.url).toMatch(/^https?:\/\//);
      } else {
        // Fallback on the appellation profile: announcement and source required.
        expect(c.tasting_note).toBeNull();
        expect(c.appellation_profile).not.toBeNull();
      }
    }
  });

  ifOverlay('LEVEL SEPARATION: the overlay is masked, the wine stays visible', async () => {
    // This case checked the property over the WHOLE catalog, back when every
    // wine came from the overlay. The real corpus made it false in that
    // direction, which is the expected progress. The test now checks BOTH
    // sides: the overlay row is masked, the real row is intact. It is a
    // stronger witness than the old one, which also passed if the engine
    // masked everything indiscriminately.
    const r = await search(
      filters({ color: 'red' }), { allowFixtures: false, maxResults: 50 },
    );

    expect(r.status).toBe('ok');
    const overlay = r.results.filter((c) => OVERLAY_IDS.has(c.id));
    const real = r.results.filter((c) => !OVERLAY_IDS.has(c.id));

    // Without these two bounds, everything below would pass on an empty set.
    expect(overlay.length).toBeGreaterThan(0);
    expect(real.length).toBeGreaterThan(0);

    for (const c of overlay) {
      // FIELDS are masked, the row is not excluded. Excluding made the
      // system answer "empty catalog" on a catalog of five wines.
      expect(c.tasting_note, c.id).toBeNull();
      expect(c.note_source, c.id).toBeNull();
      expect(c.level, c.id).toBe('appellation');
      expect(c.appellation_profile, c.id).not.toBeNull();
      // The overlay does not only set the note: price and blend too.
      expect(c.price_eur, c.id).toBeNull();
      expect(c.blend, c.id).toHaveLength(0);
      expect(c.fixture, c.id).toBe(true);
    }
    // And a wine collected from the producer suffers none of this: with or
    // without the flag, it reads the same. Some real pages carry no note
    // (Cazeneuve): those sit on the profile because the note does not exist,
    // not because it is hidden, and the comparison holds for them too.
    const unmasked = await search(
      filters({ color: 'red' }), { allowFixtures: true, maxResults: 50 },
    );
    const byId = new Map(unmasked.results.map((c) => [c.id, c]));
    for (const c of real) {
      const same = byId.get(c.id)!;
      expect(c.fixture, c.id).toBe(false);
      expect([c.tasting_note, c.price_eur, c.blend, c.level], c.id)
        .toEqual([same.tasting_note, same.price_eur, same.blend, same.level]);
      if (c.tasting_note !== null) expect(c.note_source!.url, c.id).toMatch(/^https?:\/\//);
    }
    expect(real.some((c) => c.level === 'wine')).toBe(true);
  });

  ifOverlay('a price filter does not retain a wine whose price is masked', async () => {
    // Filtering on a value we refuse to show would be worse than excluding
    // it. The price of overlay rows does not exist here, so none of them can
    // satisfy a budget, however generous.
    const r = await search(
      filters({ color: 'red', price_max: 1000 }), { allowFixtures: false, maxResults: 50 },
    );
    // The filter does retain something: the real wines have a price.
    expect(r.results.length).toBeGreaterThan(0);
    for (const c of r.results) expect(OVERLAY_IDS.has(c.id), `${c.id} masked but retained`).toBe(false);
  });

  ifOverlay('a grape filter does not retain a wine whose blend is masked', async () => {
    const r = await search(
      filters({ color: 'red', grapes_included: ['syrah'] }),
      { allowFixtures: false, maxResults: 50 },
    );
    expect(r.results.length).toBeGreaterThan(0);
    for (const c of r.results) expect(OVERLAY_IDS.has(c.id), `${c.id} masked but retained`).toBe(false);
  });

  it('grape filters go through the join', async () => {
    const withIt = await search(filters({ color: 'red', grapes_included: ['mourvedre'] }), options);
    const without = await search(filters({ color: 'red', grapes_excluded: ['mourvedre'] }), options);

    const idsWith = new Set(withIt.results.map((c) => c.id));
    for (const c of without.results) expect(idsWith.has(c.id)).toBe(false);
    for (const c of withIt.results) {
      expect(c.blend.some((a) => a.grape === 'mourvedre')).toBe(true);
    }
  });

  it('an appellation pairing never leaks into a wine-level field', async () => {
    // That status equals 'derived' is guaranteed by a Postgres CHECK and
    // already tested in the database: checking it again here is a tautology.
    // What can really go wrong is a pairing derived from the profile being
    // presented as a characteristic of the wine.
    const r = await search(filters({ color: 'red', dish: 'lamb' }), options);
    expect(r.dishPairings.length).toBeGreaterThan(0);

    const labels = r.dishPairings.map((a) => a.label.toLowerCase());
    for (const c of r.results) {
      for (const pairing of c.producer_pairings) {
        // A producer pairing may coincide, but it must come from THEIR sheet:
        // it must not be copied from the appellation profile.
        if (labels.includes(pairing.toLowerCase())) {
          expect(c.note_source, `${c.id}: pairing without a producer source`).not.toBeNull();
        }
      }
      expect(c.tasting_note ?? '').not.toContain('DERIVE');
    }
  });
});

describe('rendering', () => {
  it('the refusal points to the designations that DO hold whites, without serving any', async () => {
    const r = await search(filters({ color: 'white' }), options);
    expect(r.results).toHaveLength(0);
    expect(r.refusal?.message).toMatch(/blancs du catalogue relevent de : AOP Languedoc, Vin de France\./);
  });

  it('every result carries its designation and tier, for the AOP badge', async () => {
    const psl = await search(filters({ color: 'red' }), { ...options, maxResults: 50 });
    expect(psl.results.length).toBeGreaterThan(0);
    for (const w of psl.results) {
      expect(w.appellation_name).toBe('Pic Saint-Loup');
      expect(w.appellation_tier).toBe('aop');
    }
    const vdf = await search(filters({ appellation: 'vin-de-france' }), { ...options, maxResults: 50 });
    expect(vdf.results.length).toBeGreaterThan(0);
    for (const w of vdf.results) expect(w.appellation_tier).toBe('vsig');
  });

  it('a white without a named designation is answered from the whole catalog', async () => {
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({ message: 'un blanc pour des huitres' });
    expect(output.status).toBe('ok');
    expect(output.search!.appliedFilters.appellation).toBeNull();
    for (const w of output.search!.results) expect(w.color).toBe('white');
  });

  it('a designation outside the catalog is refused by name, not answered empty', async () => {
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({ message: 'x', forcedFilters: { appellation: 'aoc-bordeaux' } });
    expect(output.status).toBe('refused');
    expect(output.search?.refusal?.message).toMatch(/aoc-bordeaux/);
    expect(output.search?.refusal?.message).toMatch(/AOP Pic Saint-Loup/);
    // The deterministic parser gets there too.
    const local = await runPipeline({ message: 'avez-vous un bordeaux ?' });
    expect(local.status).toBe('refused');
    expect(local.search?.results ?? []).toHaveLength(0);
  });

  it('the refusal names the appellation, it does not show its identifier', async () => {
    const r = await search(filters({ color: 'white' }), options);
    expect(r.refusal?.message).toContain('Pic Saint-Loup');
    expect(r.refusal?.message).not.toContain('aoc-pic-saint-loup');
  });
});

describe('regressions found in review', () => {
  it('GRAPE REFUSAL: a grape outside the AOC grape rules is refused, not ignored', async () => {
    // Before: normalizeFilters dropped the unresolved grape, the constraint
    // evaporated, and "avez-vous du chardonnay ?" returned three reds. Since
    // the whites entered the catalog, chardonnay is a known grape: the refusal
    // now comes from the Pic Saint-Loup grape rules when the request names it.
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({ message: 'un pic saint-loup au chardonnay' });

    expect(output.status).toBe('refused');
    expect(output.search?.results).toHaveLength(0);
    expect(output.search?.refusal?.message).toMatch(/chardonnay/i);
    expect(output.search?.refusal?.message).toMatch(/encepagement/i);
    // A refusal cites its source, like the color one.
    expect(output.search?.refusal?.source?.url).toMatch(/^https?:\/\//);
  });

  it('a grape the catalog holds outside the AOC is served, from the other designations', async () => {
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({ message: 'avez-vous du chardonnay ?' });

    expect(output.status).toBe('ok');
    expect(output.search!.appliedFilters.appellation).toBeNull();
    expect(output.search!.results.length).toBeGreaterThan(0);
    for (const w of output.search!.results) {
      expect(w.blend.map((b) => b.grape)).toContain('chardonnay');
      expect(w.appellation_tier).not.toBe('aop');
    }
  });

  it('a grape unknown to the catalog is refused as such', async () => {
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({ message: 'avez-vous du merlot ?' });
    expect(output.status).toBe('refused');
    expect(output.search?.refusal?.message).toMatch(/inconnu du catalogue : merlot/i);
  });

  it('grape rules not transcribed refuse nothing: no rule is invented', async () => {
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({
      message: 'x',
      forcedFilters: { appellation: 'vin-de-france', grapes_included: ['chardonnay'] },
    });
    expect(output.status).toBe('ok');
  });

  it('"rien de tannique" puts the structured wines last, not first', async () => {
    // End-to-end counterpart of the parser regression: the request used to
    // come back with the most tannic wines on top. It also holds the spread
    // measure: taken over the three rows shown, it fell under the threshold
    // once the catalog reached 57 wines, and this request lost its ranking.
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({ message: 'un rouge, rien de tannique' });
    expect(output.search!.ranking).toBe('vector');
    for (const w of output.search!.results) expect(STRUCTURED).not.toContain(w.id);
  });

  it('a grape of the appellation goes through normally', async () => {
    const { runPipeline } = await import('../src/pipeline.js');
    const output = await runPipeline({ message: 'un rouge a base de syrah' });
    expect(output.status).toBe('ok');
    expect(output.search!.results.length).toBeGreaterThan(0);
  });

  it('RELAXATION: the loop progresses or stops, it does not spin', async () => {
    // Before: a budget rounded to itself monopolized the ladder, announcing
    // "budget porte de 0.01 € a 0.01 €" thirteen times without ever reaching
    // the vintage rung.
    const r = await search(
      filters({ color: 'red', price_max: 0.01, vintage_min: 2022 }), options,
    );

    const announcements = r.relaxations.map((x) => x.announcement);
    expect(new Set(announcements).size).toBe(announcements.length);
    // The start and end bounds must differ. The old version used \S+, which
    // does not cross the space in "0.01 €" and could therefore never match:
    // a fake lock.
    for (const x of r.relaxations) {
      const m = /de (.+?) a (.+?)$/.exec(x.announcement);
      if (m) expect(m[1]).not.toBe(m[2]);
    }
  });

  it('LEXICOGRAPHIC RANKING: the returned set is indeed the cheapest one', async () => {
    // Before: the relevance threshold was applied AFTER the LIMIT. The engine
    // announced "ranked by price" while returning bottles selected by a
    // vector it had just deemed irrelevant, leaving out cheaper ones that met
    // every hard filter.
    //
    // The state is BUILT: every red gets its appellation profile as vector,
    // and the bottles at 20 € or more a nudge toward the request, too small
    // to count as discrimination. The vector then prefers the expensive
    // bottles, the engine rightly judges it irrelevant, and the answer must
    // be the cheapest set, not the vector's pick.
    const f = filters({ color: 'red', descriptors_excluded: ['red_fruit'] });
    const v = (await vector(f))!;
    const nudge = toVector(v.map((x) => x * 0.01));
    const { r, vectorFirst } = await inTransaction(
      `UPDATE wines w SET embedding = ap.embedding +
              (CASE WHEN w.price_eur >= 20 THEN '${nudge}'::vector ELSE '${toVector(v.map(() => 0))}'::vector END)
         FROM appellation_profiles ap
        WHERE ap.appellation_id = w.appellation_id AND ap.color = w.color AND w.embedding IS NOT NULL`,
      async (pool) => ({
        r: await search(f, { ...options, pool, queryVector: v }),
        // Without this, the case would pass on a vector that already agrees
        // with the price order, and prove nothing.
        vectorFirst: (await pool.query(
          `SELECT price_eur::float AS p FROM wines
            WHERE embedding IS NOT NULL AND appellation_id = $1 AND color = 'red'
            ORDER BY embedding <=> $2::vector LIMIT 1`, [PSL, toVector(v)],
        )).rows[0].p as number,
      }),
    );
    expect(vectorFirst).toBeGreaterThanOrEqual(20);

    expect(r.ranking).toBe('lexicographic');
    {
      const prices = r.results.map((c) => c.price_eur ?? Infinity);
      const all = await search(filters({ color: 'red' }), { ...options, maxResults: 99 });
      const expected = all.results
        .map((c) => c.price_eur ?? Infinity)
        .sort((a, b) => a - b)
        .slice(0, prices.length);
      expect(prices.slice().sort((a, b) => a - b)).toEqual(expected);
    }
  });
});

describe('regressions found in the second review', () => {
  ifOverlay('N2: absence is not inferred from ignorance', async () => {
    // "sans mourvedre" on a wine whose blend is masked: the engine asserted
    // it about a wine containing 25% of it. It is the only factually false
    // statement about a product that such an engine can produce.
    const f = filters({ color: 'red', grapes_excluded: ['mourvedre'] });
    const withOverlay = await search(f, { allowFixtures: true, maxResults: 50 });
    const withoutOverlay = await search(f, { allowFixtures: false, maxResults: 50 });

    // Known blend: the filter really discriminates.
    expect(withOverlay.results.length).toBeGreaterThan(0);
    for (const c of withOverlay.results) {
      expect(c.blend.some((a) => a.grape === 'mourvedre'), c.id).toBe(false);
    }
    // At least one overlay row passes the filter when its blend is readable:
    // without that, the next assertion would prove nothing.
    expect(withOverlay.results.some((c) => OVERLAY_IDS.has(c.id))).toBe(true);

    // Unknown blend: nothing is concluded. No overlay row may be presented as
    // "without mourvedre" when we do not know what it contains.
    for (const c of withoutOverlay.results) {
      expect(OVERLAY_IDS.has(c.id), `${c.id}: absence asserted on an unknown blend`).toBe(false);
    }
  });

  it('N6: missing data is not an absence of match', async () => {
    // "No wine under 20 €" and "I have the price of no wine" are two
    // different answers, and giving the first one for the second is an
    // unfounded statement.
    //
    // This case relied on an accident of the corpus: no price could be
    // collected without the overlay. The 15 real wines all carry one, so the
    // situation no longer happens by itself. It is BUILT inside a rolled-back
    // transaction rather than expecting the catalog to stay poor: the test
    // will survive the corpus growing, which the old one did not.
    const r = await inTransaction(
      'UPDATE wines SET price_eur = NULL',
      (pool) => search(
        filters({ color: 'red', price_max: 20 }),
        { pool, allowFixtures: true },
      ),
    );

    expect(r.status).toBe('empty');
    expect(r.undecidableFilters.map((f) => f.field)).toContain('price_max');
    // And the catalog is not empty for all that: it is the data that is
    // missing, not the wines.
    expect(r.catalogSize).toBeGreaterThan(0);
  });

  it('N6 ter: the price known for most wines does not hide the unknown price of the rest', async () => {
    // The counterpart of the previous case on the corpus as it is: prices
    // are known, so no criterion is undecidable and the engine answers.
    const r = await search(
      filters({ color: 'red', price_max: 20 }), { allowFixtures: true },
    );
    expect(r.status).toBe('ok');
    expect(r.undecidableFilters).toHaveLength(0);
    for (const c of r.results) expect(c.price_eur).toBeLessThanOrEqual(20);
  });

  it('N6 bis: a decidable criterion is not reported as undecidable', async () => {
    const r = await search(
      filters({ color: 'red', price_max: 1 }), { allowFixtures: true },
    );
    expect(r.status).toBe('empty');
    expect(r.undecidableFilters).toHaveLength(0);
  });

  it('N7: an appellation-level signal does not make a ranking of wines', async () => {
    // When every row falls back on the SAME AOC profile, their vectors are
    // identical: the order is only a tie-break, and announcing "ranked by
    // relevance" would present an appellation characteristic as a wine
    // characteristic.
    //
    // Same remark as in N6: this was the state of the fixture catalog, it no
    // longer is. It is built.
    const f = filters({ color: 'red', descriptors: ['supple'] });
    const v = await vector(f);
    const r = await inTransaction(
      `UPDATE wines SET tasting_note = NULL, tasting_note_source_id = NULL,
                       embedding_level = 'appellation', embedding = NULL`,
      (pool) => search(f, { pool, allowFixtures: true, queryVector: v }),
    );

    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((c) => c.level === 'appellation')).toBe(true);
    expect(r.ranking).toBe('lexicographic');
  });

  it('N7 bis: wine notes, on the other hand, allow vector ranking', async () => {
    // The counterpart: the N7 guard must not be so broad that it forbids any
    // ranking. On the real corpus, there is enough to rank.
    const f = filters({ color: 'red', descriptors: ['supple'], descriptors_excluded: ['tannic'] });
    const r = await search(f, {
      ...options, queryVector: await vector(f), maxResults: 50,
    });
    expect(r.results.some((c) => c.level === 'wine')).toBe(true);
    expect(r.ranking).toBe('vector');
  });

  it('a wine described by its own note ranks before one scored on the appellation profile', async () => {
    const f = filters({ color: 'rose', descriptors: ['fresh'] });
    const r = await search(f, { ...options, queryVector: await vector(f), maxResults: 50 });
    expect(r.ranking).toBe('vector');

    const levels = r.results.map((c) => c.level);
    const firstProfile = levels.indexOf('appellation');
    expect(levels.includes('wine') && firstProfile > 0).toBe(true);
    expect(levels.slice(firstProfile)).not.toContain('wine');
    // Not vacuous: on score alone, a profile row would come before a wine row.
    const best = (level: string) => Math.max(...r.results.filter((c) => c.level === level).map((c) => c.score));
    const worst = (level: string) => Math.min(...r.results.filter((c) => c.level === level).map((c) => c.score));
    expect(best('appellation')).toBeGreaterThan(worst('wine'));
  });

  it('the rejection vector really takes part in the ranking', async () => {
    // Witness of the mechanism itself: on a REJECTION-ONLY request, the query
    // vector exists only through the rejection. With rejectionWeight = 0 it
    // would be degenerate and there would be no vector ranking at all.
    //
    // maxResults covers the whole red catalog. On a top-5 out of 16 wines,
    // "the last one" is the fifth, not the lowest-ranked: the assertion would
    // no longer be about what it names.
    const f = filters({ color: 'red', descriptors_excluded: ['tannic'] });
    const v = await vector(f);
    expect(v).not.toBeNull();

    const r = await search(f, { ...options, queryVector: v, maxResults: 50 });
    expect(r.ranking).toBe('vector');

    // The wines whose note names firm tannins bring up the rear.
    const rank = (id: string) => {
      const i = r.results.findIndex((x) => x.id === id);
      expect(i, `${id} missing from the ranking`).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Among the wines described by their own note: the others come after
    // them whatever their score, and have nothing to say about tannins.
    const last = r.results.filter((x) => x.level === 'wine').at(-1)!;
    expect(STRUCTURED).toContain(last.id);
    // And a note silent about structure comes before a note that names it:
    // the rejection, and it alone, produces this order.
    expect(rank('bergerie-du-capucin-dame-jeanne-rouge-2022'))
      .toBeLessThan(rank('lancyre-grande-cuvee-2021'));
  });

  ifOverlay('every key set by the overlay is masked by the engine', async () => {
    // The masking list in RESULTS_SQL is maintained by hand: a new key in an
    // overlay file would leak silently. This test locks it for good.
    const overlayKeys = new Set(OVERLAY.flatMap((c) => c.keys));
    expect(overlayKeys.size).toBeGreaterThan(0);

    const all = await search(
      filters({ color: 'red' }), { allowFixtures: false, maxResults: 50 },
    );
    // Only overlay rows are concerned: the real wines legitimately carry
    // these same fields, and requiring them to be null everywhere would make
    // this test pass for a blanket masking.
    const r = { results: all.results.filter((c) => OVERLAY_IDS.has(c.id)) };
    expect(r.results.length).toBeGreaterThan(0);

    // Mapping between the overlay keys and the result fields.
    const projection: Record<string, (c: (typeof r.results)[number]) => unknown> = {
      tasting_note: (c) => c.tasting_note,
      tasting_note_source: (c) => c.note_source,
      producer_pairings: (c) => (c.producer_pairings.length ? c.producer_pairings : null),
      price_eur: (c) => c.price_eur,
      price_as_of: (c) => c.price_as_of,
      abv: (c) => c.abv,
      organic: (c) => c.organic,
      certification: (c) => c.certification,
      aging: (c) => c.aging,
      blend: (c) => (c.blend.length ? c.blend : null),
    };

    for (const key of overlayKeys) {
      const read = projection[key];
      expect(read, `overlay key "${key}" not covered by this test`).toBeDefined();
      for (const c of r.results) {
        expect(read!(c), `${c.id}.${key} should be masked`).toBeNull();
      }
    }
  });
});
