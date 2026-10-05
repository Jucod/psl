import { db, closeDb, toVector } from '../db/client.js';
import { config } from '../config/domain.js';
import { embeddingProvider } from '../embeddings/index.js';
import { embedWithCache } from '../embeddings/cache.js';
import { recordSignature } from '../embeddings/signature.js';

const pool = db();
const provider = embeddingProvider();
console.log(`embeddings: provider "${provider.name}", ${config.embeddingDimension} dims`);

// --- appellation profiles (APPELLATION level) -------------------------------
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
console.log(`  appellation profiles      : ${profiles.rowCount}`);

// --- wines (WINE level only) -------------------------------------------------
// Only wines carrying a producer note are embedded. The others keep a NULL
// embedding and embedding_level='appellation': search will use the vector of
// the AOC profile and say so. Concatenating the profile into every wine's
// vector would make them collinear and flatten the ranking, which is exactly
// the trap milestone 2 is about.
const wines = await pool.query<{ id: string; embedding_text: string }>(
  `SELECT id, embedding_text FROM wines
    WHERE embedding_level = 'wine' AND embedding_text IS NOT NULL
    ORDER BY id`,
);
if (wines.rowCount) {
  const vectors = await embedWithCache(provider, wines.rows.map((r) => r.embedding_text));
  for (const [i, r] of wines.rows.entries()) {
    await pool.query('UPDATE wines SET embedding = $1 WHERE id = $2', [
      toVector(vectors[i]!), r.id,
    ]);
  }
}

const withoutNote = await pool.query<{ n: string }>(
  `SELECT count(*)::text AS n FROM wines WHERE embedding_level = 'appellation'`,
);
console.log(`  wines with a note         : ${wines.rowCount}`);
console.log(`  wines on the AOC profile  : ${withoutNote.rows[0]!.n}`);

const signature = await recordSignature(pool, provider);
console.log(`  signature                 : ${signature}`);

await closeDb();
