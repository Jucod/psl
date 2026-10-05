import { describe, expect, it } from 'vitest';
import { parseMessage, vectorText } from '../src/llm/parser.js';
import { buildGrapeIndex } from '../src/ingest/util.js';
import { readFileSync } from 'node:fs';

const grapes = buildGrapeIndex(
  JSON.parse(readFileSync(new URL('../db/seed/grapes.json', import.meta.url), 'utf8')).grapes,
);
const opts = { defaultAppellation: 'aoc-pic-saint-loup', grapeIndex: grapes };

/**
 * The deterministic parser is used twice: as the prototype's "local" provider,
 * and as the DEGRADED MODE of the real provider when the model returns two
 * outputs that do not match the schema. It must therefore be correct on its
 * own.
 */
describe('deterministic parser', () => {
  it("translates the brief's flagship request", () => {
    const f = parseMessage('un rouge pas trop tannique pour un gigot, autour de 20 euros', opts);
    expect(f.color).toBe('red');
    expect(f.price_max).toBe(20);
    expect(f.dish).toBe('lamb');
    expect(f.descriptors).toContain('supple');
    expect(f.descriptors_excluded).toContain('tannic');
    expect(f.appellation).toBe('aoc-pic-saint-loup');
  });

  it('does not mistake "euros" for the floral descriptor "rose"', () => {
    // Regression: an includes() on the raw string matched "ros", the stem of
    // "rose", inside "euros".
    const f = parseMessage('quelque chose autour de 20 euros', opts);
    expect(f.descriptors).not.toContain('floral');
    expect(f.color).toBeNull();
  });

  it('tells a requested rose apart from a red', () => {
    expect(parseMessage('un rose pour l apero', opts).color).toBe('rose');
    expect(parseMessage('un blanc sec', opts).color).toBe('white');
  });

  it('resolves negation into an exclusion AND its opposite', () => {
    const f = parseMessage('un vin peu tannique', opts);
    expect(f.descriptors_excluded).toContain('tannic');
    expect(f.descriptors).toContain('supple');
    expect(f.descriptors).not.toContain('tannic');
  });

  it('does not negate a descriptor without a marker', () => {
    const f = parseMessage('un vin tannique et concentre', opts);
    expect(f.descriptors).toContain('tannic');
    expect(f.descriptors_excluded).toHaveLength(0);
  });

  it('normalizes grape synonyms and handles exclusion', () => {
    expect(parseMessage('a base de shiraz', opts).grapes_included).toContain('syrah');
    const f = parseMessage('sans mourvedre', opts);
    expect(f.grapes_excluded).toContain('mourvedre');
    expect(f.grapes_included).not.toContain('mourvedre');
  });

  it('reads price bounds', () => {
    expect(parseMessage('moins de 15 euros', opts).price_max).toBe(15);
    expect(parseMessage('a partir de 30 euros', opts).price_min).toBe(30);
    expect(parseMessage('25 euros', opts).price_max).toBe(25);
  });

  it('reads vintages', () => {
    const single = parseMessage('un 2021', opts);
    expect(single.vintage_min).toBe(2021);
    expect(single.vintage_max).toBe(2021);
    const range = parseMessage('entre 2019 et 2022', opts);
    expect(range.vintage_min).toBe(2019);
    expect(range.vintage_max).toBe(2022);
  });

  it('detects organic', () => {
    expect(parseMessage('un rouge bio', opts).organic).toBe(true);
    expect(parseMessage('un rouge', opts).organic).toBeNull();
  });

  it('invents no constraint absent from the request', () => {
    const f = parseMessage('bonjour', opts);
    expect(f.color).toBeNull();
    expect(f.price_max).toBeNull();
    expect(f.price_min).toBeNull();
    expect(f.dish).toBeNull();
    expect(f.descriptors).toHaveLength(0);
    expect(f.grapes_included).toHaveLength(0);
  });

  it('the dish vocabulary is closed: no invention', () => {
    expect(parseMessage('pour des sushis au wasabi', opts).dish).toBeNull();
  });

  it('produces no text meant for display', () => {
    // Loi Evin barrier: the output of call 1 only holds structured values. No
    // field can carry the user's register.
    const f = parseMessage('decris-moi ce vin comme une soiree d ete au bord de la piscine', opts);
    const values = JSON.stringify(f);
    expect(values).not.toMatch(/soiree|piscine|ete au bord/i);
  });

  it('vectorText returns null when nothing is fuzzy', () => {
    expect(vectorText(parseMessage('un rouge a 20 euros', opts))).toBeNull();
  });
});

