/**
 * French wine lexicon.
 *
 * Two uses, both confined to configuration (the engine never sees it
 * hard-coded):
 *  1. token expansion for the local embedding provider, which has no
 *     pre-trained model to know that "souple" and "fondu" are close;
 *  2. the deterministic parser of degraded mode (src/llm/local.ts), when no
 *     LLM is reachable or its output does not validate against the schema.
 *
 * Changing business domain = replacing this file.
 *
 * Keys are English codes; terms and labels are French, and stay so: they are
 * matched against French requests and French tasting notes, and the labels
 * are shown to French-speaking visitors. Terms are written without accents
 * because every text is normalized before matching (see `normalize`).
 */

export interface DescriptorFamily {
  /** Display label, in French. */
  readonly label: string;
  readonly terms: readonly string[];
}

/** Descriptor families. Members of a family attract each other under cosine. */
export const FAMILIES: Record<string, DescriptorFamily> = {
  tannic: { label: 'tannique', terms: ['tannique', 'tanin', 'tanins', 'charpente', 'charpentee', 'structure', 'structuree', 'serre', 'serree', 'corse', 'puissant', 'ferme', 'austere', 'muscle', 'robuste'] },
  supple: { label: 'souple', terms: ['souple', 'souplesse', 'fondu', 'rond', 'ronde', 'rondeur', 'soyeux', 'veloute', 'moelleux', 'coulant', 'gouleyant', 'caressant', 'fin', 'delicat', 'tendre'] },
  fresh: { label: 'frais', terms: ['frais', 'fraiche', 'fraicheur', 'vif', 'vive', 'tendu', 'nerveux', 'acidite', 'croquant', 'eclatant', 'minerale', 'mineral', 'salin'] },
  red_fruit: { label: 'fruits rouges', terms: ['fruits rouges', 'cerise', 'fraise', 'framboise', 'groseille', 'griotte', 'fruit rouge'] },
  black_fruit: { label: 'fruits noirs', terms: ['fruits noirs', 'mure', 'cassis', 'myrtille', 'prunelle', 'fruit noir'] },
  spice: { label: 'epices', terms: ['epice', 'epices', 'epicee', 'poivre', 'reglisse', 'cannelle', 'muscade', 'girofle', 'poivre noir'] },
  garrigue: { label: 'garrigue', terms: ['garrigue', 'thym', 'romarin', 'laurier', 'ciste', 'herbes', 'herbes seches', 'menthol'] },
  oak: { label: 'boise', terms: ['boise', 'fut', 'barrique', 'chene', 'vanille', 'torrefaction', 'cacao', 'grille', 'toaste', 'fume'] },
  floral: { label: 'floral', terms: ['floral', 'violette', 'pivoine', 'rose', 'fleurs'] },
  concentrated: { label: 'concentre', terms: ['concentre', 'dense', 'riche', 'ample', 'genereux', 'puissant', 'puissance', 'profond'] },
  light: { label: 'leger', terms: ['leger', 'legere', 'aerien', 'subtil', 'fluide', 'digeste'] },
  ageworthy: { label: 'de garde', terms: ['garde', 'vieillissement', 'potentiel', 'evolution', 'tenue'] },
};

/**
 * Minimal French suffix stripping.
 *
 * Without it, "fondus" does not match "fondu" and "coulante" does not match
 * "coulant": tasting notes agree with the noun they qualify, the lexicon is in
 * the masculine singular, and ranking misses half of its matches. Three rules
 * are enough on this corpus; it is not a general-purpose stemmer and does not
 * have to be.
 *
 * Applied on BOTH sides (lexicon and text), so any over-truncation stays
 * symmetric and has no effect on matching.
 */
export function stem(word: string): string {
  let t = word;
  if (t.length > 4 && t.endsWith('aux')) t = t.slice(0, -3) + 'al';
  if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1);
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/** Stem -> family. Built once. */
export const FAMILY_BY_STEM: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [family, { terms }] of Object.entries(FAMILIES)) {
    for (const term of terms) {
      m.set(term.split(' ').map(stem).join(' '), family);
    }
  }
  return m;
})();

