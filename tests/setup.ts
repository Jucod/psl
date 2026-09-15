import { beforeAll } from 'vitest';

// Les tests tournent sur la base de developpement, fixtures comprises: sans
// notes de degustation, il n'y a rien a classer et le jalon 2 ne serait pas
// testable. Les cas qui verifient le comportement SANS fixture le font
// explicitement, en passant autoriserFixtures: false au moteur.
process.env.PSL_AUTORISER_FIXTURES = '1';
process.env.PSL_EMBEDDING_PROVIDER ??= 'local';
process.env.PSL_LLM_PROVIDER ??= 'local';
process.env.DATABASE_URL ??= 'postgres://psl:psl@127.0.0.1:5432/psl';

beforeAll(async () => {
  const { db } = await import('../src/db/client.js');
  try {
    await db().query('SELECT 1 FROM cuvees LIMIT 1');
  } catch {
    throw new Error(
      'base non initialisee. Lance: bash scripts/bootstrap-postgres-local.sh && npm run setup',
    );
  }
});
