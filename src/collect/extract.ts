import { createHash } from 'node:crypto';
import { FAMILY_BY_STEM, normalize, tokenize } from '../config/lexicon.js';
import { inspectNote } from '../ingest/quarantine.js';
import { slug } from '../ingest/util.js';
import type { Wine } from '../schema/wine.js';
import type { RawProduct } from './platforms.js';

/**
 * Turns a shop product into a CANDIDATE wine, for human review.
 *
 * The rule of the whole project applies here: nothing descriptive is written
 * that is not on the page. The tasting note is made of sentences copied as
 * they are from the product text; structured fields come from patterns or
 * from the shop's own data; anything uncertain is left null and flagged.
 * A candidate never reaches the catalog without `npm run collect:promote`.
 */

export interface Producer {
  id: string;
  name: string;
  website: string;
}

/**
 * A wine as extracted. The appellation and the color stay null when the page
 * does not settle them: the reviewer sets them, and promotion refuses the file
 * until then.
 */
export type CandidateWine = Omit<Wine, 'appellation_id' | 'color'> & {
  appellation_id: string | null;
  color: Wine['color'] | null;
};

export interface Candidate {
  wine: CandidateWine;
  /** What the reviewer must look at before promoting. */
  flags: string[];
  /** What the reviewer must decide: promotion is refused until it is done. */
  toComplete: string[];
  /** The product text the note was taken from, for the verbatim check. */
  sourceText: string;
}

export type Extraction =
  | { kind: 'candidate'; candidate: Candidate }
  | { kind: 'excluded'; title: string; url: string; reason: string };

/**
 * Not a bottle of wine: packs and gift boxes, accessories, events and visits
 * sold through the shop, and the estate's other products. Every entry comes
 * from a product actually met in a shop of the directory.
 */
const NOT_A_BOTTLE = new RegExp([
  /coffret|carton|caisse|\blot\b|\bpack\b|offre decouverte|assortiment|colis/,
  /verres?\b|tire-bouchon|carte cadeau|bon cadeau|gift ?card|bag[- ]in[- ]box|\bbib\b|cubi|abonnement/,
  /degustation|visite|atelier|workshop|escape game|soiree|\bfete\b|invitation|reservation|evenement|pique[- ]nique|oursinade/,
  /huile|jus\b|vinaigre|hydrolat|\bmarc\b|eau[- ]de[- ]vie|liqueur|ratafia|confiture|tapenade|savon/,
].map((r) => r.source).join('|'));
/**
 * A box described by its content ("Deux bouteilles de 75 cl AOP Pic Saint
 * Loup...", 197 €). Not "dès 6 bouteilles", the delivery terms of every page.
 */
const SEVERAL_BOTTLES = /\b(deux|trois|quatre|cinq|six|douze|\d+)\s+bouteilles\s+de\s+75/;
/** A home, shop or range page read as a product: its title is not a wine's. */
const NOT_A_PRODUCT_TITLE = /^(accueil|home|boutique|shop|e-?shop|la cave|nos vins|nos cuvees|les cuvees|les vins)\b/;
const PSL = /pic[\s-]*s(ain)?t[\s-]*loup/;

/**
 * The designations of the reference data, as labels and shops write them.
 * Includes the former name of the Pic Saint-Loup, "AOC Coteaux du Languedoc
 * Pic Saint-Loup", still on the labels of vintages before its own AOC (2016),
 * which must not read as the AOP Languedoc it contains.
 */