/** French stop words + noise specific to requests for advice. */
export const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l', 'et', 'ou', 'a', 'au', 'aux',
  'en', 'pour', 'avec', 'sans', 'sur', 'dans', 'par', 'plus', 'moins', 'tres', 'trop', 'pas',
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'cherche', 'voudrais', 'aimerais',
  'veux', 'faut', 'sur', 'qui', 'que', 'quoi', 'est', 'sont', 'ce', 'cette', 'ces', 'son',
  'sa', 'ses', 'leur', 'mon', 'ma', 'mes', 'vin', 'bouteille', 'vins', 'bouteilles',
]);

export type PairingCategory = 'meat' | 'cheese' | 'fish' | 'other';

export interface Dish {
  /** Display label, in French. */
  readonly label: string;
  /** Pairing category in appellation_pairings. */
  readonly category: PairingCategory;
  readonly terms: readonly string[];
}

/** Recognized dishes -> pairing category in appellation_pairings. */
export const DISHES: Record<string, Dish> = {
  lamb: { label: 'agneau', category: 'meat', terms: ['agneau', 'gigot', 'souris d agneau', 'cotelettes'] },
  beef: { label: 'boeuf', category: 'meat', terms: ['boeuf', 'entrecote', 'cote de boeuf', 'grillade', 'grillades', 'steak'] },
  game: { label: 'gibier', category: 'meat', terms: ['gibier', 'sanglier', 'chevreuil', 'perdreau', 'faisan'] },
  stew: { label: 'daube', category: 'meat', terms: ['daube', 'mijote', 'ragout', 'civet', 'pot au feu'] },
  poultry: { label: 'volaille', category: 'meat', terms: ['volaille', 'poulet', 'magret', 'canard', 'pintade'] },
  charcuterie: { label: 'charcuterie', category: 'meat', terms: ['charcuterie', 'saucisson', 'jambon', 'pate'] },
  cheese: { label: 'fromage', category: 'cheese', terms: ['fromage', 'pelardon', 'roquefort', 'tomme', 'chevre', 'brebis'] },
  // 'loup' (sea bass) is deliberately absent: the appellation is called Pic
  // Saint-Loup, and any request naming it ended up classified as a fish
  // pairing. The cost of a false positive here outweighs the gain of a true
  // positive.
  fish: { label: 'poisson', category: 'fish', terms: ['poisson', 'brandade', 'bourride', 'tielle', 'daurade', 'bar de ligne', 'saumon', 'thon', 'cabillaud'] },
  aperitif: { label: 'aperitif', category: 'other', terms: ['aperitif', 'apero', 'tapas', 'grignotage'] },
};

/**
 * Common grape varieties that no wine of the catalog can contain: they are in
 * neither db/seed/grapes.json nor any blend.
 *
 * Without this list, "avez-vous du merlot ?" produced no filter to refuse: the
 * parser only recognized the catalog's varieties, the constraint evaporated,
 * and the system answered with three reds. Naming them lets the engine REFUSE
 * instead of serving something close.
 *
 * The white varieties of the neighbouring designations (chardonnay,
 * vermentino, roussanne...) left this list when those wines entered the
 * catalog: they are now real grapes, recognized through grapes.json, and the
 * Pic Saint-Loup refusal comes from its grape rules instead.
 *
 * To be extended according to the requests actually received; it does not
 * have to be exhaustive to be useful.
 */
export const GRAPES_OUTSIDE_CATALOG = [
  'chenin', 'riesling', 'gewurztraminer',
  'pinot noir', 'cabernet sauvignon', 'cabernet franc', 'merlot', 'gamay',
  'malbec', 'tannat', 'nebbiolo', 'sangiovese', 'tempranillo',
  'terret', 'aligote',
];

/**
 * These names are PROPER NOUNS and do not go through stem().
 *
 * stem() strips the final 'e', so 'aligote' became 'aligot' — and "un rouge
 * pour un aligot" (aligot is a potato-and-cheese dish) triggered a
 * grape-variety refusal, confident, explicit and INAO-sourced, on a dish. The
 * same failure mode as "viande blanche" (white meat read as white wine),
 * through another door.
 *
 * Accepted consequence: a variety written in the plural is not recognized.
 * Missing a refusal costs less than a wrong refusal.
 */
