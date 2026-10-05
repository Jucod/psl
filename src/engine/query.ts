import { config, type FilterField } from '../config/domain.js';
import type { Filters } from '../schema/filters.js';

export interface SqlClause {
  text: string;
  params: unknown[];
}

/**
 * Translates a filters object into SQL clauses, driven ONLY by
 * src/config/domain.ts. No business column name appears here: changing
 * domain = changing the config, not this file.
 *
 * `w` is the alias of the row being filtered (see RESULTS_SQL in search.ts).
 */
export function buildClauses(
  filters: Filters,
  firstParam: number,
): SqlClause {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let n = firstParam;

  for (const field of config.fields) {
    const value = (filters as Record<string, unknown>)[field.key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;

    const clause = clauseForField(field, value, () => `$${n++}`, params);
    if (clause) clauses.push(clause);
  }

  return {
    text: clauses.length ? clauses.join(' AND ') : 'TRUE',
    params,
  };
}

function clauseForField(
  field: FilterField,
  value: unknown,
  nextParam: () => string,
  params: unknown[],
): string | null {
  switch (field.operator) {
    case 'eq':
      params.push(value);
      return `w.${field.column} = ${nextParam()}`;

    case 'max':
      params.push(value);
      // A NULL value is not "under budget": it is unknown.
      // We exclude it rather than pass it off as compliant.
      return `w.${field.column} IS NOT NULL AND w.${field.column} <= ${nextParam()}`;

    case 'min':
      params.push(value);
      return `w.${field.column} IS NOT NULL AND w.${field.column} >= ${nextParam()}`;

    case 'boolean':
      // false = "does not matter", not "certainly not". Explicitly asking for
      // non-organic makes no sense on the user's side.
      return value === true ? `w.${field.column} IS TRUE` : null;

    case 'join_any': {
      const j = field.join!;
      params.push(value);
      return `EXISTS (SELECT 1 FROM ${j.table} jj WHERE jj.${j.foreignKey} = w.id AND jj.${j.column} = ANY(${nextParam()}))`;
    }

    case 'join_none': {
      const j = field.join!;
      params.push(value);
      // The mirror of the `IS NOT NULL` of scalar operators: an absence cannot
      // be concluded from ignorance. Without the second condition, a wine
      // whose blend is masked satisfied "sans mourvedre" (no mourvedre) — and
      // the engine asserted it about a wine that contains 25% of it. It is
      // the only factually false statement an engine of this kind can make
      // about a product.
      return (
        `NOT EXISTS (SELECT 1 FROM ${j.table} jj WHERE jj.${j.foreignKey} = w.id AND jj.${j.column} = ANY(${nextParam()}))` +
        ` AND EXISTS (SELECT 1 FROM ${j.table} jk WHERE jk.${j.foreignKey} = w.id)`
      );
    }

    default: {
      const _exhaustive: never = field.operator;
      throw new Error(`unhandled operator: ${_exhaustive}`);
    }
  }
}
