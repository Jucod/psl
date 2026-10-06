import { WineSchema, type Wine } from '../schema/wine.js';
import { grapeCode } from '../ingest/util.js';
import { inspectNote } from '../ingest/quarantine.js';
import { isVerbatim } from './extract.js';

/** Grape rules of an appellation, as db/seed/pic-saint-loup-seed.json declares them. */
export type GrapeRules = Record<string, {
  main: string[];
  secondary: string[];
  blend_rules: Record<string, number>;
}>;

export interface Verdict {
  /** Promotion is refused while this is not empty. */
  errors: string[];
  /** Shown to the reviewer, not blocking. */
  warnings: string[];
}

/**
 * Checks a blend against the AOC grape rules. Percentages are only checked
 * when the page gives all of them; a page listing grapes without figures may
 * well be incomplete, so the minimum number of main grapes is then a warning.
 */
export function checkGrapeRules(
  wine: Pick<Wine, 'color' | 'blend'>,
  rules: GrapeRules,
  grapeIndex: ReadonlyMap<string, string>,
): Verdict {
  const verdict: Verdict = { errors: [], warnings: [] };
  const block = rules[wine.color];
  if (!block) {
    verdict.errors.push(`color ${wine.color} is not permitted by the appellation`);
    return verdict;
  }
  if (wine.blend.length === 0) return verdict;

  const codes = (labels: string[]) => new Set(labels.map((l) => grapeCode(l, grapeIndex)).filter(Boolean));
  const main = codes(block.main);
  const secondary = codes(block.secondary);
  const r = block.blend_rules;

  for (const b of wine.blend) {
    if (!main.has(b.grape) && !secondary.has(b.grape)) {
      verdict.errors.push(`${b.grape} is not a permitted grape for this color`);
    }
  }

  const mainCount = wine.blend.filter((b) => main.has(b.grape)).length;
  const complete = wine.blend.every((b) => b.pct !== null);
  if (r.main_grapes_min !== undefined && mainCount < r.main_grapes_min) {
    (complete ? verdict.errors : verdict.warnings).push(
      `${mainCount} main grape(s) listed, the AOC requires at least ${r.main_grapes_min}`,
    );
  }
  if (!complete) return verdict;

  const pct = (grape: string) => wine.blend.find((b) => b.grape === grape)?.pct ?? 0;
  const sum = (pred: (g: string) => boolean) =>
    wine.blend.filter((b) => pred(b.grape)).reduce((s, b) => s + (b.pct ?? 0), 0);

  if (r.syrah_min_pct !== undefined && pct('syrah') < r.syrah_min_pct) {
    verdict.errors.push(`syrah ${pct('syrah')}% < ${r.syrah_min_pct}% required`);
  }
  if (r.secondary_max_pct !== undefined && sum((g) => secondary.has(g)) > r.secondary_max_pct) {
    verdict.errors.push(`secondary grapes ${sum((g) => secondary.has(g))}% > ${r.secondary_max_pct}%`);
  }
  if (r.cinsault_max_pct !== undefined && pct('cinsaut') > r.cinsault_max_pct) {
    verdict.errors.push(`cinsault ${pct('cinsaut')}% > ${r.cinsault_max_pct}%`);
  }
  if (r.other_secondary_max_pct !== undefined) {
    const others = sum((g) => secondary.has(g) && g !== 'cinsaut');
    if (others > r.other_secondary_max_pct) {
      verdict.errors.push(`secondary grapes other than cinsault ${others}% > ${r.other_secondary_max_pct}%`);
    }
  }
  return verdict;
}

export interface ReviewContext {
  grapeIndex: ReadonlyMap<string, string>;
  rules: GrapeRules;
  producerIds: ReadonlySet<string>;
  existing: readonly Wine[];
}

/** Everything that must hold before a candidate enters db/seed/wines/. */
export function reviewCandidate(raw: unknown, sourceText: string | null, ctx: ReviewContext): Verdict & { wine?: Wine } {
  const verdict: Verdict = { errors: [], warnings: [] };
  const parsed = WineSchema.safeParse(raw);
  if (!parsed.success) {
    verdict.errors.push(...parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
    return verdict;
  }
  const wine = parsed.data;

  if (!ctx.producerIds.has(wine.producer_id)) {
    verdict.errors.push(`unknown producer ${wine.producer_id}: not in the syndicate directory`);
  }
  const knownCodes = new Set(ctx.grapeIndex.values());
  for (const b of wine.blend) {
    if (!knownCodes.has(b.grape)) verdict.errors.push(`unknown grape code ${b.grape}`);
  }
  const rules = checkGrapeRules(wine, ctx.rules, ctx.grapeIndex);
  verdict.errors.push(...rules.errors);
  verdict.warnings.push(...rules.warnings);

  const sameWine = ctx.existing.find((w) =>
    w.id === wine.id ||
    (w.producer_id === wine.producer_id && w.name.toLowerCase() === wine.name.toLowerCase() &&
     w.vintage === wine.vintage && w.color === wine.color));
  if (sameWine) verdict.errors.push(`already in the catalog as ${sameWine.id}`);

  if (wine.tasting_note) {
    if (sourceText === null) {
      verdict.errors.push('source text missing: the note cannot be checked against the page');
    } else if (!isVerbatim(wine.tasting_note, sourceText)) {
      verdict.errors.push('the tasting note is not made of sentences copied from the page');
    }
    const quarantined = inspectNote(wine.id, wine.tasting_note);
    if (quarantined) verdict.errors.push(`quarantine: ${quarantined.patterns.join(', ')}`);
  }
  return { ...verdict, wine };
}