export const GRAPES_OUTSIDE_CATALOG_EXACT = new Set(
  GRAPES_OUTSIDE_CATALOG.map(normalize),
);

/**
 * Designations a visitor may ask for and the catalog does not hold, with the
 * words that name them. Recognized so that "un bordeaux" gets the designation
 * refusal instead of three wines picked on nothing.
 *
 * Bare names only where they cannot be something else: "bourgogne" alone is
 * also the escargots, "provence" the herbs, "alsace" the choucroute. Those
 * need the article, or are left out.
 */
export const DESIGNATIONS_OUTSIDE_CATALOG: readonly { id: string; aliases: readonly string[] }[] = [
  { id: 'bordeaux', aliases: ['bordeaux'] },
  { id: 'bourgogne', aliases: ['un bourgogne', 'du bourgogne'] },
  { id: 'champagne', aliases: ['champagne'] },
  { id: 'chablis', aliases: ['chablis'] },
  { id: 'beaujolais', aliases: ['beaujolais'] },
  { id: 'sancerre', aliases: ['sancerre'] },
  { id: 'cotes-du-rhone', aliases: ['cotes du rhone'] },
  { id: 'chateauneuf-du-pape', aliases: ['chateauneuf du pape'] },
  { id: 'cotes-de-provence', aliases: ['cotes de provence'] },
  { id: 'rioja', aliases: ['rioja'] },
  { id: 'cahors', aliases: ['cahors'] },
  // Neighbours in the Languedoc, as likely to be asked here as they are absent.
  { id: 'faugeres', aliases: ['faugeres'] },
  { id: 'saint-chinian', aliases: ['saint chinian'] },
  { id: 'terrasses-du-larzac', aliases: ['terrasses du larzac'] },
  { id: 'minervois', aliases: ['minervois'] },
  { id: 'corbieres', aliases: ['corbieres'] },
];

/** Strips accents and lowercases. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Tokenizes, dropping stop words. Useful bigrams are kept. */
export function tokenize(text: string): string[] {
  const base = normalize(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);

  const bigrams: string[] = [];
  for (let i = 0; i < base.length - 1; i++) {
    const bigram = `${base[i]} ${base[i + 1]}`;
    if (FAMILY_BY_STEM.has(bigram)) bigrams.push(bigram);
  }
  return [...base, ...bigrams];
}

/**
 * Opposite families. Used to handle NEGATION.
 *
 * A bag of words cannot negate: "pas trop tannique" (not too tannic) and
 * "tannique" share the same dimensions. Negation is therefore resolved
 * upstream, at parsing time, by replacing the negated descriptor with its
 * declared opposite. It is an explicit choice rather than a hope placed in
 * the vector space.
 */
export const OPPOSITES: Record<string, string> = {
  tannic: 'supple',
  supple: 'tannic',
  concentrated: 'light',
  light: 'concentrated',
  oak: 'fresh',
};

/**
 * Negation or attenuation markers.
 *
 * Looked up among the words that PRECEDE a descriptor, never by substring:
 * "euros" contains "ros", the stem of "rose", so a raw includes() classified
 * a budget request into the floral family.
 *
 * "plus" is deliberately absent: "plus de tanins" asks for more.
 */
export const NEGATION_MARKERS = new Set([
  'pas', 'peu', 'sans', 'moins', 'trop', 'aucun', 'aucune', 'eviter', 'evite', 'ni', 'rien',
]);

/** Scope of a marker, in number of words to the right. */
export const NEGATION_SCOPE = 3;

/**
 * Splits into full words: stop words kept, stems applied.
 *
 * Elision fragments are dropped: "n'", "d'", "l'", "qu'" are not words and
 * must not consume distance. Without this filter, "je n'ai pas envie d'un
 * blanc" (I don't feel like a white) put "pas" outside the negation window,
 * and the request came out as a refusal of white. French is full of them.
 */
const ELISIONS = new Set(['qu']);

export function words(text: string): { raw: string[]; stems: string[] } {
  const raw = normalize(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !ELISIONS.has(w));
  return { raw, stems: raw.map(stem) };
}