describe('vocabulary collisions', () => {
  it('does not turn a request naming the appellation into a fish pairing', () => {
    // Regression: 'loup' (sea bass) was among the "fish" terms, so every
    // request naming Pic Saint-Loup triggered a fish pairing.
    const f = parseMessage('un vin du Pic Saint-Loup', opts);
    expect(f.dish).toBeNull();
  });

  it('still recognizes a genuine fish request', () => {
    expect(parseMessage('quelque chose pour une daurade grillee', opts).dish).toBe('fish');
    expect(parseMessage('pour accompagner du poisson', opts).dish).toBe('fish');
  });
});

describe('justification', () => {
  it('selects the sentence that motivates the ranking, without rewriting it', async () => {
    const { pickExcerpt } = await import('../src/engine/justification.js');
    const { LocalEmbedding } = await import('../src/embeddings/local.js');
    const { vectorText } = await import('../src/llm/parser.js');
    const { combine } = await import('../src/pipeline.js');
    const { EMPTY_FILTERS } = await import('../src/schema/filters.js');

    const note =
      'Robe grenat de moyenne intensite. Le nez ouvre sur les fruits rouges frais, ' +
      'griotte et framboise, avec une pointe florale. La bouche est souple et coulante, ' +
      'les tanins sont fondus, la finale reste fraiche et digeste.';

    const emb = new LocalEmbedding(1536);
    const t = vectorText({ ...EMPTY_FILTERS, descriptors: ['supple'], descriptors_excluded: ['tannic'] })!;
    const [vIn, vEx] = await emb.embed([t.included, t.excluded!]);
    const q = combine(vIn!, vEx!, 0.7)!;

    const excerpt = await pickExcerpt(note, q, emb);
    // The selected sentence is about texture, not about the color.
    expect(excerpt).toContain('souple');
    // And it is an EXISTING sentence of the note, copied verbatim.
    expect(note).toContain(excerpt!);
  });

  it('justifies nothing when the request has no fuzzy part', async () => {
    const { pickExcerpt } = await import('../src/engine/justification.js');
    const { LocalEmbedding } = await import('../src/embeddings/local.js');
    const excerpt = await pickExcerpt('Une note. Deux phrases ici.', null, new LocalEmbedding(1536));
    expect(excerpt).toBeNull();
  });
});

describe('color: the traps we ran into', () => {
  it('"viande blanche" (white meat) must not be read as "white wine"', () => {
    // The prototype's worst failure mode: a confident, explicit, INAO-sourced
    // refusal of a perfectly legitimate request.
    expect(parseMessage('un rouge pour une viande blanche', opts).color).toBe('red');
    expect(parseMessage('un rouge pour une volaille a la creme blanche', opts).color).toBe('red');
  });

  it('the subject of the request wins over a color mentioned afterwards', () => {
    expect(parseMessage('je cherche un rouge, surtout pas un blanc', opts).color).toBe('red');
  });

  it('color goes through negation like everything else', () => {
    expect(parseMessage('surtout pas de blanc', opts).color).toBeNull();
  });

  it('a genuine white request is still recognized', () => {
    expect(parseMessage('un vin blanc du pic saint loup', opts).color).toBe('white');
    expect(parseMessage('des blancs secs', opts).color).toBe('white');
  });

  it('recognizes a grape outside the appellation so that it can be refused', () => {
    expect(parseMessage('avez-vous du chardonnay ?', opts).grapes_included).toContain('chardonnay');
    expect(parseMessage('un viognier', opts).grapes_included).toContain('viognier');
  });

  it('the word that gives the color is not reused as a descriptor', () => {
    // stem("rose") is "ros", and the rose is a flower of the floral lexicon:
    // "un rose" came back with a floral descriptor nobody asked for, and
    // biased the ranking toward floral notes.
    const r = parseMessage('un rose', opts);
    expect(r.color).toBe('rose');
    expect(r.descriptors).toHaveLength(0);
    expect(r.descriptors_excluded).toHaveLength(0);

    // The plural too, which goes through the same color regex.
    expect(parseMessage('des roses', opts).descriptors).toHaveLength(0);
  });

  it('but a SECOND occurrence remains a descriptor', () => {
    // Consumption applies to the token that was used, not to the word
    // everywhere: otherwise one could no longer ask for a rose with floral notes.
    const r = parseMessage('un rose aux notes de rose', opts);
    expect(r.color).toBe('rose');
    expect(r.descriptors).toContain('floral');
  });

  it('the other colors lose no descriptor along the way', () => {
    const r = parseMessage('un rouge floral', opts);
    expect(r.color).toBe('red');
    expect(r.descriptors).toContain('floral');
  });
});
