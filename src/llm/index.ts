import { env } from '../config/env.js';
import type { Filters } from '../schema/filters.js';
import type { SearchResult } from '../engine/types.js';
import { LocalLlm } from './local.js';
import { AnthropicLlm } from './anthropic.js';

export interface Usage {
  tokens_in: number;
  tokens_out: number;
  cost_eur: number;
}

export interface ExtractionResult {
  filters: Filters;
  /** True when the model failed and we fell back to the rule-based parser. */
  degraded: boolean;
  /** Why we went degraded, for the log and the UI. */
  degradedReason: string | null;
  usage: Usage;
}

export interface LlmProvider {
  readonly name: string;
  /** Call 1: natural language -> filters validated against the strict schema. */
  extractFilters(message: string, defaultAppellation: string | null): Promise<ExtractionResult>;
  /** Call 2: returned rows -> text. See the type constraint below. */
  formulate(input: FormulationInput): Promise<{ text: string; usage: Usage }>;
}

/**
 * Input of call 2.
 *
 * This type is a BARRIER, not a convenience: it contains neither the user's
 * message nor the extracted descriptors. That is what defuses "decris-moi ce
 * vin comme une soiree d'ete" ("describe this wine like a summer evening"):
 * the requested register has no path to the formulation prompt. Do not add a
 * free-text field here without re-reading §7 of the brief (Loi Evin).
 */
export interface FormulationInput {
  readonly search: Omit<SearchResult, 'requestedFilters' | 'appliedFilters'> & {
    readonly appliedFilters: Readonly<Record<string, unknown>>;
  };
}

export function llmProvider(): LlmProvider {
  const name = env.llmProvider();
  switch (name) {
    case 'local':
      return new LocalLlm();
    case 'anthropic':
      return new AnthropicLlm(env.llmModel());
    default:
      throw new Error(`Unknown PSL_LLM_PROVIDER="${name}". Values: local, anthropic.`);
  }
}

export const ZERO_USAGE: Usage = Object.freeze({ tokens_in: 0, tokens_out: 0, cost_eur: 0 });