const DESIGNATIONS: readonly { id: string; pattern: RegExp }[] = [
  { id: 'aoc-pic-saint-loup', pattern: /\b(aop|aoc|appellation)\s+(d'origine\s+(protegee|controlee)\s+)?((coteaux\s+du\s+)?languedoc[\s-]+)?pic[\s-]*s(ain)?t[\s-]*loup/ },
  { id: 'aoc-gres-de-montpellier', pattern: /gres[\s-]+de[\s-]+montpellier/ },
  { id: 'aoc-languedoc', pattern: /\b(aop|aoc|appellation)\s+(d'origine\s+(protegee|controlee)\s+)?(coteaux\s+du\s+)?languedoc\b(?![\s-]+(pic|gres))/ },
  { id: 'igp-saint-guilhem-le-desert', pattern: /saint[\s-]+guilhem/ },
  { id: 'vin-de-france', pattern: /\bvin de france\b|\bvdf\b/ },
];
/** An IGP or a vin de pays other than Saint-Guilhem: not in the reference data. */
const OTHER_IGP = /\b(igp|vin de pays)\b(?![\s-]+(de\s+)?saint[\s-]+guilhem)/;

/** Sparkling wines: the catalog, like the appellation, holds still wines. */
const SPARKLING_TITLE = /petillant|mousseux|cremant|pet[- ]?nat|methode (traditionnelle|ancestrale)|\bbulles?\b/;
const SPARKLING_TEXT = /\b(vin )?(petillant|mousseux|cremant)\b|pet[- ]?nat|methode (traditionnelle|ancestrale)/;
const LARGE_FORMAT = /magnum|jeroboam|150\s?cl|1[,.]5\s?l\b|\b37[,.]5\s?cl|demi[- ]bouteille/;

/** Sentences of the page that describe the wine itself, by vocabulary. */
const TASTING_WORDS = /\b(robe|nez|bouche|tanins?|finale|aromes?|attaque|palais|texture|longueur|gourmand|fruite|epice|garrigue)/;
const NON_TASTING = /livraison|commande|stock|expedi|frais de port|panier|€|prix|paiement|cookies?/;

/** What extraction needs from the reference data. */
export interface ExtractionReference {
  grapeIndex: ReadonlyMap<string, string>;
  /** Designation id -> the colors it permits. */
  designations: ReadonlyMap<string, { colors: readonly string[] }>;
}

export function extractCandidate(
  product: RawProduct,
  producer: Producer,
  reference: ExtractionReference,
  retrievedOn: string,
): Extraction {
  const title = product.title;
  const titleN = normalize(title);
  const all = normalize([title, product.text, ...product.labels].join('\n'));
  const exclude = (reason: string): Extraction => ({ kind: 'excluded', title, url: product.url, reason });

  // Excluded: only what is certainly not a still wine of the estate, in a
  // 75 cl bottle and under a designation of the reference data. Everything
  // merely uncertain becomes a candidate to complete.
  if (NOT_A_PRODUCT_TITLE.test(titleN)) return exclude('a home or range page, not a product');
  if (NOT_A_BOTTLE.test(titleN) || SEVERAL_BOTTLES.test(normalize(product.text))) {
    return exclude('not a single bottle of wine');
  }
  // The format is sometimes only in the address ("...-rouge-150cl").
  if (LARGE_FORMAT.test(titleN) || LARGE_FORMAT.test(normalize(decodeURIComponent(product.url)))) {
    return exclude('large or small format: the 75 cl bottle is the reference');
  }
  if (SPARKLING_TITLE.test(titleN) || SPARKLING_TEXT.test(normalize(product.text))) {
    return exclude('sparkling wine: the catalog holds still wines');
  }

  const labelsN = normalize([title, ...product.labels].join('\n'));
  const named = (text: string) => DESIGNATIONS.filter((d) => d.pattern.test(text)).map((d) => d.id);
  const onPage = named(all);
  // A shop category or breadcrumb "Pic Saint-Loup" names the appellation.
  if (product.labels.some((l) => PSL.test(normalize(l))) && !onPage.includes('aoc-pic-saint-loup')) {
    onPage.unshift('aoc-pic-saint-loup');
  }
  if (onPage.length === 0 && OTHER_IGP.test(all)) {
    return exclude('a designation outside the reference data (IGP Pays d\'Oc, Pays d\'Herault...)');
  }

  const color = colorOf(titleN, all);
  const colorCode = color === 'red' || color === 'rose' || color === 'white' ? color : null;

  // An event, a gift card or a hydrolat the list above does not name yet:
  // nothing on the page describes a wine. Kept, it would only be one more
  // file to delete by hand.
  if (color === null && onPage.length === 0 && abvOf(product.text) === null &&
      blendOf(product.text, reference.grapeIndex).length === 0 &&
      vintageOf(title, product.text).value === null) {
    return exclude('nothing on the page describes a wine (no color, designation, grape, vintage or alcohol content)');
  }

  const flags: string[] = [];
  const toComplete: string[] = [];
  const choices = [...reference.designations.keys()].map((id) => `"${id}"`).join(', ');

  // The title and the shop's labels speak for this bottle; the page text may
  // also talk about the estate's other wines.
  const inLabels = named(labelsN).filter((id) => onPage.includes(id));
  let designation: string | null =
    onPage.length === 1 ? onPage[0]! : inLabels.length === 1 ? inLabels[0]! : null;

  if (onPage.length === 0) {
    toComplete.push(PSL.test(all)
      // The Tonillieres case: the Pic Saint-Loup terroir, not the appellation.
      ? `appellation_id: the page names Pic Saint-Loup as a place, not as a designation. ` +
        `Set the one on the label (${choices}), otherwise delete this file.`
      : `appellation_id: the page states no designation. ` +
        `Set the one on the label (${choices}), otherwise delete this file.`);
  } else if (designation === null) {
    toComplete.push(`appellation_id: the page names several designations (${onPage.join(', ')}). Set the one on the label.`);
  } else if (onPage.length > 1) {
    flags.push(`the page also names ${onPage.filter((id) => id !== designation).join(', ')}: check the designation`);
  }
  if (designation !== null && colorCode !== null &&
      !reference.designations.get(designation)?.colors.includes(colorCode)) {
    toComplete.push(
      `appellation_id: the page names ${designation}, which covers no ${colorCode} wine. ` +
      `Set the designation on the label, otherwise delete this file.`,
    );
    designation = null;
  }
  if (colorCode === null) {
    toComplete.push(color === null
      ? 'color: the page does not say. Set "red", "rose" or "white".'
      : 'color: several colors on the page, none in the title. Set "red", "rose" or "white".');
  }

  const vintage = vintageOf(title, product.text);
  if (vintage.flag) flags.push(vintage.flag);

  const name = cleanName(title);
  if (name !== title) flags.push(`name cleaned from the shop title "${title}"`);

  const blend = blendOf(product.text, reference.grapeIndex);
  if (blend.length === 0) flags.push('no grape found: blend left empty');

  const price = priceOf(product.prices);
  if (price.flag) flags.push(price.flag);

  const note = tastingNote(product.text);
  if (!note) flags.push('no descriptive sentence found: the wine will fall back on the appellation profile');

  const quarantined = inspectNote('candidate', note);
  if (quarantined) flags.push(`QUARANTINE: the note looks like an instruction (${quarantined.patterns.join(', ')})`);

  const organic = /agriculture biologique|\bbio\b|\bab\b|ecocert|biodynami/.test(all) ? true : null;
  const certification = /ecocert/.test(all) ? 'Ecocert' : null;
  if (organic && /biodynami/.test(all) && !/agriculture biologique|\bbio\b|ecocert/.test(all)) {
    flags.push('biodynamics mentioned without an organic certification: check `organic`');
  }

  // The color joins the id only when the shop's title names it, as for the
  // two Dame Jeanne (rouge and rose) already in the catalog.
  const titleColor = /\b(rouge|rose|blanc)\b/.exec(titleN.replace(NOT_A_COLOR, ' '))?.[1];
  const nameSlug = slug(name);
  const colorPart = titleColor && !nameSlug.split('-').includes(titleColor) ? titleColor : null;
  const id = [shortProducer(producer.id), nameSlug, colorPart, vintage.value].filter(Boolean).join('-');
  const wine: CandidateWine = {
    id,
    producer_id: producer.id,
    appellation_id: designation,
    name,
    color: colorCode,
    vintage: vintage.value,
    blend,
    abv: abvOf(product.text),
    aging: agingOf(product.text),
    price_eur: price.value,
    price_as_of: price.value === null ? null : retrievedOn,
    organic,
    certification,
    tasting_note: note,
    tasting_note_source: note
      ? {
          id: `page-${id}`,
          type: 'producer_page',
          label: 'Fiche cuvee publiee par le domaine',
          url: product.url,
          authority: producer.name,
          retrieved_on: retrievedOn,
          content_sha256: sha256(product.text),
        }
      : null,
    producer_pairings: [],
    page_url: product.url,
  };

  return { kind: 'candidate', candidate: { wine, flags, toComplete, sourceText: product.text } };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** "domaine-de-morties" -> "morties", as in the existing wine ids. */
function shortProducer(producerId: string): string {
  return producerId.replace(/^(domaine|chateau|cave-cooperative|cave)-(de-la-|de-l-|du-|des-|de-|d-)?/, '');
}

/**
 * Color words that describe aromas or dishes, not the wine: "fruits rouges"
 * in a rose's description, "notes de rose" in a red's, "viande blanche".
 */
const NOT_A_COLOR = /(fruits?|baies|groseilles?|cerises?|pommes?|poivrons?)\s+(rouges?|blanc(he)?s?)|(viandes?|fleurs?|peches?|poivre|chair)\s+blanc(he)?s?|\b(de la|de|la|une|des|aux)\s+roses?\b|rose (fanee|ancienne|sechee)/g;

function colorOf(titleN: string, all: string): Wine['color'] | 'ambiguous' | null {
  const found = (text: string) => {
    const t = text.replace(NOT_A_COLOR, ' ');
    const colors = new Set<Wine['color']>();
    if (/\broses?\b/.test(t)) colors.add('rose');
    if (/\brouges?\b/.test(t)) colors.add('red');
    if (/\bblancs?\b/.test(t)) colors.add('white');
    return colors;
  };
  const inTitle = found(titleN);
  if (inTitle.size === 1) return [...inTitle][0]!;
  const inPage = found(all);
  if (inPage.size === 1) return [...inPage][0]!;
  return inPage.size === 0 ? null : 'ambiguous';
}

function vintageOf(title: string, text: string): { value: number | null; flag?: string } {
  const years = (t: string) => [...t.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)].map((m) => Number(m[1]));
  const fromTitle = years(title);
  if (fromTitle.length === 1) return { value: fromTitle[0]! };
  const fromText = [...new Set(years(text))];
  if (fromText.length === 1) return { value: fromText[0]!, flag: 'vintage taken from the description, not the title' };
  return { value: null, flag: 'vintage not found or ambiguous: left null' };
}

function cleanName(title: string): string {
  const name = title
    // "Into The Red -Rouge léger": a dash opens a subtitle, spaced or not.
    .split(/\s+[-–—|]\s*/)[0]!
    .replace(/\b(19[89]\d|20[0-4]\d)\b/g, '')
    .replace(/\b(aop|aoc|igp|vdf)\b.*$/i, '')
    .replace(/\bvin de france\b.*$/i, '')
    .replace(/\b(bio|75\s?cl)(?!\p{L})/giu, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:-]+$/, '')
    // A trailing color is a label ("Dame Jeanne Rose"); a leading one is part
    // of the name ("Rose du Pic").
    .replace(/\s+(vin\s+)?(rouge|ros[ée]|blanc)$/iu, '')
    // « Le Causse »: the quotation marks are the shop's typography.
    .replace(/^["«“\s]+|["»”\s]+$/g, '')
    .trim();
  return recase(name) || title.trim();
}

const SMALL_WORDS = new Set(['a', 'à', 'au', 'aux', 'de', 'des', 'du', 'en', 'et', 'la', 'le', 'les']);

/**
 * "ORANGE À LA MER" -> "Orange à la Mer". Only an all-capitals name is
 * recased: a name with a lowercase letter is written the way the estate chose.
 */
function recase(name: string): string {
  if (/\p{Ll}/u.test(name)) return name;
  return name.toLowerCase().split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w)
      ? w
      : w.replace(/(^|[’'-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase())))
    .join(' ');
}

function blendOf(text: string, grapeIndex: ReadonlyMap<string, string>): Wine['blend'] {
  const t = normalize(text);
  // Longest names first, so that "grenache gris" wins over "grenache".
  const names = [...grapeIndex.keys()].sort((a, b) => b.length - a.length);
  const found = new Map<string, { pct: number | null; at: number }>();
  const taken: [number, number][] = [];
  for (const name of names) {
    const code = grapeIndex.get(name)!;
    if (found.has(code)) continue;
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m =
      new RegExp(`(\\d{1,3})\\s*%\\s*(?:de\\s+)?(${n})\\b`).exec(t) ??
      new RegExp(`\\b(${n})\\s*:?\\s*\\(?(\\d{1,3})\\s*%`).exec(t) ??
      new RegExp(`\\b(${n})\\b`).exec(t);
    if (!m) continue;
    // A name inside a longer one already found ("grenache" in "grenache gris").
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
    taken.push([m.index, m.index + m[0].length]);
    const digits = m.slice(1).find((g) => g !== undefined && /^\d+$/.test(g));
    found.set(code, { pct: digits ? Number(digits) : null, at: m.index });
  }
  // In the order the page lists them.
  const blend = [...found]
    .sort((a, b) => a[1].at - b[1].at)
    .map(([grape, { pct }]) => ({ grape, pct }));
  const total = blend.reduce((s, b) => s + (b.pct ?? 0), 0);
  // Percentages that do not add up are worse than none: keep the grapes only.
  if (total !== 0 && (total < 95 || total > 100.5 || blend.some((b) => b.pct === null))) {
    return blend.map((b) => ({ grape: b.grape, pct: null }));
  }
  return blend;
}

function abvOf(text: string): number | null {
  const m = /(\d{1,2})(?:[.,](\d))?\s*(?:%\s*(?:vol|alc)|°)/i.exec(text);
  if (!m) return null;
  const value = Number(`${m[1]}.${m[2] ?? '0'}`);
  return value >= 8 && value <= 17 ? value : null;
}

function agingOf(text: string): string | null {
  const sentence = sentences(text).find((s) => /[ée]levage|vieillissement/i.test(s));
  return sentence && sentence.length <= 500 ? sentence : null;
}

function priceOf(prices: RawProduct['prices']): { value: number | null; flag?: string } {
  if (prices.length === 0) return { value: null, flag: 'no price published' };
  const bottles = prices.filter((p) => !LARGE_FORMAT.test(normalize(p.label)) && !/carton|caisse|\bx\s?\d|\d\s?x\b|lot/.test(normalize(p.label)));
  const values = [...new Set(bottles.map((p) => p.eur))];
  if (values.length === 1) return { value: values[0]! };
  return { value: null, flag: `several prices (${prices.map((p) => `${p.label}: ${p.eur} €`).join(', ')}): left null` };
}

export function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+(?=[A-ZÀ-Ý«"])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

function tastingNote(text: string): string | null {
  const picked: string[] = [];
  let length = 0;
  for (const s of sentences(text)) {
    const n = normalize(s);
    if (NON_TASTING.test(n)) continue;
    if (!TASTING_WORDS.test(n) && !tokenize(s).some((t) => FAMILY_BY_STEM.has(t))) continue;
    // Whole sentences only: a cut sentence is no longer what the estate wrote.
    if (length + s.length + 1 > 4000) break;
    picked.push(s);
    length += s.length + 1;
  }
  const note = picked.join(' ');
  return note.length >= 40 ? note : null;
}

/**
 * True when the note is made of sentences of the source, in their order,
 * copied without a single change. This is the ingestion half of the rule the
 * output check enforces on the model's answers.
 */
export function isVerbatim(note: string, source: string): boolean {
  let i = 0;
  for (const s of sentences(source)) {
    if (i >= note.length) break;
    if (note.startsWith(s, i)) {
      i += s.length;
      if (note[i] === ' ') i++;
    }
  }
  return i === note.length;
}
