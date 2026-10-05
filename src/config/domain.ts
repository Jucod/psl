/**
 * Business-domain configuration.
 *
 * Filters, operators, relaxation and the coverage rule are declared here, and
 * the engine's query builder and relaxation loop consume them without naming
 * "color", "vintage" or "appellation". The result projection in
 * src/engine/search.ts is still wine-specific (see the README, Reusability):
 * reusing the engine on another catalog means rewriting this file, the
 * lexicon and those queries. No plugin layer, no generic entity model.
 *
 * The product speaks French: labels, announcements and messages declared here
 * are shown to visitors as they are, hence the French string literals.
 */

export type Operator =
  | 'eq'
  | 'max'
  | 'min'
  | 'boolean'
  | 'join_any'   // at least one of the values is present in the joined table
  | 'join_none'; // none of the values is present in the joined table

export interface Join {
  readonly table: string;
  readonly foreignKey: string;
  readonly column: string;
}

/** Result of a relaxation attempt. null = we cannot go any further. */
export interface RelaxationStep {
  readonly value: unknown;
  /** Sentence shown to the user. Relaxation is NEVER silent. */
  readonly announcement: string;
}

export interface FilterField {
  readonly key: string;
  readonly label: string;
  readonly operator: Operator;
  readonly column?: string;
  readonly join?: Join;
  /**
   * Relaxes the constraint by one step. Receives the current value and the
   * original one (to cap the drift). Returns null when the field cannot be
   * relaxed any further, in which case the engine moves on to the next field
   * in the order.
   */
  readonly relax?: (current: any, original: any) => RelaxationStep | null;
}

export interface DomainConfig {
  readonly fields: readonly FilterField[];
  /** Relaxation order, one constraint at a time. */
  readonly relaxationOrder: readonly string[];
  /**
   * Catalog coverage check. When the requested combination does not exist in
   * the coverage table, the system REFUSES instead of offering something
   * close. It is a query result, not a prompt instruction: testable without
   * an LLM.
   */
  readonly coverage: {
    readonly table: string;
    readonly keys: readonly { readonly filter: string; readonly column: string }[];
    readonly message: (values: Record<string, unknown>, available: string[]) => string;
  };
  readonly maxResults: number;
  readonly rejectionWeight: number;
  readonly embeddingDimension: number;
  /**
   * Minimum gap between the best and the worst score for a vector ranking to
   * be considered discriminating.
   *
   * It is a threshold on the SPREAD, not on absolute similarity, and the
   * nuance matters. On a rejection-only request ("rien de tannique"), the
   * query vector points away from the rejected concept: every cosine is
   * negative while the order itself is perfectly informative. An absolute
   * floor was never crossed, and rejection only served to select, never to
   * rank. What makes a ranking is separation.
   */
  readonly discriminationThreshold: number;
}

const EUROS = (n: number) => `${Number(n).toFixed(2).replace(/\.00$/, '')} €`;

/** French display labels of the color codes. */
export const COLOR_LABELS: Record<string, { readonly singular: string; readonly plural: string }> = {
  red: { singular: 'rouge', plural: 'rouges' },
  rose: { singular: 'rose', plural: 'roses' },
  white: { singular: 'blanc', plural: 'blancs' },
};

function colorLabel(code: unknown, form: 'singular' | 'plural' = 'singular'): string {
  return COLOR_LABELS[String(code)]?.[form] ?? String(code);
}

