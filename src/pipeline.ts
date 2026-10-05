import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { config } from './config/domain.js';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { embeddingProvider } from './embeddings/index.js';
import { buildGrapeIndex, grapeCode } from './ingest/util.js';
import { llmProvider, type FormulationInput, type Usage } from './llm/index.js';
import { vectorText } from './llm/parser.js';
import { search } from './engine/search.js';
import { pickExcerpt } from './engine/justification.js';
import type { SearchResult } from './engine/types.js';
import { EMPTY_FILTERS, parsePartialFilters, type Filters } from './schema/filters.js';

const GRAPES_PATH = fileURLToPath(new URL('../db/seed/grapes.json', import.meta.url));

export interface PipelineInput {
  message: string;
  /** Filters corrected by hand in the UI. Bypasses LLM call 1. */
  forcedFilters?: unknown;
  ip?: string;
}

export interface PipelineOutput {
  status: SearchResult['status'] | 'message_too_long' | 'invalid_schema';
  text: string;
  search: SearchResult | null;
  degraded: boolean;
  degradedReason: string | null;
  usage: Usage;
  latency_ms: number;
  llmProvider: string;
  fixturesEnabled: boolean;
}

let grapeIndex: ReadonlyMap<string, string> | null = null;
async function grapes(): Promise<ReadonlyMap<string, string>> {
  if (!grapeIndex) {
    const doc = JSON.parse(await readFile(GRAPES_PATH, 'utf8'));
    grapeIndex = buildGrapeIndex(doc.grapes);
  }
  return grapeIndex;
}

/**
 * Normalizes values before the engine: "shiraz" and "Syrah N" must become
 * "syrah" before touching a WHERE, otherwise the filter misses silently.
 * It happens here, and not in the engine, because it is a matter of business
 * vocabulary: the engine stays ignorant of the domain.
 */
export async function normalizeFilters(
  f: Filters,
): Promise<{ filters: Filters; unknown: string[] }> {
  const index = await grapes();
  const unknown: string[] = [];

  /**
   * `report` distinguishes the two directions, and the distinction matters.
   *
   * An unknown variety that is REQUESTED is a constraint the catalog cannot
   * satisfy: dropping it made the system answer three reds to "avez-vous du
   * chardonnay ?". It must produce a refusal.
   *
   * An unknown variety that is EXCLUDED is a constraint satisfied by
   * construction: the right answer to "un rouge sans chardonnay" is three
   * reds, not a refusal. Refusing it amounted to not answering a request we
   * trivially honor, on a perfectly ordinary wine-merchant phrasing.
   */
  const normalizeList = (list: string[], report: boolean) => {
    const codes: string[] = [];
    for (const name of list) {
      const code = grapeCode(name, index);
      if (code === null) {
        if (report) unknown.push(name);
      } else {
        codes.push(code);
      }
    }
    return [...new Set(codes)].sort();
  };

  return {
    filters: {
      ...f,
      grapes_included: normalizeList(f.grapes_included, true),
      grapes_excluded: normalizeList(f.grapes_excluded, false),
    },
    unknown: [...new Set(unknown)],
  };
}

/**
 * Refusal built from the permitted varieties of the specification. Like the
 * color refusal, it is a query result, and it cites its source.
 */
async function refuseUnknownGrapes(
  unknown: string[],
  appellation: string | null,
): Promise<SearchResult['refusal']> {
  if (!appellation) {
    return { message: `Cepage inconnu du catalogue : ${unknown.join(', ')}.`, source: null };
  }

  const { rows } = await db().query(
    `SELECT a.name, a.grape_rules, s.id, s.type, s.label, s.url, s.authority,
            s.retrieved_on::text AS retrieved_on
       FROM appellations a JOIN sources s ON s.id = a.source_id
      WHERE a.id = $1`,
    [appellation],
  );
  const row = rows[0];
  if (!row) {
    return { message: `Cepage inconnu du catalogue : ${unknown.join(', ')}.`, source: null };
  }

  const permitted = new Set<string>();
  for (const block of Object.values(row.grape_rules ?? {})) {
    for (const key of ['main', 'secondary']) {
      for (const g of (block as any)?.[key] ?? []) permitted.add(String(g));
    }
  }

  return {
    message:
      `${unknown.join(', ')} : ce cepage n'entre pas dans l'encepagement de ` +
      `l'appellation ${row.name}` +
      (permitted.size
        ? `, qui n'autorise que ${[...permitted].sort().join(', ')}.`
        : '.'),
    source: {
      id: row.id, type: row.type, label: row.label, url: row.url,
      authority: row.authority ?? null, retrieved_on: row.retrieved_on,
    },
  };
}

/** Appellation used when the request names none. */
export async function defaultAppellation(): Promise<string | null> {
  const { rows } = await db().query<{ id: string }>(
    'SELECT id FROM appellations ORDER BY id LIMIT 2',
  );
  // A single appellation in the catalog: we take it by default and the UI
  // shows it as an editable filter. Several: we do not guess.
  return rows.length === 1 ? rows[0]!.id : null;
}

