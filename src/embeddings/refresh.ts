import type pg from 'pg';
import { toVector } from '../db/client.js';
import { embedWithCache } from './cache.js';
import type { EmbeddingProvider } from './index.js';
import { recordSignature } from './signature.js';

export interface EmbeddingSummary {
  profiles: number;
  winesWithNote: number;
  winesOnAppellationProfile: number;
  signature: string;
}

/**
 * Computes and stores every vector of the catalog, then records the signature
 * of the configuration that produced them.
 *
 * Only wines carrying a producer note are embedded. The others keep a NULL
 * embedding and embedding_level='appellation': search will use the vector of
 * the AOC profile and say so. Concatenating the profile into every wine's
 * vector would make them collinear and flatten the ranking, which is exactly
 * the trap milestone 2 is about.
 */
export async function embedCatalog(
  pool: pg.Pool,
  provider: EmbeddingProvider,
): Promise<EmbeddingSummary> {
  // --- appellation profiles (APPELLATION level) -----------------------------
  const profiles = await pool.query<{ appellation_id: string; color: string; profile_text: string }>(
    'SELECT appellation_id, color, profile_text FROM appellation_profiles ORDER BY appellation_id, color',
  );
  if (profiles.rowCount) {
    const vectors = await embedWithCache(provider, profiles.rows.map((r) => r.profile_text));
    for (const [i, r] of profiles.rows.entries()) {
      await pool.query(
        'UPDATE appellation_profiles SET embedding = $1 WHERE appellation_id = $2 AND color = $3',
        [toVector(vectors[i]!), r.appellation_id, r.color],
      );
    }
  }

  // --- wines (WINE level only) -----------------------------------------------
  const wines = await pool.query<{ id: string; embedding_text: string }>(
    `SELECT id, embedding_text FROM wines
      WHERE embedding_level = 'wine' AND embedding_text IS NOT NULL
      ORDER BY id`,
  );
  if (wines.rowCount) {
    const vectors = await embedWithCache(provider, wines.rows.map((r) => r.embedding_text));
    for (const [i, r] of wines.rows.entries()) {
      await pool.query('UPDATE wines SET embedding = $1 WHERE id = $2', [toVector(vectors[i]!), r.id]);
    }
  }

  const withoutNote = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wines WHERE embedding_level = 'appellation'`,
  );

  return {
    profiles: profiles.rowCount ?? 0,
    winesWithNote: wines.rowCount ?? 0,
    winesOnAppellationProfile: withoutNote.rows[0]!.n,
    signature: await recordSignature(pool, provider),
  };
}