export const config: DomainConfig = {
  fields: [
    {
      key: 'appellation',
      label: 'Appellation',
      operator: 'eq',
      column: 'appellation_id',
      // Deliberately not relaxable. See relaxationOrder below.
      relax: () => null,
    },
    {
      key: 'color',
      label: 'Couleur',
      operator: 'eq',
      column: 'color',
    },
    {
      key: 'price_max',
      label: 'Budget maximum',
      operator: 'max',
      column: 'price_eur',
      // In 25% steps, capped at +50% of the initial budget.
      relax: (current: number, original: number) => {
        // Without this guard, a missing original makes the comparison NaN,
        // hence false, hence the drift cap never applies.
        if (!Number.isFinite(original)) return null;
        const cap = Math.round(original * 1.5 * 100) / 100;
        if (current >= cap - 0.001) return null;
        // The last step SETTLES on the cap instead of being abandoned.
        // Before: 12 € went up to 15 €, then 18.75 € exceeded the 18 € cap and
        // the ladder gave up — we answered "nothing found" while keeping 3 €
        // of announced margin up our sleeve, although two wines were at 16 €.
        // The declared cap must be reachable, otherwise it lies.
        const next = Math.min(Math.round(current * 1.25 * 100) / 100, cap);
        // A step that does not move is not a step (tiny budgets, where
        // rounding to the cent absorbs the 25%).
        if (next <= current) return null;
        return {
          value: next,
          announcement: `budget porte de ${EUROS(current)} a ${EUROS(next)}`,
        };
      },
    },
    {
      key: 'price_min',
      label: 'Budget minimum',
      operator: 'min',
      column: 'price_eur',
    },
    {
      key: 'vintage_min',
      label: 'Millesime le plus ancien',
      operator: 'min',
      column: 'vintage',
      relax: (current: number, original: number) => {
        if (!Number.isFinite(original)) return null;
        const next = current - 1;
        if (next < original - 3) return null;
        return { value: next, announcement: `millesime elargi jusqu'a ${next}` };
      },
    },
    {
      key: 'vintage_max',
      label: 'Millesime le plus recent',
      operator: 'max',
      column: 'vintage',
      relax: (current: number, original: number) => {
        if (!Number.isFinite(original)) return null;
        const next = current + 1;
        if (next > original + 3) return null;
        return { value: next, announcement: `millesime elargi jusqu'a ${next}` };
      },
    },
    {
      key: 'organic',
      label: 'Agriculture biologique',
      operator: 'boolean',
      column: 'organic',
    },
    {
      key: 'grapes_included',
      label: 'Cepages souhaites',
      operator: 'join_any',
      join: { table: 'wine_grapes', foreignKey: 'wine_id', column: 'grape' },
      relax: () => null,
    },
    {
      key: 'grapes_excluded',
      label: 'Cepages exclus',
      operator: 'join_none',
      join: { table: 'wine_grapes', foreignKey: 'wine_id', column: 'grape' },
    },
  ],

  /**
   * Budget, then vintage. The appellation closes the order but is NOT
   * relaxable (relax: () => null): in a single-AOC catalog, relaxing the
   * appellation cannot bring anything back, and it is in any case the most
   * explicit part of a request. The engine then produces an announced refusal.
   * The rung stays declared for the day the catalog becomes multi-AOC.
   */
  relaxationOrder: ['price_max', 'vintage_min', 'vintage_max', 'appellation'],

  coverage: {
    table: 'appellation_colors',
    keys: [
      { filter: 'appellation', column: 'appellation_id' },
      { filter: 'color', column: 'color' },
    ],
    message: (values, available) =>
      `L'appellation ${values.appellation} ne couvre pas les ${colorLabel(values.color, 'plural')}. ` +
      `Elle ne produit que : ${available.map((c) => colorLabel(c)).sort().join(', ')}.`,
  },

  maxResults: 3,

  /**
   * Weight of the rejection vector. The query vector is
   * normalize(v(wanted) - REJECTION * v(rejected)).
   * At 1.0 rejection crushes the request; at 0 it does nothing. 0.7 penalizes
   * clearly without inverting the ranking.
   */
  rejectionWeight: 0.7,
  embeddingDimension: 1536,
  discriminationThreshold: 0.05,
};

/** Indexed access, used throughout the engine. */
export const fieldByKey = new Map(config.fields.map((f) => [f.key, f]));
