import { excerpt } from '../llm/local.js';
import type { SearchResult, WineResult } from '../engine/types.js';

/**
 * Projection sent to the browser.
 *
 * "Technical sheets are public but remain the estate's property: we quote, we
 * do not republish." The producer's note is therefore sent truncated, with a
 * link to the original page. It is an editorial decision, applied here at the
 * HTTP boundary: the engine itself works on the full note.
 */
const QUOTE_LENGTH = 220;

export interface PublicResult extends Omit<WineResult, 'tasting_note'> {
  tasting_note: string | null;
  note_truncated: boolean;
}

export function toPublic(r: SearchResult): Omit<SearchResult, 'results'> & {
  results: PublicResult[];
} {
  return {
    ...r,
    results: r.results.map((w) => ({
      ...w,
      tasting_note: w.tasting_note ? excerpt(w.tasting_note, QUOTE_LENGTH) : null,
      note_truncated: w.tasting_note !== null && w.tasting_note.length > QUOTE_LENGTH,
    })),
    // Operational warnings (stale vectors, etc.) do not concern the visitor:
    // they stay in the server logs.
    warnings: [],
  };
}
