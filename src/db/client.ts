import pg from 'pg';

const { Pool, types } = pg;

// numeric (OID 1700) arrives as a string by default, to preserve precision.
// Amounts here fit comfortably in a double: no need to carry strings all the
// way to the front end.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://psl:psl@127.0.0.1:5432/psl';

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
    pool.on('error', (e) => console.error('[pg] pool error', e.message));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Serializes an array of numbers into pgvector's vector literal format. */
export function toVector(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}

/** Parses a pgvector vector literal. */
export function fromVector(s: string | null): number[] | null {
  if (!s) return null;
  return s.slice(1, -1).split(',').map(Number);
}
