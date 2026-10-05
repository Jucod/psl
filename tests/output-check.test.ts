import { describe, expect, it } from 'vitest';
import { checkOutput } from '../src/llm/output-check.js';
import type { WineResult } from '../src/engine/types.js';

function wine(p: Partial<WineResult>): WineResult {
  return {
    id: 'x', name: 'X', producer: 'Domaine X', producer_id: 'x', commune: null,
    appellation_id: 'aoc-pic-saint-loup', color: 'red', vintage: 2022,
    abv: null, aging: null, price_eur: null, price_as_of: null, organic: null,
    certification: null, blend: [], page_url: null,
    tasting_note: null, note_source: null, producer_pairings: [],
    level: 'wine', appellation_profile: null, score: 0, fixture: false,
    relevant_excerpt: null,
    ...p,
  };
}

const ARBOUSE = wine({
  id: 'arbouse', name: "L'Arbouse", producer: 'Mas Bruguiere',
  aging: '12 mois en foudre',
  tasting_note:
    'La bouche est souple et coulante, les tanins sont fondus, la finale reste fraiche.',
});
const VIGNES = wine({
  id: 'vignes', name: 'Vieilles Vignes', producer: 'Chateau de Lancyre',
  tasting_note: 'Bouche dense et charpentee, tanins presents et serres.',
});

/**
 * The project applies the same rule at both ends: at ingestion, an extracted
 * note must appear literally in the PDF; at the output, a quote must appear
 * literally in the passage provided.
 */
describe('output check', () => {
  it('accepts a literal quote', () => {
    const text =
      "Mas Bruguiere, L'Arbouse 2022. « La bouche est souple et coulante, les tanins sont fondus »";
    expect(checkOutput(text, [ARBOUSE])).toHaveLength(0);
  });

  it('rejects a reworded quote, even one faithful to the meaning', () => {
    // The trap: it is true, it is close, and it is not what the producer
    // wrote. The rule does not judge meaning, it checks the letter.
    const text = "Mas Bruguiere, L'Arbouse. « La bouche se montre souple, aux tanins fondus »";
    const a = checkOutput(text, [ARBOUSE]);
    expect(a.map((x) => x.type)).toContain('non_literal_quote');
  });

  it('rejects a purely invented quote', () => {
    const text = "L'Arbouse : « Des notes de truffe blanche et de cuir patine. »";
    expect(checkOutput(text, [ARBOUSE]).length).toBeGreaterThan(0);
  });

  it('CROSS ATTRIBUTION: rejects a note attributed to the wrong wine', () => {
    // The global per-family check let this case through: "tannique" was
    // allowed because ANOTHER note contained it. Scoping per reference is
    // what catches it.
    const text =
      "Mas Bruguiere, L'Arbouse 2022 presente des tanins fermes et une bouche dense et charpentee.";
    const a = checkOutput(text, [ARBOUSE, VIGNES]);
    expect(a.map((x) => x.type)).toContain('unsupported_descriptor');
    expect(a.some((x) => x.detail.includes('arbouse'))).toBe(true);
  });

  it('does not reject a technical fact taken from the reference data', () => {
    // False positive fixed along the way: "foudre" belongs to the oak family,
    // absent from the note but present in the aging field provided.
    const text = "Mas Bruguiere, L'Arbouse 2022, elevage 12 mois en foudre.";
    expect(checkOutput(text, [ARBOUSE])).toHaveLength(0);
  });

  it('does not saturate when several notes cover the lexicon', () => {
    // This is how the previous check broke down: with enough notes, the
    // allowed set covered the whole lexicon and nothing could be rejected.
    const text =
      "Mas Bruguiere, L'Arbouse 2022 : une bouche dense, charpentee, aux tanins serres.";
    expect(checkOutput(text, [ARBOUSE, VIGNES]).length).toBeGreaterThan(0);
  });

  it('the evocative register is NOT covered, and that must be said explicitly', () => {
    // This check serves the "no invention" contract, not the loi Evin. The
    // lexicon contains no mood words, so nothing is rejected here. The limit
    // is stated in the README rather than hidden behind a test that would give
    // an illusion of coverage.
    const text = "Mas Bruguiere, L'Arbouse 2022. Une soiree d ete entre amis, a partager.";
    expect(checkOutput(text, [ARBOUSE]).filter((a) => a.type === 'unsupported_descriptor'))
      .toHaveLength(0);
  });
});
