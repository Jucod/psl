import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { EmbeddingProvider } from './index.js';

const CACHE_PATH = fileURLToPath(new URL('../../db/seed/embeddings.cache.json', import.meta.url));

type Cache = Record<string, number[]>;

function cacheKey(provider: string, dimension: number, text: string): string {
  return createHash('sha256').update(`${provider}:${dimension}:${text}`).digest('hex');
}

async function readCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/**
 * Embeds through a committed cache, so that `npm run setup` is reproducible
 * and can run in CI without an API key.
 *
 * The local provider is NOT cached: it is deterministic and instantaneous, and
 * a cache would make it insensitive to a change in the lexicon, which is
 * exactly the trap (we would fix the lexicon and the ranking would not move).
 */
export async function embedWithCache(
  provider: EmbeddingProvider,
  texts: readonly string[],
): Promise<number[][]> {
  if (provider.deterministic) return provider.embed(texts);

  const cache = await readCache();
  const missing: string[] = [];
  for (const t of texts) {
    if (!(cacheKey(provider.name, provider.dimension, t) in cache)) missing.push(t);
  }

  if (missing.length > 0) {
    const fresh = await provider.embed(missing);
    missing.forEach((t, i) => {
      cache[cacheKey(provider.name, provider.dimension, t)] = fresh[i]!;
    });
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 0) + '\n', 'utf8');
  }

  const reread = await readCache();
  return texts.map((t) => reread[cacheKey(provider.name, provider.dimension, t)]!);
}
