import { beforeAll } from 'vitest';

// Tests run against the development database, fixtures included: without
// tasting notes there is nothing to rank and milestone 2 could not be tested.
// The cases that check the behavior WITHOUT fixtures do it explicitly, by
// passing allowFixtures: false to the engine.
process.env.PSL_ALLOW_FIXTURES = '1';
process.env.PSL_EMBEDDING_PROVIDER ??= 'local';
process.env.PSL_LLM_PROVIDER ??= 'local';
process.env.DATABASE_URL ??= 'postgres://psl:psl@127.0.0.1:5432/psl';

beforeAll(async () => {
  const { db } = await import('../src/db/client.js');
  try {
    await db().query('SELECT 1 FROM wines LIMIT 1');
  } catch {
    throw new Error(
      'database not initialized. Run: bash scripts/bootstrap-postgres-local.sh && npm run setup',
    );
  }

  // Editing src/config/lexicon.ts changes how notes are vectorized, but not
  // the vectors already stored. The engine detects the mismatch and then
  // refuses to rank by vector, which makes the ranking cases fail with a
  // misleading message. The local provider is deterministic, instantaneous and
  // offline: recomputing beats expecting the operator to think of it.
  const { embeddingProvider } = await import('../src/embeddings/index.js');
  const { checkSignature, recordSignature } = await import('../src/embeddings/signature.js');
  const provider = embeddingProvider();

  const status = await checkSignature(db(), provider);
  if (!status.upToDate) {
    if (!provider.deterministic) {
      throw new Error(
        `stale embeddings and provider "${provider.name}" bills per call: ` +
        `run "npm run db:embed" deliberately. Detail: ${status.message}`,
      );
    }
    const { toVector } = await import('../src/db/client.js');
    const wines = await db().query<{ id: string; embedding_text: string }>(
      `SELECT id, embedding_text FROM wines
        WHERE embedding_level = 'wine' AND embedding_text IS NOT NULL`,
    );
    const vectors = await provider.embed(wines.rows.map((r) => r.embedding_text));
    for (const [i, r] of wines.rows.entries()) {
      await db().query('UPDATE wines SET embedding = $1 WHERE id = $2', [toVector(vectors[i]!), r.id]);
    }
    const profiles = await db().query<{ appellation_id: string; color: string; profile_text: string }>(
      'SELECT appellation_id, color, profile_text FROM appellation_profiles',
    );
    const vp = await provider.embed(profiles.rows.map((r) => r.profile_text));
    for (const [i, r] of profiles.rows.entries()) {
      await db().query(
        'UPDATE appellation_profiles SET embedding = $1 WHERE appellation_id = $2 AND color = $3',
        [toVector(vp[i]!), r.appellation_id, r.color],
      );
    }
    await recordSignature(db(), provider);
  }
});
