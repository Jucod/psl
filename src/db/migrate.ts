import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './client.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/**
 * Migrations >= 900 are not applied by default: they are operations whose
 * relevance depends on the data volume (vector index).
 */
const OPTIONAL_THRESHOLD = 900;

export interface MigrateOptions {
  readonly withVectorIndex?: boolean;
  readonly reset?: boolean;
}

export async function migrate(opts: MigrateOptions = {}): Promise<string[]> {
  const pool = db();

  if (opts.reset) {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  for (const file of files) {
    if (alreadyApplied.has(file)) continue;

    const number = Number(file.slice(0, 3));
    if (number >= OPTIONAL_THRESHOLD && !opts.withVectorIndex) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file}: ${(e as Error).message}`, { cause: e });
    } finally {
      client.release();
    }
  }

  return applied;
}
