import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import type { EmbeddingProvider } from './index.js';

const LEXICON_PATH = fileURLToPath(new URL('../config/lexicon.ts', import.meta.url));

/**
 * Fingerprint of everything that influences the value of a vector: the
 * provider, the dimension, and the lexicon (which drives the local provider's
 * expansion into families). If any of the three moves, the stored vectors are
 * no longer comparable to a query vector computed now.
 */
export async function embeddingSignature(p: EmbeddingProvider): Promise<string> {
  const lexicon = await readFile(LEXICON_PATH, 'utf8');
  return createHash('sha256')
    .update(`${p.name}:${p.dimension}:`)
    .update(createHash('sha256').update(lexicon).digest('hex'))
    .digest('hex')
    .slice(0, 32);
}

export async function recordSignature(
  client: pg.Pool | pg.PoolClient,
  p: EmbeddingProvider,
): Promise<string> {
  const signature = await embeddingSignature(p);
  await client.query(
    `INSERT INTO embedding_state (key, signature, provider, dimension, computed_at)
     VALUES ('wines', $1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET
       signature = EXCLUDED.signature, provider = EXCLUDED.provider,
       dimension = EXCLUDED.dimension, computed_at = now()`,
    [signature, p.name, p.dimension],
  );
  return signature;
}

export interface EmbeddingStatus {
  upToDate: boolean;
  message: string | null;
}

/**
 * Checks that the stored vectors were computed with the current
 * configuration. On a mismatch, the engine refuses to rank by vector rather
 * than produce a wrong order that looks fine.
 */
export async function checkSignature(
  client: pg.Pool | pg.PoolClient,
  p: EmbeddingProvider,
): Promise<EmbeddingStatus> {
  const expected = await embeddingSignature(p);
  const { rows } = await client.query<{ signature: string; provider: string; computed_at: Date }>(
    `SELECT signature, provider, computed_at FROM embedding_state WHERE key = 'wines'`,
  );

  if (rows.length === 0) {
    return { upToDate: false, message: 'no embedding computed yet. Run: npm run db:embed' };
  }
  if (rows[0]!.signature !== expected) {
    return {
      upToDate: false,
      message:
        `the vectors in the database date from ${rows[0]!.computed_at.toISOString().slice(0, 16)} ` +
        `and were computed with another configuration (provider or lexicon changed). ` +
        `Vector ranking disabled. Run again: npm run db:embed`,
    };
  }
  return { upToDate: true, message: null };
}
