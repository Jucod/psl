export interface Source {
  id: string;
  type: string;
  label: string;
  url: string;
  authority: string | null;
  retrieved_on: string;
}

export interface WineResult {
  id: string;
  name: string;
  producer: string;
  commune: string | null;
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
  tasting_note: string | null;
  note_truncated: boolean;
  note_source: Source | null;
  producer_pairings: string[];
  level: 'wine' | 'appellation';
  appellation_profile: { text: string; source: Source; section: string | null } | null;
  score: number;
  fixture: boolean;
  relevant_excerpt: string | null;
}

export interface Filters {
  appellation: string | null;
  color: string | null;
  price_min: number | null;
  price_max: number | null;
  vintage_min: number | null;
  vintage_max: number | null;
  organic: boolean | null;
  grapes_included: string[];
  grapes_excluded: string[];
  dish: string | null;
  descriptors: string[];
  descriptors_excluded: string[];
}

export interface Search {
  status: 'ok' | 'refused' | 'empty';
  refusal: { message: string; source: Source | null } | null;
  requestedFilters: Filters;
  appliedFilters: Filters;
  relaxations: { field: string; label: string; announcement: string }[];
  ranking: 'vector' | 'lexicographic';
  results: WineResult[];
  dishPairings: { label: string; category: string; status: string; derived_from: string }[];
  catalogSize: number;
  undecidableFilters: { field: string; label: string }[];
}

export interface SearchResponse {
  status: string;
  text: string;
  degraded?: boolean;
  degraded_reason?: string | null;
  fixtures_enabled?: boolean;
  latency_ms?: number;
  search: Search | null;
}

/** French display labels of the codes, served by the API. */
export interface Labels {
  colors: Record<string, string>;
  descriptors: Record<string, string>;
  dishes: Record<string, string>;
}

export interface Catalog {
  appellations: { id: string; name: string; source_label: string; source_url: string }[];
  colors: string[];
  grapes: { code: string; label: string }[];
  bounds: { price_min: number | null; price_max: number | null; vintage_min: number | null; vintage_max: number | null };
  fields: { key: string; label: string; operator: string }[];
  relaxation_order: string[];
  labels: Labels;
}

/** Label of a code, falling back to the code itself while the catalog loads. */
export function labelOf(map: Record<string, string> | undefined, code: string): string {
  return map?.[code] ?? code;
}
