import type { Catalog, Filters, SearchResponse } from './types.ts';

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok && !body.status) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body as T;
}

export async function loadCatalog(): Promise<Catalog> {
  return json<Catalog>(await fetch('/api/catalog'));
}

/**
 * Non-null `filters` bypass LLM call 1: that is the path taken when the user
 * corrects the filters by hand. The original request is still sent for the
 * log, but it is no longer interpreted.
 */
export async function search(message: string, filters?: Filters): Promise<SearchResponse> {
  return json<SearchResponse>(
    await fetch('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(filters ? { message, filters } : { message }),
    }),
  );
}
