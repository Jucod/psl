import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './client.js';

const DOSSIER = new URL('../../db/migrations/', import.meta.url).pathname;

/**
 * Les migrations >= 900 ne sont pas appliquees par defaut: ce sont des
 * operations dont l'opportunite depend du volume de donnees (index vectoriel).
 */
const SEUIL_OPTIONNEL = 900;

export interface OptionsMigration {
  readonly avecIndexVectoriel?: boolean;
  readonly reset?: boolean;
}

export async function migrer(opts: OptionsMigration = {}): Promise<string[]> {
  const pool = db();

  if (opts.reset) {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nom        text PRIMARY KEY,
      applique_le timestamptz NOT NULL DEFAULT now()
    )
  `);

  const fichiers = (await readdir(DOSSIER))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ nom: string }>('SELECT nom FROM schema_migrations');
  const deja = new Set(rows.map((r) => r.nom));

  const appliquees: string[] = [];
  for (const fichier of fichiers) {
    if (deja.has(fichier)) continue;

    const numero = Number(fichier.slice(0, 3));
    if (numero >= SEUIL_OPTIONNEL && !opts.avecIndexVectoriel) continue;

    const sql = await readFile(join(DOSSIER, fichier), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (nom) VALUES ($1)', [fichier]);
      await client.query('COMMIT');
      appliquees.push(fichier);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${fichier}: ${(e as Error).message}`, { cause: e });
    } finally {
      client.release();
    }
  }

  return appliquees;
}
