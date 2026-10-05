import {
  DISHES, FAMILIES, FAMILY_BY_STEM, GRAPES_OUTSIDE_APPELLATION_EXACT,
  NEGATION_MARKERS, NEGATION_SCOPE, OPPOSITES, normalize, stem, words,
} from '../config/lexicon.js';
import { EMPTY_FILTERS, FiltersSchema, type Filters } from '../schema/filters.js';

/**
 * Deterministic parser, French -> filters.
 *
 * Two roles:
 *  - "local" LLM provider, to run the prototype without an API key;
 *  - DEGRADED MODE of the real provider, when the model returns twice in a
 *    row an output that does not validate against the strict schema.
 *
 * The brief left this degraded mode undefined (§4). Here it is: no vague
 * answer, a rule-based parsing announced as such in the UI.
 */

export interface ParserOptions {
  defaultAppellation?: string | null;
  /** Normalized name or synonym -> grape code, to recognize "shiraz". */
  grapeIndex?: ReadonlyMap<string, string>;
}

const RE_PRICE_MAX = /(?:moins de|jusqu'?a|max(?:imum)?|sous|budget de|autour de|environ|vers)\s*(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros?)?/i;
const RE_PRICE_BARE = /(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros?)/i;
const RE_PRICE_MIN = /(?:plus de|a partir de|mini(?:mum)?|au moins)\s*(\d+(?:[.,]\d+)?)\s*(?:€|eur|euros?)?/i;
const RE_VINTAGE = /\b(19[5-9]\d|20[0-4]\d)\b/g;

export function parseMessage(message: string, options: ParserOptions = {}): Filters {
  const text = normalize(message);
  const draft: Record<string, unknown> = { ...EMPTY_FILTERS };

  const split = words(message);

  // --- color ---------------------------------------------------------------
  // Three traps, all of them hit:
  //  - "blanche" is not "blanc": a white meat ("viande blanche") triggered an
  //    appellation refusal, confident, explicit and sourced. The worst
  //    failure mode.
  //  - "un rouge pour une viande blanche": the red is the subject, it wins.
  //  - "surtout pas un blanc" (certainly not a white): color must go through
  //    negation like grape varieties and descriptors.
  const COLORS: [string, RegExp][] = [
    ['red', /\brouges?\b/],
    ['rose', /\bros[ée]e?s?\b/],
    ['white', /\bblancs?\b/],
  ];
  let colorPosition = -1;
  for (const [code, pattern] of COLORS) {
    // The position must be looked up in the SAME token space as the one
    // isNegated() indexes. Counting the spaces of `text` shifted the window by
    // one per apostrophe, since split.raw also cuts on them: "pour
    // l'anniversaire d'un ami, pas de blanc" came out as white, hence as a
    // refusal, on a message that literally says "pas de blanc" (no white).
    const position = split.raw.findIndex((word) => pattern.test(word));
    if (position === -1) continue;
    if (isNegated(split.raw, position)) continue;
    draft.color = code;
    colorPosition = position;
    break;
  }

  // --- price ---------------------------------------------------------------
  const min = RE_PRICE_MIN.exec(text);
  if (min) draft.price_min = Number(min[1]!.replace(',', '.'));

  const max = RE_PRICE_MAX.exec(text);
  if (max) {
    draft.price_max = Number(max[1]!.replace(',', '.'));
  } else {
    const bare = RE_PRICE_BARE.exec(text);
    // A bare amount is read as a ceiling: it is the most frequent reading of
    // a budget expressed in conversation.
    if (bare && draft.price_min === null) draft.price_max = Number(bare[1]!.replace(',', '.'));
  }

  // --- vintage -------------------------------------------------------------
  const years = [...text.matchAll(RE_VINTAGE)].map((m) => Number(m[1]));
  if (years.length === 1) {
    draft.vintage_min = years[0];
    draft.vintage_max = years[0];
  } else if (years.length >= 2) {
    draft.vintage_min = Math.min(...years);
    draft.vintage_max = Math.max(...years);
  }

  // --- organic -------------------------------------------------------------
  if (/\bbio\b|\bbiologique\b|\bagriculture biologique\b/.test(text)) draft.organic = true;

  // --- grape varieties -----------------------------------------------------
  if (options.grapeIndex) {
    const byStem = new Map<string, string>();
    for (const [synonym, code] of options.grapeIndex) {
      if (synonym.length < 4) continue;
      byStem.set(synonym.split(' ').map(stem).join(' '), code);
    }
    const included = new Set<string>();
    const excluded = new Set<string>();
    const seen = new Set<number>();

    // A recognized bigram consumes its position: otherwise "cabernet
    // sauvignon" also made "sauvignon" match, and the refusal named two
    // varieties where the user had written one.
    const keep = (code: string, position: number, length: number) => {
      for (let i = position; i < position + length; i++) seen.add(i);
      (isNegated(split.raw, position) ? excluded : included).add(code);
    };

    for (const { key, position, length } of ngrams(split.stems)) {
      if (seen.has(position)) continue;
      const code = byStem.get(key);
      if (code) keep(code, position, length);
    }

    // Varieties outside the appellation are recognized DELIBERATELY, to
    // produce a sourced refusal rather than let the constraint evaporate. On
    // the exact form, never by stem: see GRAPES_OUTSIDE_APPELLATION_EXACT.
    for (const { key, position, length } of ngrams(split.raw)) {
      if (seen.has(position)) continue;
      if (GRAPES_OUTSIDE_APPELLATION_EXACT.has(key)) keep(key, position, length);
    }
    draft.grapes_included = [...included].filter((g) => !excluded.has(g)).sort();
    draft.grapes_excluded = [...excluded].sort();
  }

  // --- dish ----------------------------------------------------------------
  for (const [key, dish] of Object.entries(DISHES)) {
    if (dish.terms.some((t) => text.includes(normalize(t)))) {
      draft.dish = key;
      break;
    }
  }

  // --- descriptors, with explicit resolution of negation ---------------------
  const descriptors = new Set<string>();
  const rejected = new Set<string>();
  for (const { key, position, length } of ngrams(split.stems)) {
    // The word that was used to read the COLOR is not reused as a descriptor.
    // "un rose" added the floral family, because stem("rose") is "ros" and the
    // rose is a flower of the lexicon: the request left biased towards floral
    // notes nobody had asked for. Same class as the "euros" -> "rose" fixed
    // earlier, except that here the word is the one we think it is — it is
    // just already consumed.
    if (colorPosition >= position && colorPosition < position + length) continue;
    const family = FAMILY_BY_STEM.get(key);
    if (!family) continue;
    if (isNegated(split.raw, position)) {
      // Two distinct effects, and both matter: we want the opposite, AND we
      // want to penalize what is rejected. Settling for the opposite does not
      // separate notes that all contain the negated term.
      rejected.add(family);
      const opposite = OPPOSITES[family];
      if (opposite) descriptors.add(opposite);
    } else {
      descriptors.add(family);
    }
  }
  draft.descriptors = [...descriptors].filter((d) => !rejected.has(d)).sort().slice(0, 8);
  draft.descriptors_excluded = [...rejected].sort().slice(0, 8);

  // --- appellation ---------------------------------------------------------
  if (options.defaultAppellation) draft.appellation = options.defaultAppellation;

  const parsed = FiltersSchema.safeParse(draft);
  if (!parsed.success) {
    // The fallback parser must never be the cause of a failure: we fall back
    // to empty filters rather than propagate an error.
    return { ...EMPTY_FILTERS, appellation: options.defaultAppellation ?? null };
  }
  return parsed.data;
}

/**
 * Enumerates the unigrams and bigrams of the message with their position.
 * The bigram is tried first: "fruits rouges" must win over "rouges".
 */
function* ngrams(
  tokens: string[],
): Generator<{ key: string; position: number; length: number }> {
  for (let i = 0; i < tokens.length; i++) {
    if (i + 1 < tokens.length) {
      yield { key: `${tokens[i]} ${tokens[i + 1]}`, position: i, length: 2 };
    }
    yield { key: tokens[i]!, position: i, length: 1 };
  }
}

/** Does a negation marker appear among the preceding words? */
function isNegated(raw: string[], position: number): boolean {
  for (let i = Math.max(0, position - NEGATION_SCOPE); i < position; i++) {
    if (NEGATION_MARKERS.has(raw[i]!)) return true;
  }
  return false;
}

/**
 * Texts to embed for the fuzzy part.
 *
 * Each family is expanded back into its members: the query vector covers the
 * whole lexical field, not only the keyword that was typed.
 */
export function vectorText(filters: Filters): { included: string; excluded: string | null } | null {
  if (filters.descriptors.length === 0 && filters.descriptors_excluded.length === 0) return null;
  const expand = (list: string[]) => list.flatMap((d) => FAMILIES[d]?.terms ?? [d]).join(' ');
  return {
    included: expand(filters.descriptors),
    excluded: filters.descriptors_excluded.length ? expand(filters.descriptors_excluded) : null,
  };
}
