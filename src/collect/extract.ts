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

const APPELLATION = 'aoc-pic-saint-loup';

const NOT_A_BOTTLE = /coffret|carton|caisse|\blot\b|\bpack\b|verres?\b|tire-bouchon|carte cadeau|bon cadeau|bag[- ]in[- ]box|\bbib\b|cubi|abonnement|degustation|visite|atelier|huile|jus\b/;
const PSL = /pic[\s-]*s(ain)?t[\s-]*loup/;
// Includes the former name of the appellation, "AOC Coteaux du Languedoc Pic
// Saint-Loup", still on the labels of vintages before its own AOC (2016).
const PSL_AS_APPELLATION = /\b(aop|aoc|appellation)\s+(d'origine\s+(protegee|controlee)\s+)?((coteaux\s+du\s+)?languedoc[\s-]+)?pic[\s-]*s(ain)?t[\s-]*loup/;
const OTHER_DESIGNATION = /\bigp\b|vin de france|\b(aop|aoc)\s+languedoc\b(?![\s-]+pic)|coteaux du languedoc(?![\s-]+pic)|saint[- ]guilhem/;
const LARGE_FORMAT = /magnum|jeroboam|150\s?cl|1[,.]5\s?l\b|\b37[,.]5\s?cl|demi[- ]bouteille/;

/** Sentences of the page that describe the wine itself, by vocabulary. */
const TASTING_WORDS = /\b(robe|nez|bouche|tanins?|finale|aromes?|attaque|palais|texture|longueur|gourmand|fruite|epice|garrigue)/;
const NON_TASTING = /livraison|commande|stock|expedi|frais de port|panier|€|prix|paiement|cookies?/;

export function extractCandidate(
  product: RawProduct,
  producer: Producer,
  grapeIndex: ReadonlyMap<string, string>,
  retrievedOn: string,
): Extraction {
  const title = product.title;
  const titleN = normalize(title);
  const all = normalize([title, product.text, ...product.labels].join('\n'));
  const exclude = (reason: string): Extraction => ({ kind: 'excluded', title, url: product.url, reason });

  // Excluded: only what is certainly not a bottle of Pic Saint-Loup.
  // Everything merely uncertain becomes a candidate to complete.
  if (NOT_A_BOTTLE.test(titleN)) return exclude('not a single bottle of wine');
  if (LARGE_FORMAT.test(titleN)) return exclude('large or small format: the 75 cl bottle is the reference');

  const pslNamed = PSL_AS_APPELLATION.test(all) || product.labels.some((l) => PSL.test(normalize(l)));
  const pslMentioned = PSL.test(all);
  const otherDesignation = OTHER_DESIGNATION.test(all);
  if (!pslMentioned && otherDesignation) {
    return exclude('another designation (IGP, AOP Languedoc, Vin de France) and no Pic Saint-Loup');
  }

  const color = colorOf(titleN, all);
  if (color === 'white') return exclude('white wine: the Pic Saint-Loup AOC covers no white');

  const flags: string[] = [];
  const toComplete: string[] = [];

  if (!pslNamed) {
    toComplete.push(pslMentioned
      // The Tonillieres case: the Pic Saint-Loup terroir, not the appellation.
      ? 'appellation_id: the page names Pic Saint-Loup as a place, not as the appellation. ' +
        'Set "aoc-pic-saint-loup" if the label says so, otherwise delete this file.'
      : 'appellation_id: the page states no appellation. ' +
        'Set "aoc-pic-saint-loup" if the label says so, otherwise delete this file.');
  } else if (otherDesignation) {
    flags.push('the page also mentions another designation (IGP, AOP Languedoc...): check the appellation');
  }
  if (color === null || color === 'ambiguous') {
    toComplete.push(color === null
      ? 'color: the page does not say. Set "red" or "rose".'
      : 'color: several colors on the page, none in the title. Set "red" or "rose".');
  }

  const vintage = vintageOf(title, product.text);
  if (vintage.flag) flags.push(vintage.flag);

  const name = cleanName(title);
  if (name !== title) flags.push(`name cleaned from the shop title "${title}"`);

  const blend = blendOf(product.text, grapeIndex);
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
  const titleColor = /\b(rouge|rose)\b/.exec(titleN.replace(NOT_A_COLOR, ' '))?.[1];
  const nameSlug = slug(name);
  const colorPart = titleColor && !nameSlug.split('-').includes(titleColor) ? titleColor : null;
  const id = [shortProducer(producer.id), nameSlug, colorPart, vintage.value].filter(Boolean).join('-');
  const wine: CandidateWine = {
    id,
    producer_id: producer.id,
    appellation_id: pslNamed ? APPELLATION : null,
    name,
    color: color === 'red' || color === 'rose' ? color : null,
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
  return title
    .split(/\s+[-–—|]\s+/)[0]!
    .replace(/\b(19[89]\d|20[0-4]\d)\b/g, '')
    .replace(/\b(aop|aoc)\b.*$/i, '')
    .replace(/\b(bio|75\s?cl)(?!\p{L})/giu, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:-]+$/, '')
    // A trailing color is a label ("Dame Jeanne Rose"); a leading one is part
    // of the name ("Rose du Pic").
    .replace(/\s+(vin\s+)?(rouge|ros[ée]|blanc)$/iu, '')
    .trim() || title.trim();
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