export function hashIp(ip: string): string {
  return createHmac('sha256', env.ipHashSecret()).update(ip).digest('hex').slice(0, 32);
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const start = Date.now();
  const llm = llmProvider();
  const fixtures = env.allowFixtures();

  const base: Omit<PipelineOutput, 'status' | 'text' | 'search'> = {
    degraded: false,
    degradedReason: null,
    usage: { tokens_in: 0, tokens_out: 0, cost_eur: 0 },
    latency_ms: 0,
    llmProvider: llm.name,
    fixturesEnabled: fixtures,
  };

  const maxLength = env.maxMessageLength();
  if (input.message.length > maxLength) {
    return {
      ...base,
      status: 'message_too_long',
      text: `Message trop long (${input.message.length} caracteres, maximum ${maxLength}).`,
      search: null,
      latency_ms: Date.now() - start,
    };
  }

  const fallbackAppellation = await defaultAppellation();

  // --- call 1, or filters forced by the user ---------------------------------
  let filters: Filters;
  let degraded = false;
  let degradedReason: string | null = null;
  const usage: Usage = { ...base.usage };

  if (input.forcedFilters !== undefined) {
    const valid = parsePartialFilters(input.forcedFilters);
    if (!valid.success) {
      return {
        ...base,
        status: 'invalid_schema',
        text:
          'Filtres invalides : ' +
          valid.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', '),
        search: null,
        latency_ms: Date.now() - start,
      };
    }
    filters = valid.data;
  } else {
    const extraction = await llm.extractFilters(input.message, fallbackAppellation);
    filters = extraction.filters;
    degraded = extraction.degraded;
    degradedReason = extraction.degradedReason;
    usage.tokens_in += extraction.usage.tokens_in;
    usage.tokens_out += extraction.usage.tokens_out;
    usage.cost_eur += extraction.usage.cost_eur;
  }

  if (filters.appellation === null && fallbackAppellation) {
    filters = { ...filters, appellation: fallbackAppellation };
  }

  const normalization = await normalizeFilters(filters);
  filters = normalization.filters;

  if (normalization.unknown.length > 0) {
    const refusal = await refuseUnknownGrapes(normalization.unknown, filters.appellation);
    const result: SearchResult = {
      status: 'refused', refusal,
      requestedFilters: filters, appliedFilters: filters,
      relaxations: [], ranking: 'lexicographic', results: [],
      dishPairings: [], catalogSize: 0, warnings: [],
      undecidableFilters: [],
    };
    const { text } = await llm.formulate(toFormulationInput(result));
    return {
      ...base, status: 'refused', text, search: result,
      degraded, degradedReason, usage, latency_ms: Date.now() - start,
    };
  }

  // --- vector of the fuzzy part -----------------------------------------------
  // Vector arithmetic: wanted minus rejected. A note that contains the rejected
  // terms sees its cosine drop, which a mere opposite descriptor does not
  // achieve when every note contains the negated term.
  const texts = vectorText(filters);
  let vector: number[] | null = null;
  if (texts) {
    const provider = embeddingProvider();
    const toEmbed = [texts.included || ' ', ...(texts.excluded ? [texts.excluded] : [])];
    const [wanted, rejected] = await provider.embed(toEmbed);
    vector = rejected ? combine(wanted!, rejected, config.rejectionWeight) : (wanted ?? null);
  }

  // --- SQL query, executed by the code, never by the model ---------------------
  const result = await search(filters, {
    queryVector: vector,
    allowFixtures: fixtures,
  });

  // --- justification: which sentence of the note motivates the ranking? --------
  // Done here and not in the engine: it is a matter of rendering, and the
  // pipeline already holds the query vector. This keeps the type barrier of
  // FormulationInput intact, which must never see the descriptors.
  if (vector) {
    const provider = embeddingProvider();
    await Promise.all(
      result.results.map(async (w) => {
        if (!w.tasting_note) return;
        w.relevant_excerpt = await pickExcerpt(w.tasting_note, vector, provider);
      }),
    );
  }

  // --- call 2 -------------------------------------------------------------------
  const { text, usage: usage2 } = await llm.formulate(toFormulationInput(result));
  usage.tokens_in += usage2.tokens_in;
  usage.tokens_out += usage2.tokens_out;
  usage.cost_eur += usage2.cost_eur;

  return {
    ...base,
    status: result.status,
    text,
    search: result,
    degraded,
    degradedReason,
    usage,
    latency_ms: Date.now() - start,
  };
}

/**
 * Builds the input of call 2 field by field.
 *
 * A spread `{ ...result }` left `requestedFilters` - hence the descriptors,
 * and a free-text appellation - PHYSICALLY present in the object handed to
 * the model. TypeScript does not check excess properties on a spread: the
 * "type barrier" only existed on paper, and only the allowlist of
 * formulationPayload really protected anything. Enumerating makes the barrier
 * real at runtime.
 */
function toFormulationInput(result: SearchResult): FormulationInput {
  return {
    search: {
      status: result.status,
      refusal: result.refusal,
      relaxations: result.relaxations,
      ranking: result.ranking,
      results: result.results,
      dishPairings: result.dishPairings,
      catalogSize: result.catalogSize,
      warnings: result.warnings,
      undecidableFilters: result.undecidableFilters,
      appliedFilters: {},
    },
  };
}

/** normalize(a - weight * b). Returns null when the result is degenerate. */
export function combine(a: number[], b: number[], weight: number): number[] | null {
  const v = a.map((x, i) => x - weight * (b[i] ?? 0));
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm < 1e-9) return null;
  return v.map((x) => x / norm);
}

export { EMPTY_FILTERS, config };
