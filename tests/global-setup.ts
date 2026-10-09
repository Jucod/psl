import pg from 'pg';
import { databaseName, testDatabaseUrl } from './test-database.js';

/**
 * Provisions the test database once per run: create if missing, reset,
 * migrate, seed WITH the development fixtures, embed with the local provider.
 *
 * Fixtures are needed: the ranking and masking cases are about the overlay.
 * The cases that check the behavior WITHOUT fixtures pass allowFixtures: false
 * to the engine explicitly.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const name = databaseName(url);

  // The reset below drops the whole public schema. Refuse anything that does
  // not look like a throwaway database, whatever the configuration says.
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to reset "${name}": the test database name must end with _test`);
  }

  process.env.DATABASE_URL = url;
  process.env.PSL_EMBEDDING_PROVIDER = 'local';

  const { db, closeDb } = await import('../src/db/client.js');
  const { migrate } = await import('../src/db/migrate.js');
  const { ingestReference } = await import('../src/ingest/reference.js');
  const { ingestWines } = await import('../src/ingest/wines.js');
  const { embeddingProvider } = await import('../src/embeddings/index.js');
  const { embedCatalog } = await import('../src/embeddings/refresh.js');

  try {
    await createIfMissing(url, name);
    await migrate({ reset: true });
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await ingestReference(client);
      await ingestWines(client, true);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await embedCatalog(db(), embeddingProvider());
  } catch (e) {
    const unreachable = (e as { code?: string }).code === 'ECONNREFUSED';
    throw new Error(
      `could not prepare the test database "${name}": ${(e as Error).message}` +
      (unreachable ? '\nIs Postgres running? (docker compose up -d, or bash scripts/bootstrap-postgres-local.sh)' : ''),
      { cause: e },
    );
  } finally {
    await closeDb();
  }
}

async function createIfMissing(url: string, name: string): Promise<void> {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}
