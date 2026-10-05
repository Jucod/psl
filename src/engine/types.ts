import type { Filters } from '../schema/filters.js';

export interface CitedSource {
  id: string;
  type: string;
  label: string;
  url: string;
  authority: string | null;
  retrieved_on: string;
}

export interface DerivedPairing {
  label: string;
  category: string;
  status: 'derived';
  derived_from: string;
}

export interface WineResult {
  id: string;
  name: string;
  producer: string;
  producer_id: string;
  commune: string | null;
  appellation_id: string;
  color: string;
  vintage: number | null;
  abv: number | null;
  aging: string | null;
  price_eur: number | null;
  price_as_of: string | null;
  organic: boolean | null;
  certification: string | null;
  blend: { grape: string; pct: number | null }[];
  page_url: string | null;

  /**
   * The producer's note, copied verbatim. null when no technical sheet is
   * indexed: in that case `level` is 'appellation' and `appellation_profile`
   * carries the fallback, announced as such.
   */
  tasting_note: string | null;
  note_source: CitedSource | null;
  producer_pairings: string[];

  /** 'wine' = the ranking relies on the producer's note.
   *  'appellation' = fallback on the AOC profile, to be announced. */
  level: 'wine' | 'appellation';
  appellation_profile: {
    text: string;
    source: CitedSource;
    section: string | null;
  } | null;

  score: number;
  /** True when the row carries fields from a development fixture. */
  fixture: boolean;
  /**
   * The sentence of the producer's note closest to the request. Selected,
   * never rewritten. null when nothing matches or when the request has no
   * fuzzy part.
   */
  relevant_excerpt: string | null;
}

export interface Relaxation {
  field: string;
  label: string;
  announcement: string;
}

export type SearchStatus = 'ok' | 'refused' | 'empty';

export interface SearchResult {
  status: SearchStatus;
  /** Set when status = 'refused'. */
  refusal: { message: string; source: CitedSource | null } | null;
  requestedFilters: Filters;
  appliedFilters: Filters;
  /** Never non-empty without the user being told. */
  relaxations: Relaxation[];
  ranking: 'vector' | 'lexicographic';
  results: WineResult[];
  /** Appellation pairings matching the requested dish. Always DERIVED. */
  dishPairings: DerivedPairing[];
  /** Number of wines in the catalog for the targeted appellation and color. */
  catalogSize: number;
  /** Operational problems to surface to the operator, not to the user. */
  warnings: string[];
  /**
   * Filters bearing on a piece of data the catalog knows for NONE of the
   * candidate wines. "No wine under 20 €" and "I have no price for any wine"
   * are two different answers, and mistaking the second for the first is
   * precisely the unfounded statement this project refuses to make.
   */
  undecidableFilters: { field: string; label: string }[];
}
