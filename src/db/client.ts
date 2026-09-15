import pg from 'pg';

const { Pool, types } = pg;

// numeric (OID 1700) arrive en string par defaut pour preserver la precision.
// Ici les montants tiennent largement dans un double: on evite de trimballer
// des strings jusqu'au front.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://psl:psl@127.0.0.1:5432/psl';

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
    pool.on('error', (e) => console.error('[pg] erreur pool', e.message));
  }
  return pool;
}

export async function fermer(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Serialise un tableau de nombres au format litteral vector de pgvector. */
export function versVecteur(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}

/** Parse un litteral vector pgvector. */
export function depuisVecteur(s: string | null): number[] | null {
  if (!s) return null;
  return s.slice(1, -1).split(',').map(Number);
}
